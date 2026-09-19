#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import http from "node:http";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGeminiTransport } from "../shorts/gemini-transport.js";
import { PLATFORMS, PublishError, TokenStore } from "../publish/common.js";
import type { Platform, Privacy } from "../publish/common.js";
import { buildMetadata, loadMetadataPlan } from "../publish/metadata.js";
import type { VideoMetadata } from "../publish/metadata.js";
import { Publisher } from "../publish/publisher.js";
import type { PublishRecord } from "../publish/publisher.js";

// Local web UI for the music-video pipeline: one topic in, one rendered video out.
// Runs strictly on localhost — it drives a real logged-in Chrome via Playwright and
// spends real Gemini/Lyria/Flow credit per run, so it must never be exposed off-box.

const MODULE_FILE = fileURLToPath(import.meta.url);
const __dirname = dirname(MODULE_FILE);

// Static assets and the CLI entry point ship inside the package; everything the user creates
// (.env, tokens, browser profile, generated videos) lives in the directory they launch from,
// matching where the gflow CLI itself keeps .gflow/.
function findPackageRoot(start: string): string {
  let current = start;
  while (!existsSync(join(current, "package.json"))) {
    const parent = dirname(current);
    if (parent === current) throw new Error("Không tìm thấy package.json của tool");
    current = parent;
  }
  return current;
}

const PACKAGE_ROOT = findPackageRoot(__dirname);
const WORK_DIR = process.cwd();
const PUBLIC_DIR = join(PACKAGE_ROOT, "public");
const OUTPUT_ROOT = resolve(WORK_DIR, "music-output");
const RUNNING_COMPILED = extname(MODULE_FILE) === ".js";

// Compiled builds run the built CLI with the current Node; source checkouts use tsx.
function cliCommand(cliArgs: string[]): { command: string; args: string[] } {
  return RUNNING_COMPILED
    ? { command: process.execPath, args: [join(PACKAGE_ROOT, "dist", "src", "index.js"), ...cliArgs] }
    : { command: "npx", args: ["tsx", join(PACKAGE_ROOT, "src", "index.ts"), ...cliArgs] };
}

try {
  process.loadEnvFile(resolve(WORK_DIR, ".env"));
} catch {
  // No .env file: GEMINI_API_KEY and the publishing credentials may come from the real environment.
}
const PORT = Number(process.env.PORT ?? 4173);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const PROJECT_ID_PATTERN = /^[a-z0-9-]{1,60}$/;

const publisher = new Publisher({
  tokens: new TokenStore(resolve(WORK_DIR, ".gflow", "publish-tokens.json")),
  env: process.env
});

const MIN_DURATION = 30;
const MAX_DURATION = 240;
const DEFAULT_DURATION = 75;

interface RunState {
  id: string;
  topic: string;
  duration: number;
  outDir: string;
  status: "running" | "ready" | "failed";
  stage?: string;
  message?: string;
  log: string[];
  startedAt: number;
  finishedAt?: number;
  listeners: Set<http.ServerResponse>;
  poller?: NodeJS.Timeout;
}

const runs = new Map<string, RunState>();
// Project id -> platforms with an upload in flight, so the list can show "đang đăng" and a second click can't double-post.
const publishing = new Map<string, Platform[]>();

