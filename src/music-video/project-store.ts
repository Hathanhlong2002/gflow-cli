import { createHash, randomUUID } from "node:crypto";
import { access, appendFile, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { BinaryMedia } from "../shorts/gemini-transport.js";
import type { GeneratedSong } from "./lyria-transport.js";
import {
  musicVideoArtifactSchema,
  musicVideoProjectStateSchema,
  musicVideoStageSchema,
  musicVideoTopicSchema,
  musicVideoJournalSchema,
  parseMusicVideoJournal,
  parseMusicVideoProjectState,
  parseSongPlan,
  parseStoryboard,
  type MusicVideoArtifact,
  type MusicVideoJournal,
  type MusicVideoProjectState,
  type SongPlan,
  type Storyboard
} from "./schema.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_MP3_BYTES = 64 * 1024 * 1024;
const modelNameSchema = z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9._-]+$/);

const createProjectSchema = z.object({
  topic: musicVideoTopicSchema,
  language: z.string().trim().min(2).max(35),
  targetDurationSeconds: z.number().int().min(30).max(240),
  textModel: modelNameSchema,
  imageModel: modelNameSchema,
  musicModel: modelNameSchema
}).strict();

const eventInputSchema = z.object({
  stage: musicVideoStageSchema,
  code: z.string().regex(/^[A-Z0-9_]+$/).optional(),
  message: z.string().trim().min(1).max(1000)
}).strict();

export interface CreateMusicVideoProjectInput {
  topic: string;
  language: string;
  targetDurationSeconds: number;
  textModel: string;
  imageModel: string;
  musicModel: string;
}

export interface MusicVideoPaths {
  root: string;
  state: string;
  plan: string;
  storyboard: string;
  journal: string;
  actionRequired: string;
  song: string;
  lyrics: string;
  lyriaResponse: string;
  captions: string;
  final: string;
  mediaReport: string;
  events: string;
}

