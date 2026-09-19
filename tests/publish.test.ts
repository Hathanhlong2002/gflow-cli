import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TokenStore, createPkce } from "../src/publish/common.js";
import type { FetchFn } from "../src/publish/common.js";
import { AI_DISCLOSURE, buildMetadata, fallbackMetadata, tiktokCaption } from "../src/publish/metadata.js";
import type { MetadataPlan } from "../src/publish/metadata.js";
import { Publisher } from "../src/publish/publisher.js";
import { chunkRange, planTiktokChunks, tiktokPrivacyLevel, uploadTiktokVideo } from "../src/publish/tiktok.js";
import { buildYoutubeResource, uploadYoutubeVideo } from "../src/publish/youtube.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })));
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gflow-publish-"));
  roots.push(root);
  return root;
}

async function videoFile(root: string, bytes: number): Promise<string> {
  const path = join(root, "video.mp4");
  await writeFile(path, new Uint8Array(bytes).fill(7));
  return path;
}

const PLAN: MetadataPlan = {
  topic: "Tình yêu tuổi học trò",
  language: "vi-VN",
  title: "Nắng Sân Trường",
  genre: "V-Pop, ballad",
  mood: "Nostalgic",
  sections: [{ lyrics: ["Dòng một", "Dòng hai"] }]
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

describe("PKCE", () => {
  it("uses base64url for Google and hex for TikTok", () => {
    const google = createPkce("base64url");
    expect(google.challenge).toBe(createHash("sha256").update(google.verifier).digest("base64url"));
    const tiktok = createPkce("hex");
    expect(tiktok.challenge).toBe(createHash("sha256").update(tiktok.verifier).digest("hex"));
    expect(tiktok.challenge).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("TikTok chunk planning", () => {
  it("uploads files up to 64 MB whole", () => {
    expect(planTiktokChunks(24_000_000)).toEqual({ chunkSize: 24_000_000, totalChunks: 1 });
  });

  it("splits larger files with the remainder absorbed by the final chunk", () => {
    const size = 100 * 1024 * 1024;
    const plan = planTiktokChunks(size);
    expect(plan.totalChunks).toBe(Math.floor(size / plan.chunkSize));
    let next = 0;
    for (let index = 0; index < plan.totalChunks; index += 1) {
      const { start, end } = chunkRange(plan, size, index);
      expect(start).toBe(next);
      next = end + 1;
    }
    expect(next).toBe(size);
  });

  it("maps privacy and rejects modes TikTok does not have", () => {
    expect(tiktokPrivacyLevel("private")).toBe("SELF_ONLY");
    expect(tiktokPrivacyLevel("public")).toBe("PUBLIC_TO_EVERYONE");
    expect(() => tiktokPrivacyLevel("unlisted")).toThrow(/Không công khai/);
  });
});

describe("YouTube upload", () => {
  it("always declares synthetic media and sanitizes metadata", () => {
    const resource = buildYoutubeResource({
      filePath: "x",
      title: `<b>${"a".repeat(200)}</b>`,
      description: "mô tả <script>",
      tags: ["ok", "<bad>", "x".repeat(600)],
      privacy: "private",
      madeForKids: false,
      language: "vi"
    }) as { snippet: { title: string; description: string; tags: string[] }; status: Record<string, unknown> };
    expect(resource.status.containsSyntheticMedia).toBe(true);
    expect(resource.status.privacyStatus).toBe("private");
    expect(resource.snippet.title.length).toBeLessThanOrEqual(100);
    expect(resource.snippet.title + resource.snippet.description).not.toMatch(/[<>]/);
    expect(resource.snippet.tags).toEqual(["ok", "bad"]);
  });

  it("uploads in resumable chunks and returns the video URL", async () => {
    const root = await tempDir();
    const filePath = await videoFile(root, 600_000);
    const calls: Array<{ url: string; method?: string; range?: string }> = [];
    const fetcher: FetchFn = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, method: init?.method, range: headers.get("content-range") ?? undefined });
      if (url.includes("uploadType=resumable")) {
        expect(headers.get("authorization")).toBe("Bearer token");
        expect(headers.get("x-upload-content-length")).toBe("600000");
        return new Response(null, { status: 200, headers: { location: "https://upload.example/session" } });
      }
      const range = headers.get("content-range") ?? "";
      if (range.endsWith("-599999/600000")) return json({ id: "vid123" }, { status: 200 });
      const end = Number(/-(\d+)\//.exec(range)![1]);
      return new Response(null, { status: 308, headers: { range: `bytes=0-${end}` } });
    };
    const result = await uploadYoutubeVideo(fetcher, "token", {
      filePath, title: "T", description: "D", tags: [], privacy: "private", madeForKids: false, language: "vi"
    }, { chunkBytes: 262_144, sleep: async () => undefined });
    expect(result).toEqual({ videoId: "vid123", url: "https://www.youtube.com/watch?v=vid123" });
    const ranges = calls.filter((call) => call.range).map((call) => call.range);
    expect(ranges).toEqual(["bytes 0-262143/600000", "bytes 262144-524287/600000", "bytes 524288-599999/600000"]);
  });

  it("reports the privacy YouTube actually applied", async () => {
    const root = await tempDir();
    const filePath = await videoFile(root, 1000);
    const fetcher: FetchFn = async (input) =>
      String(input).includes("uploadType=resumable")
        ? new Response(null, { status: 200, headers: { location: "https://upload.example/s" } })
        : json({ id: "v1", status: { privacyStatus: "private" } });
    const result = await uploadYoutubeVideo(fetcher, "t", {
      filePath, title: "T", description: "D", tags: [], privacy: "public", madeForKids: false, language: "vi"
    });
    expect(result.privacyStatus).toBe("private");
  });

  it("resumes from the server-reported offset after a transient failure", async () => {
    const root = await tempDir();
    const filePath = await videoFile(root, 400_000);
    let putCount = 0;
    const fetcher: FetchFn = async (input, init) => {
      const url = String(input);
      const range = new Headers(init?.headers).get("content-range") ?? "";
      if (url.includes("uploadType=resumable")) return new Response(null, { status: 200, headers: { location: "https://upload.example/s" } });
      putCount += 1;
      if (putCount === 1) return new Response(null, { status: 503 });
      if (range === "bytes */400000") return new Response(null, { status: 308, headers: { range: "bytes=0-262143" } });
      if (range === "bytes 262144-399999/400000") return json({ id: "resumed" });
      return new Response(null, { status: 308, headers: { range: "bytes=0-262143" } });
    };
    const result = await uploadYoutubeVideo(fetcher, "t", {
      filePath, title: "T", description: "D", tags: [], privacy: "private", madeForKids: false, language: "vi"
    }, { chunkBytes: 262_144, sleep: async () => undefined });
    expect(result.videoId).toBe("resumed");
  });

  it("surfaces an API rejection without leaking the token", async () => {
    const root = await tempDir();
    const filePath = await videoFile(root, 1000);
    const fetcher: FetchFn = async () => json({ error: { message: "quotaExceeded" } }, { status: 403 });
    const failure = uploadYoutubeVideo(fetcher, "secret-token", {
      filePath, title: "T", description: "D", tags: [], privacy: "private", madeForKids: false, language: "vi"
    });
    await expect(failure).rejects.toThrow(/quotaExceeded/);
    await expect(failure).rejects.not.toThrow(/secret-token/);
  });
});

describe("TikTok upload", () => {
  function tiktokFetcher(state: { initBody?: Record<string, unknown>; polls: number; ranges: string[]; privacy?: string[] }): FetchFn {
    return async (input, init) => {
      const url = String(input);
      if (url.endsWith("/creator_info/query/")) {
        return json({ data: { creator_username: "mychannel", privacy_level_options: state.privacy ?? ["SELF_ONLY", "PUBLIC_TO_EVERYONE"] }, error: { code: "ok" } });
      }
      if (url.endsWith("/video/init/")) {
        state.initBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return json({ data: { publish_id: "pub1", upload_url: "https://open-upload.example/u" }, error: { code: "ok" } });
      }
      if (url === "https://open-upload.example/u") {
        state.ranges.push(new Headers(init?.headers).get("content-range") ?? "");
        return new Response(null, { status: 201 });
      }
      if (url.endsWith("/status/fetch/")) {
        state.polls += 1;
        return json({
          data: state.polls < 2 ? { status: "PROCESSING_UPLOAD" } : { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [777] },
          error: { code: "ok" }
        });
      }
      throw new Error(`unexpected ${url}`);
    };
  }

  it("declares AI content, uploads, and polls until the post is complete", async () => {
    const root = await tempDir();
    const filePath = await videoFile(root, 300_000);
    const state = { polls: 0, ranges: [] as string[], initBody: undefined as Record<string, unknown> | undefined };
    const result = await uploadTiktokVideo(tiktokFetcher(state), "token", { filePath, caption: "Tiêu đề #tag", privacy: "private", allowComments: true }, { sleep: async () => undefined, pollMs: 1 });
    expect(result).toEqual({ publishId: "pub1", postId: "777", url: "https://www.tiktok.com/@mychannel/video/777" });
    const postInfo = state.initBody!.post_info as Record<string, unknown>;
    expect(postInfo).toMatchObject({ is_aigc: true, privacy_level: "SELF_ONLY", disable_comment: false });
    expect(state.initBody!.source_info).toEqual({ source: "FILE_UPLOAD", video_size: 300_000, chunk_size: 300_000, total_chunk_count: 1 });
    expect(state.ranges).toEqual(["bytes 0-299999/300000"]);
  });

  it("refuses a privacy level the creator account does not allow", async () => {
    const root = await tempDir();
    const filePath = await videoFile(root, 1000);
    const state = { polls: 0, ranges: [] as string[], privacy: ["SELF_ONLY"] };
    await expect(
      uploadTiktokVideo(tiktokFetcher(state), "token", { filePath, caption: "c", privacy: "public", allowComments: true }, { sleep: async () => undefined })
    ).rejects.toThrow(/PUBLIC_TO_EVERYONE/);
    expect(state.ranges).toEqual([]);
  });

  it("reports TikTok processing failures", async () => {
    const root = await tempDir();
    const filePath = await videoFile(root, 1000);
    const fetcher: FetchFn = async (input) => {
      const url = String(input);
      if (url.endsWith("/creator_info/query/")) return json({ data: {}, error: { code: "ok" } });
      if (url.endsWith("/video/init/")) return json({ data: { publish_id: "p", upload_url: "https://u.example/x" }, error: { code: "ok" } });
      if (url === "https://u.example/x") return new Response(null, { status: 201 });
      return json({ data: { status: "FAILED", fail_reason: "duration_check_failed" }, error: { code: "ok" } });
    };
    await expect(
      uploadTiktokVideo(fetcher, "t", { filePath, caption: "c", privacy: "private", allowComments: true }, { sleep: async () => undefined })
    ).rejects.toThrow(/duration_check_failed/);
  });
});

describe("metadata", () => {
  it("builds deterministic fallback metadata that always discloses AI", () => {
    const metadata = fallbackMetadata(PLAN);
    expect(metadata.title).toBe("Nắng Sân Trường");
    expect(metadata.description).toContain(AI_DISCLOSURE);
    expect(metadata.description).toContain("Dòng một");
    expect(metadata.tags).toContain("nhạc AI");
  });

  it("uses model output but still appends the disclosure", async () => {
    const transport = {
      async generateJson() {
        return { title: "Tên <hay>", description: "Một bài hát về tuổi học trò.", tags: ["#học trò", "v-pop"] };
      }
    };
    const metadata = await buildMetadata(PLAN, { transport });
    expect(metadata.title).toBe("Tên hay");
    expect(metadata.description).toContain("Một bài hát về tuổi học trò.");
    expect(metadata.description).toContain(AI_DISCLOSURE);
    expect(metadata.tags.slice(0, 2)).toEqual(["học trò", "v-pop"]);
  });

  it("falls back when the model call fails", async () => {
    const transport = { async generateJson(): Promise<unknown> { throw new Error("429"); } };
    expect((await buildMetadata(PLAN, { transport })).title).toBe("Nắng Sân Trường");
  });

  it("formats a TikTok caption with hashtags", () => {
    const caption = tiktokCaption({ title: "Tiêu đề", description: "", tags: ["học trò", "v-pop"] });
    expect(caption).toBe("Tiêu đề\n#họctrò #vpop");
  });
});

describe("Publisher", () => {
  async function setup(fetcher: FetchFn, env = { YOUTUBE_CLIENT_ID: "yid", YOUTUBE_CLIENT_SECRET: "ysecret", TIKTOK_CLIENT_KEY: "tk", TIKTOK_CLIENT_SECRET: "ts" }) {
    const root = await tempDir();
    const tokens = new TokenStore(join(root, "tokens", "tokens.json"));
    const project = join(root, "project");
    await mkdir(join(project, "output"), { recursive: true });
    await writeFile(join(project, "output", "final.mp4"), new Uint8Array(2000).fill(1));
    return { root, tokens, project, publisher: new Publisher({ tokens, env, fetcher }) };
  }

  const request = (project: string) => ({
    projectRoot: project,
    platforms: ["youtube", "tiktok"] as Array<"youtube" | "tiktok">,
    privacy: "private" as const,
    metadata: { title: "T", description: "D", tags: [] },
    madeForKids: false,
    language: "vi-VN"
  });

  it("stores tokens privately and validates the OAuth state", async () => {
    const fetcher: FetchFn = async () => json({ access_token: "a", refresh_token: "r", expires_in: 3600 });
    const { publisher, tokens, root } = await setup(fetcher);
    const url = new URL(publisher.beginAuth("youtube", "http://127.0.0.1:4173"));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:4173/oauth/youtube/callback");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/youtube.upload");

    await expect(publisher.completeAuth("youtube", "wrong-state", "code")).rejects.toThrow(/không hợp lệ/);
    await publisher.completeAuth("youtube", url.searchParams.get("state")!, "code");
    expect((await tokens.get("youtube"))?.refreshToken).toBe("r");
    expect((await stat(join(root, "tokens", "tokens.json"))).mode & 0o777).toBe(0o600);
    // The state is single-use.
    await expect(publisher.completeAuth("youtube", url.searchParams.get("state")!, "code")).rejects.toThrow();
  });

  it("rejects a callback state that belongs to the other platform", async () => {
    const { publisher } = await setup(async () => json({}));
    const state = new URL(publisher.beginAuth("tiktok", "http://127.0.0.1:4173")).searchParams.get("state")!;
    await expect(publisher.completeAuth("youtube", state, "code")).rejects.toThrow(/không hợp lệ/);
  });

  it("requires configuration before starting OAuth", async () => {
    const { publisher } = await setup(async () => json({}), {} as never);
    expect(() => publisher.beginAuth("tiktok", "http://127.0.0.1:4173")).toThrow(/TIKTOK_CLIENT_KEY/);
  });

  it("records per-platform results, isolates failures, and never double-posts", async () => {
    let youtubeUploads = 0;
    const fetcher: FetchFn = async (input, init) => {
      const url = String(input);
      if (url.includes("googleapis.com/upload/youtube")) {
        youtubeUploads += 1;
        return new Response(null, { status: 200, headers: { location: "https://upload.example/s" } });
      }
      if (url === "https://upload.example/s") return json({ id: "yt1" });
      if (url.includes("tiktokapis.com")) return json({ error: { code: "access_token_invalid", message: "bad" } }, { status: 401 });
      throw new Error(`unexpected ${url} ${String(init?.method)}`);
    };
    const { publisher, tokens, project } = await setup(fetcher);
    const fresh = { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 };
    await tokens.set("youtube", fresh);
    await tokens.set("tiktok", fresh);

    const first = await publisher.publish(request(project));
    expect(first.map((record) => [record.platform, record.status])).toEqual([["youtube", "published"], ["tiktok", "failed"]]);
    expect(first[0].url).toBe("https://www.youtube.com/watch?v=yt1");
    expect(first[1].error).toMatch(/access_token_invalid/);

    const second = await publisher.publish(request(project));
    expect(youtubeUploads).toBe(1);
    expect(second[0].status).toBe("published");
    expect(JSON.parse(await readFile(join(project, "publish.json"), "utf8"))).toHaveLength(3);
  });

  it("only posts a second time when explicitly forced", async () => {
    let uploads = 0;
    const fetcher: FetchFn = async (input) => {
      const url = String(input);
      if (url.includes("uploadType=resumable")) {
        uploads += 1;
        return new Response(null, { status: 200, headers: { location: "https://upload.example/s" } });
      }
      return json({ id: `yt${uploads}` });
    };
    const { publisher, tokens, project } = await setup(fetcher);
    await tokens.set("youtube", { accessToken: "a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 });
    const youtubeOnly = { ...request(project), platforms: ["youtube" as const] };

    await publisher.publish(youtubeOnly);
    await publisher.publish(youtubeOnly);
    expect(uploads).toBe(1);

    const [again] = await publisher.publish({ ...youtubeOnly, force: true });
    expect(uploads).toBe(2);
    expect(again.id).toBe("yt2");
    expect((await publisher.history(project)).filter((record) => record.status === "published")).toHaveLength(2);
  });

  it("fails clearly when a platform is not connected or there is no video", async () => {
    const { publisher, project, root } = await setup(async () => json({}));
    const [youtube] = await publisher.publish({ ...request(project), platforms: ["youtube"] });
    expect(youtube).toMatchObject({ status: "failed", error: "Chưa kết nối YouTube" });
    await expect(publisher.publish({ ...request(join(root, "missing")), platforms: ["youtube"] })).rejects.toThrow(/video hoàn chỉnh/);
  });
});