function slugify(topic: string): string {
  const ascii = topic
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii.length > 0 ? ascii.slice(0, 60) : "chu-de";
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function lastEventMessage(eventsPath: string): Promise<{ stage?: string; message?: string }> {
  try {
    const raw = await readFile(eventsPath, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    const last = lines.at(-1);
    if (!last) return {};
    const parsed = JSON.parse(last) as { stage?: string; message?: string };
    return { stage: parsed.stage, message: parsed.message };
  } catch {
    return {};
  }
}

const STAGE_LABELS: Record<string, string> = {
  SONG_PLANNED: "Đã lập kế hoạch bài hát",
  SONG_READY: "Đã tạo xong nhạc",
  STORYBOARDED: "Đã dựng storyboard hình ảnh",
  ASSETS_GENERATING: "Đang tạo hình ảnh và video qua Flow",
  ASSETS_READY: "Đã tạo xong toàn bộ hình ảnh/video",
  RENDERING: "Đang dựng video cuối (FFmpeg)",
  READY: "Hoàn tất",
  FAILED: "Thất bại",
  CANCELLED: "Đã huỷ",
  PAUSED: "Tạm dừng, cần xử lý tay"
};

function broadcast(run: RunState): void {
  const payload = JSON.stringify({
    status: run.status,
    stage: run.stage,
    stageLabel: run.stage ? STAGE_LABELS[run.stage] ?? run.stage : undefined,
    message: run.message,
    log: run.log.slice(-30)
  });
  for (const res of run.listeners) {
    res.write(`data: ${payload}\n\n`);
  }
}

// On --resume, project.json still holds the previous attempt's terminal stage
// (FAILED/CANCELLED/PAUSED) until the child process gets far enough to overwrite it.
// Ignore that leftover value while the process is still running so the UI doesn't
// flash a false failure for a run that is actually progressing normally.
const STALE_TERMINAL_STAGES = new Set(["FAILED", "CANCELLED", "PAUSED"]);

async function pollProgress(run: RunState): Promise<void> {
  const projectJson = await readJsonIfExists(join(run.outDir, "project.json"));
  const events = await lastEventMessage(join(run.outDir, "logs", "events.jsonl"));
  let stage = (projectJson?.stage as string | undefined) ?? events.stage;
  if (run.status === "running" && stage && STALE_TERMINAL_STAGES.has(stage)) stage = undefined;
  if (stage && stage !== run.stage) {
    run.stage = stage;
    run.message = events.message;
    broadcast(run);
  }
}

function startRun(topic: string, duration: number, resumeIfExists: boolean, outDir: string, id: string): RunState {
  const run: RunState = {
    id,
    topic,
    duration,
    outDir,
    status: "running",
    log: [],
    startedAt: Date.now(),
    listeners: new Set()
  };
  runs.set(id, run);

  const args = [
    "music-video",
    "run",
    "--topic",
    topic,
    "--duration",
    String(duration),
    "--out",
    outDir,
    "--language",
    "vi-VN"
  ];
  if (resumeIfExists) args.push("--resume");

  const cli = cliCommand(args);
  const child = spawn(cli.command, cli.args, { cwd: WORK_DIR, env: childEnvironment() });
  const appendLog = (chunk: Buffer): void => {
    const text = chunk.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().length === 0) continue;
      run.log.push(line);
    }
    broadcast(run);
  };
  child.stdout.on("data", appendLog);
  child.stderr.on("data", appendLog);

  run.poller = setInterval(() => {
    pollProgress(run).catch(() => undefined);
  }, 1500);

  child.on("exit", async (code) => {
    if (run.poller) clearInterval(run.poller);
    await pollProgress(run).catch(() => undefined);
    const projectJson = await readJsonIfExists(join(run.outDir, "project.json"));
    const finalStage = (projectJson?.stage as string | undefined) ?? run.stage;
    run.finishedAt = Date.now();
    if (code === 0 && finalStage === "READY") {
      run.status = "ready";
    } else {
      run.status = "failed";
      run.stage = finalStage ?? run.stage;
      if (!run.message) run.message = `Tiến trình kết thúc với mã ${code}`;
    }
    broadcast(run);
    for (const res of run.listeners) res.end();
    run.listeners.clear();
  });

  return run;
}

type SlotState = "published" | "failed" | "none" | "publishing";

interface PlatformSlot {
  platform: Platform;
  state: SlotState;
  privacy?: string;
  requestedPrivacy?: string;
  at?: string;
  url?: string;
  error?: string;
  /** final.mp4 was re-rendered after the recorded post, so the live post is an older version. */
  videoChanged?: boolean;
}

interface PastRun {
  id: string;
  topic: string;
  stage: string;
  updatedAt: string;
  hasVideo: boolean;
  slots: PlatformSlot[];
}

// One slot per platform, always present, so the UI can show "not posted yet" as clearly as "posted".
async function platformSlots(id: string, dir: string, videoMtimeMs: number | undefined): Promise<PlatformSlot[]> {
  const history = await publisher.history(dir).catch(() => [] as PublishRecord[]);
  const uploading = publishing.get(id) ?? [];
  return PLATFORMS.map((platform): PlatformSlot => {
    if (uploading.includes(platform)) return { platform, state: "publishing" };
    const records = history.filter((record) => record.platform === platform);
    const published = records.filter((record) => record.status === "published").at(-1);
    const chosen = published ?? records.at(-1);
    if (!chosen) return { platform, state: "none" };
    const postedAt = Date.parse(chosen.at);
    return {
      platform,
      state: chosen.status,
      privacy: chosen.privacy,
      requestedPrivacy: chosen.requestedPrivacy,
      at: chosen.at,
      url: chosen.url,
      error: chosen.error,
      videoChanged: chosen.status === "published" && videoMtimeMs !== undefined && Number.isFinite(postedAt) && videoMtimeMs > postedAt + 5000
    };
  });
}