function slugify(value: string): string {
  const slug = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || `music-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function safeRelativePath(root: string, path: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const child = relative(resolvedRoot, resolvedPath);
  if (child.length === 0 || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Artifact path is outside the music-video project directory");
  }
  return child.split(sep).join("/");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function atomicWrite(path: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function isMp3(bytes: Uint8Array): boolean {
  const id3 = bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
  const frame = bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  return id3 || frame;
}

function hasImageSignature(media: BinaryMedia): boolean {
  if (media.mimeType === "image/jpeg") {
    return media.bytes.length >= 3 && media.bytes[0] === 0xff && media.bytes[1] === 0xd8 && media.bytes[2] === 0xff;
  }
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  return media.bytes.length >= png.length && png.every((byte, index) => media.bytes[index] === byte);
}

export function redactSensitiveText(message: string): string {
  return message
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[REDACTED]")
    .replace(/\b(api[_-]?key|authorization|token|secret)\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
}

export class MusicVideoProjectStore {
  private readonly root: string;
  private readonly projectPaths: MusicVideoPaths;

  constructor(root: string) {
    this.root = resolve(root);
    this.projectPaths = {
      root: this.root,
      state: join(this.root, "project.json"),
      plan: join(this.root, "song-plan.json"),
      storyboard: join(this.root, "storyboard.json"),
      journal: join(this.root, "generation.json"),
      actionRequired: join(this.root, "action-required.json"),
      song: join(this.root, "audio", "song.mp3"),
      lyrics: join(this.root, "audio", "lyrics.txt"),
      lyriaResponse: join(this.root, "audio", "lyria-response.json"),
      captions: join(this.root, "captions", "lyrics.ass"),
      final: join(this.root, "output", "final.mp4"),
      mediaReport: join(this.root, "output", "media-report.json"),
      events: join(this.root, "logs", "events.jsonl")
    };
  }

  paths(): MusicVideoPaths {
    return { ...this.projectPaths };
  }

  assetPaths(entryId: string): { directory: string; imageJpeg: string; imagePng: string; video: string; metadata: string } {
    const id = z.string().regex(/^visual-\d{3}$/, "invalid visual id").parse(entryId);
    const directory = join(this.root, "assets", id);
    return {
      directory,
      imageJpeg: join(directory, "start.jpg"),
      imagePng: join(directory, "start.png"),
      video: join(directory, "clip.mp4"),
      metadata: join(directory, "artifact.json")
    };
  }

  async create(input: CreateMusicVideoProjectInput): Promise<MusicVideoProjectState> {
    const config = createProjectSchema.parse(input);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (await exists(this.projectPaths.state)) {
      throw new Error(`Music-video project already exists at ${this.projectPaths.state}; load it before resuming`);
    }
    const timestamp = new Date().toISOString();
    const state = musicVideoProjectStateSchema.parse({
      schemaVersion: 1,
      projectId: slugify(config.topic),
      stage: "CREATED",
      topic: config.topic,
      language: config.language,
      targetDurationSeconds: config.targetDurationSeconds,
      models: { text: config.textModel, image: config.imageModel, music: config.musicModel },
      createdAt: timestamp,
      updatedAt: timestamp
    });
    await this.saveState(state);
    return state;
  }

  async load(): Promise<MusicVideoProjectState> {
    return parseMusicVideoProjectState(JSON.parse(await readFile(this.projectPaths.state, "utf8")) as unknown);
  }

  async saveState(value: MusicVideoProjectState): Promise<MusicVideoProjectState> {
    const state = musicVideoProjectStateSchema.parse({ ...value, updatedAt: new Date().toISOString() });
    await atomicWrite(this.projectPaths.state, `${JSON.stringify(state, null, 2)}\n`);
    return state;
  }

  async savePlan(value: SongPlan): Promise<{ plan: SongPlan; sha256: string }> {
    const plan = parseSongPlan(value);
    const content = `${JSON.stringify(plan, null, 2)}\n`;
    await atomicWrite(this.projectPaths.plan, content);
    return { plan, sha256: createHash("sha256").update(content).digest("hex") };
  }

  async loadPlan(expectedHash?: string): Promise<SongPlan> {
    const content = await readFile(this.projectPaths.plan, "utf8");
    if (expectedHash && createHash("sha256").update(content).digest("hex") !== expectedHash) {
      throw new Error("Song plan checkpoint failed hash integrity validation");
    }
    return parseSongPlan(JSON.parse(content) as unknown);
  }

  async saveStoryboard(value: Storyboard): Promise<{ storyboard: Storyboard; sha256: string }> {
    const storyboard = parseStoryboard(value, value.durationSeconds);
    const content = `${JSON.stringify(storyboard, null, 2)}\n`;
    await atomicWrite(this.projectPaths.storyboard, content);
    return { storyboard, sha256: createHash("sha256").update(content).digest("hex") };
  }

  async loadStoryboard(expectedHash?: string, expectedDurationSeconds?: number): Promise<Storyboard> {
    const content = await readFile(this.projectPaths.storyboard, "utf8");
    if (expectedHash && createHash("sha256").update(content).digest("hex") !== expectedHash) {
      throw new Error("Storyboard checkpoint failed hash integrity validation");
    }
    return parseStoryboard(JSON.parse(content) as unknown, expectedDurationSeconds);
  }

  async saveJournal(value: MusicVideoJournal): Promise<MusicVideoJournal> {
    const journal = musicVideoJournalSchema.parse({ ...value, updatedAt: new Date().toISOString() });
    await atomicWrite(this.projectPaths.journal, `${JSON.stringify(journal, null, 2)}\n`);
    return journal;
  }

  async loadJournal(): Promise<MusicVideoJournal> {
    return parseMusicVideoJournal(JSON.parse(await readFile(this.projectPaths.journal, "utf8")) as unknown);
  }

  async writeSong(song: GeneratedSong): Promise<MusicVideoArtifact> {
    if (song.mimeType !== "audio/mpeg" || song.bytes.byteLength === 0 || song.bytes.byteLength > MAX_MP3_BYTES || !isMp3(song.bytes)) {
      throw new Error("Song must be a non-empty valid MP3 within the size limit");
    }
    const lyrics = z.string().trim().min(1).max(2 * 1024 * 1024).parse(song.outputText);
    await atomicWrite(this.projectPaths.song, song.bytes);
    await atomicWrite(this.projectPaths.lyrics, `${lyrics}\n`);
    return this.recordArtifact(this.projectPaths.song, "audio/mpeg");
  }

  async writeImage(entryId: string, media: BinaryMedia): Promise<MusicVideoArtifact> {
    const paths = this.assetPaths(entryId);
    if (media.bytes.byteLength === 0 || media.bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new Error("Image byte length is invalid");
    }
    if (!hasImageSignature(media)) throw new Error("Image MIME type does not match its signature");
    const path = media.mimeType === "image/jpeg" ? paths.imageJpeg : paths.imagePng;
    await atomicWrite(path, media.bytes);
    return this.recordArtifact(path, media.mimeType);
  }

  async writeVideo(entryId: string, sourcePath: string): Promise<MusicVideoArtifact> {
    const target = this.assetPaths(entryId).video;
    const bytes = await readFile(resolve(sourcePath));
    const hasFtyp = bytes.byteLength >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp";
    if (!hasFtyp || bytes.byteLength > 500 * 1024 * 1024) throw new Error("Flow clip does not have a valid MP4 signature or size");
    await atomicWrite(target, bytes);
    return this.recordArtifact(target, "video/mp4");
  }

  async writeCaptions(content: string): Promise<MusicVideoArtifact> {
    const captions = z.string().min(1).max(4 * 1024 * 1024).parse(content);
    await atomicWrite(this.projectPaths.captions, captions);
    return this.recordArtifact(this.projectPaths.captions, "text/x-ass");
  }

  async writeLyriaResponse(value: { outputText: string; structureText?: string }): Promise<MusicVideoArtifact> {
    const response = z.object({
      outputText: z.string().min(1).max(2 * 1024 * 1024),
      structureText: z.string().max(2 * 1024 * 1024).optional()
    }).strict().parse(value);
    await atomicWrite(this.projectPaths.lyriaResponse, `${JSON.stringify(response, null, 2)}\n`);
    return this.recordArtifact(this.projectPaths.lyriaResponse, "application/json");
  }

  async loadLyriaResponse(): Promise<{ outputText: string; structureText?: string }> {
    return z.object({
      outputText: z.string().min(1).max(2 * 1024 * 1024),
      structureText: z.string().max(2 * 1024 * 1024).optional()
    }).strict().parse(JSON.parse(await readFile(this.projectPaths.lyriaResponse, "utf8")) as unknown);
  }

  async writeActionRequired(value: { code: string; message: string; resumeCommand: string }): Promise<void> {
    const action = z.object({
      code: z.string().regex(/^[A-Z0-9_]+$/),
      message: z.string().min(1).max(1000),
      resumeCommand: z.string().min(1).max(500)
    }).strict().parse(value);
    await atomicWrite(this.projectPaths.actionRequired, `${JSON.stringify({
      ...action,
      message: redactSensitiveText(action.message),
      createdAt: new Date().toISOString()
    }, null, 2)}\n`);
  }

  async clearActionRequired(): Promise<void> {
    await unlink(this.projectPaths.actionRequired).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  resolveArtifactPath(artifact: MusicVideoArtifact): string {
    const parsed = musicVideoArtifactSchema.parse(artifact);
    const path = resolve(this.root, parsed.path);
    safeRelativePath(this.root, path);
    return path;
  }

  async recordArtifact(path: string, mimeType: MusicVideoArtifact["mimeType"]): Promise<MusicVideoArtifact> {
    const relativePath = safeRelativePath(this.root, path);
    const bytes = await readFile(resolve(path));
    return musicVideoArtifactSchema.parse({
      path: relativePath,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mimeType
    });
  }

  async artifactMatchesDisk(artifact: MusicVideoArtifact): Promise<boolean> {
    const parsed = musicVideoArtifactSchema.parse(artifact);
    const path = this.resolveArtifactPath(parsed);
    try {
      const file = await readFile(path);
      return file.byteLength === parsed.bytes && createHash("sha256").update(file).digest("hex") === parsed.sha256;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async appendEvent(input: { stage: MusicVideoProjectState["stage"]; code?: string; message: string }): Promise<void> {
    const event = eventInputSchema.parse(input);
    const line = `${JSON.stringify({ ...event, message: redactSensitiveText(event.message), timestamp: new Date().toISOString() })}\n`;
    await mkdir(dirname(this.projectPaths.events), { recursive: true, mode: 0o700 });
    await appendFile(this.projectPaths.events, line, { encoding: "utf8", mode: 0o600 });
  }
}