async function listPastRuns(): Promise<PastRun[]> {
  const results: PastRun[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(OUTPUT_ROOT);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const dir = join(OUTPUT_ROOT, entry);
    const info = await stat(dir).catch(() => undefined);
    if (!info?.isDirectory()) continue;
    const projectJson = await readJsonIfExists(join(dir, "project.json"));
    if (!projectJson) continue;
    const video = await stat(join(dir, "output", "final.mp4")).catch(() => undefined);
    results.push({
      id: entry,
      topic: String(projectJson.topic ?? entry),
      stage: String(projectJson.stage ?? "UNKNOWN"),
      updatedAt: String(projectJson.updatedAt ?? ""),
      hasVideo: video !== undefined,
      slots: await platformSlots(entry, dir, video?.mtimeMs)
    });
  }
  results.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return results;
}

function checkFlowLogin(): Promise<{ ready: boolean; message: string }> {
  return new Promise((resolvePromise) => {
    const cli = cliCommand(["doctor"]);
    const child = spawn(cli.command, cli.args, { cwd: WORK_DIR, env: childEnvironment() });
    let out = "";
    child.stdout.on("data", (c) => (out += c.toString("utf8")));
    child.stderr.on("data", (c) => (out += c.toString("utf8")));
    child.on("exit", (code) => {
      resolvePromise({ ready: code === 0, message: out.trim() });
    });
    child.on("error", () => resolvePromise({ ready: false, message: "Không chạy được lệnh doctor" }));
  });
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

async function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<boolean> {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (rel.includes("..")) return false;
  const filePath = join(PUBLIC_DIR, rel);
  const ext = extname(filePath);
  const contentType = STATIC_TYPES[ext];
  if (!contentType) return false;
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "content-type": contentType });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

async function serveVideo(req: http.IncomingMessage, res: http.ServerResponse, videoPath: string): Promise<void> {
  const info = await stat(videoPath).catch(() => undefined);
  if (!info) {
    sendJson(res, 404, { error: "Video chưa sẵn sàng" });
    return;
  }
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, { "content-type": "video/mp4", "content-length": info.size, "accept-ranges": "bytes" });
    createReadStream(videoPath).pipe(res);
    return;
  }
  const match = /bytes=(\d*)-(\d*)/.exec(range);
  const start = match?.[1] ? Number(match[1]) : 0;
  const end = match?.[2] ? Number(match[2]) : info.size - 1;
  res.writeHead(206, {
    "content-type": "video/mp4",
    "content-range": `bytes ${start}-${end}/${info.size}`,
    "accept-ranges": "bytes",
    "content-length": end - start + 1
  });
  createReadStream(videoPath, { start, end }).pipe(res);
}

const MAX_BODY_BYTES = 1024 * 1024;

async function readRequestBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new PublishError("Nội dung gửi lên quá lớn", "BODY_TOO_LARGE");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length > 0 ? JSON.parse(text) : {};
}

// Publishing secrets are only for this server process; the generation CLI never needs them.
function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"]) delete env[name];
  return env;
}

function parsePlatform(value: unknown): Platform {
  if (typeof value === "string" && (PLATFORMS as readonly string[]).includes(value)) return value as Platform;
  throw new PublishError("Nền tảng không hợp lệ", "BAD_REQUEST");
}

function parseProjectId(value: unknown): string {
  if (typeof value === "string" && PROJECT_ID_PATTERN.test(value)) return value;
  throw new PublishError("Mã dự án không hợp lệ", "BAD_REQUEST");
}

function parseMetadata(value: unknown): VideoMetadata {
  const input = (value ?? {}) as { title?: unknown; description?: unknown; tags?: unknown };
  const title = typeof input.title === "string" ? input.title.trim() : "";
  const description = typeof input.description === "string" ? input.description : "";
  const tags = Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter((tag) => tag.length > 0) : [];
  if (title.length === 0 || title.length > 100) throw new PublishError("Tiêu đề phải từ 1 đến 100 ký tự", "BAD_REQUEST");
  if (description.length > 5000) throw new PublishError("Mô tả tối đa 5000 ký tự", "BAD_REQUEST");
  if (tags.length > 15 || tags.some((tag) => tag.length > 50)) throw new PublishError("Tối đa 15 thẻ, mỗi thẻ tối đa 50 ký tự", "BAD_REQUEST");
  return { title, description, tags };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch);
}

function sendHtml(res: http.ServerResponse, status: number, message: string): void {
  const body = `<!doctype html><meta charset="utf-8"><title>Kết nối tài khoản</title><body style="font-family:sans-serif;padding:2rem;background:#0f1115;color:#e8eaf0"><p>${escapeHtml(message)}</p>`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer" });
  res.end(body);
}

async function publishRoutes(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const { pathname } = url;

  if (req.method === "GET" && pathname === "/api/publish/status") {
    sendJson(res, 200, {
      ...(await publisher.status()),
      redirectUris: { youtube: `${ORIGIN}/oauth/youtube/callback`, tiktok: `${ORIGIN}/oauth/tiktok/callback/` }
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/publish/connect") {
    const body = (await readRequestBody(req)) as { platform?: unknown };
    sendJson(res, 200, { url: publisher.beginAuth(parsePlatform(body.platform), ORIGIN) });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/publish/disconnect") {
    const body = (await readRequestBody(req)) as { platform?: unknown };
    await publisher.disconnect(parsePlatform(body.platform));
    sendJson(res, 200, { ok: true });
    return true;
  }

  const callback = /^\/oauth\/(youtube|tiktok)\/callback\/?$/.exec(pathname);
  if (req.method === "GET" && callback) {
    const platform = callback[1] as Platform;
    const providerError = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (providerError || !code || !state) {
      sendHtml(res, 400, "Kết nối bị huỷ hoặc thất bại. Quay lại tool và thử lại.");
      return true;
    }
    try {
      await publisher.completeAuth(platform, state, code);
      sendHtml(res, 200, `Đã kết nối ${platform === "youtube" ? "YouTube" : "TikTok"}. Bạn có thể đóng tab này và quay lại tool.`);
    } catch (error) {
      sendHtml(res, 400, error instanceof PublishError ? error.message : "Không kết nối được tài khoản");
    }
    return true;
  }

  if (req.method === "GET" && pathname === "/api/publish/metadata") {
    const id = parseProjectId(url.searchParams.get("id"));
    const root = join(OUTPUT_ROOT, id);
    const plan = await loadMetadataPlan(root).catch(() => {
      throw new PublishError("Không đọc được kế hoạch bài hát của dự án này", "NO_PLAN");
    });
    const apiKey = process.env.GEMINI_API_KEY;
    const metadata = await buildMetadata(plan, apiKey ? { transport: new GoogleGeminiTransport({ apiKey }) } : {});
    sendJson(res, 200, { metadata, history: await publisher.history(root) });
    return true;
  }

  if (req.method === "GET" && pathname === "/api/publish/history") {
    const id = parseProjectId(url.searchParams.get("id"));
    sendJson(res, 200, { history: await publisher.history(join(OUTPUT_ROOT, id)) });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/publish") {
    const body = (await readRequestBody(req)) as {
      id?: unknown; platforms?: unknown; privacy?: unknown; metadata?: unknown; madeForKids?: unknown; force?: unknown;
    };
    const id = parseProjectId(body.id);
    const platforms = Array.isArray(body.platforms) ? body.platforms.map(parsePlatform) : [];
    const privacy = body.privacy;
    if (privacy !== "private" && privacy !== "unlisted" && privacy !== "public") throw new PublishError("Chế độ hiển thị không hợp lệ", "BAD_REQUEST");
    const root = join(OUTPUT_ROOT, id);
    const plan = await loadMetadataPlan(root).catch(() => undefined);
    const metadata = parseMetadata(body.metadata);
    // A second click while an upload is running would otherwise post the same video twice.
    if (publishing.has(id)) throw new PublishError("Video này đang được đăng, vui lòng chờ", "BAD_REQUEST");
    const already = await publisher.history(root);
    publishing.set(id, platforms.filter((platform) => body.force === true || !already.some((record) => record.platform === platform && record.status === "published")));
    try {
      const results = await publisher.publish({
        projectRoot: root,
        platforms,
        privacy: privacy as Privacy,
        metadata,
        madeForKids: body.madeForKids === true,
        language: plan?.language ?? "vi-VN",
        force: body.force === true
      });
      sendJson(res, 200, { results });
    } finally {
      publishing.delete(id);
    }
    return true;
  }

  return false;
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error: unknown) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (error instanceof PublishError) {
      const clientError = ["BAD_REQUEST", "NOT_CONFIGURED", "NOT_CONNECTED", "NO_VIDEO", "NO_PLATFORM", "NO_PLAN", "BODY_TOO_LARGE"].includes(error.code);
      sendJson(res, clientError ? 400 : 502, { error: error.message, code: error.code });
      return;
    }
    if (error instanceof SyntaxError) {
      sendJson(res, 400, { error: "JSON không hợp lệ" });
      return;
    }
    sendJson(res, 500, { error: error instanceof Error ? error.message : "Lỗi không xác định" });
  });
});

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // This server can post to real social accounts and spend API credit, so refuse DNS-rebinding
  // (unexpected Host) and cross-site form/fetch requests (foreign Origin or non-JSON bodies).
  if (!ALLOWED_HOSTS.has(req.headers.host ?? "")) {
    sendJson(res, 403, { error: "Host không hợp lệ" });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.origin;
    const contentType = req.headers["content-type"] ?? "";
    if ((origin !== undefined && !ALLOWED_ORIGINS.has(origin)) || !contentType.startsWith("application/json")) {
      sendJson(res, 403, { error: "Yêu cầu không hợp lệ" });
      return;
    }
  }

  if (await publishRoutes(req, res, url)) return;

  if (req.method === "GET" && pathname === "/api/doctor") {
    sendJson(res, 200, await checkFlowLogin());
    return;
  }

  if (req.method === "GET" && pathname === "/api/runs") {
    sendJson(res, 200, { runs: await listPastRuns() });
    return;
  }

  if (req.method === "POST" && pathname === "/api/runs") {
    const body = (await readRequestBody(req)) as { topic?: string; duration?: number };
    const topic = String(body.topic ?? "").trim();
    if (topic.length < 3 || topic.length > 300) {
      sendJson(res, 400, { error: "Chủ đề phải từ 3 đến 300 ký tự" });
      return;
    }
    const duration = Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(body.duration ?? DEFAULT_DURATION)));
    const id = slugify(topic);
    const outDir = join(OUTPUT_ROOT, id);

    const existingRun = runs.get(id);
    if (existingRun && existingRun.status === "running") {
      sendJson(res, 200, { id, alreadyRunning: true });
      return;
    }

    const existingProject = await readJsonIfExists(join(outDir, "project.json"));
    if (existingProject?.stage === "READY") {
      const hasVideo = await stat(join(outDir, "output", "final.mp4")).then(() => true).catch(() => false);
      if (hasVideo) {
        sendJson(res, 200, { id, alreadyDone: true });
        return;
      }
    }

    await mkdir(outDir, { recursive: true });
    startRun(topic, duration, Boolean(existingProject), outDir, id);
    sendJson(res, 200, { id });
    return;
  }

  const streamMatch = /^\/api\/runs\/([^/]+)\/stream$/.exec(pathname);
  if (req.method === "GET" && streamMatch) {
    const run = runs.get(streamMatch[1]);
    if (!run) {
      sendJson(res, 404, { error: "Không tìm thấy tiến trình này" });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    run.listeners.add(res);
    broadcast(run);
    req.on("close", () => run.listeners.delete(res));
    if (run.status !== "running") res.end();
    return;
  }

  const videoMatch = /^\/api\/runs\/([^/]+)\/video$/.exec(pathname);
  if (req.method === "GET" && videoMatch) {
    await serveVideo(req, res, join(OUTPUT_ROOT, videoMatch[1], "output", "final.mp4"));
    return;
  }

  if (req.method === "GET" && (await serveStatic(req, res, pathname))) return;

  sendJson(res, 404, { error: "Không tìm thấy" });
}

// Bind to loopback only: this server has no auth and can trigger real Gemini/Flow spend
// and drive the user's logged-in browser, so it must not be reachable from the LAN.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Music video UI: http://localhost:${PORT}`);
  console.log(`Thư mục dữ liệu (.env, music-output, .gflow): ${WORK_DIR}`);
  if (process.platform === "darwin") {
    spawn("open", [`http://localhost:${PORT}`], { stdio: "ignore" }).unref();
  }
});
