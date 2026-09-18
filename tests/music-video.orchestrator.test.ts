import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreditLimitError } from "../src/errors.js";
import type { FlowArtifact } from "../src/flow/types.js";
import { runMusicVideo, type RunMusicVideoInput } from "../src/music-video/orchestrator.js";
import { MusicVideoProjectStore } from "../src/music-video/project-store.js";
import type { MusicVideoRenderResult } from "../src/music-video/renderer.js";
import { validSongPlan, validStoryboard } from "./fixtures/music-video.js";

const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const MP4 = new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d]);
const RETURNED_LYRICS = validSongPlan().sections.flatMap((section) => section.lyrics).join("\n");

describe("music-video orchestrator", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function newRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "gflow-music-orchestrator-"));
    roots.push(root);
    return root;
  }

  async function dependencies(root: string, events: string[], flowFailure?: Error): Promise<RunMusicVideoInput> {
    const store = new MusicVideoProjectStore(root);
    const close = vi.fn(async () => { events.push("flow-close"); });
    return {
      root,
      topic: "Tình yêu",
      language: "vi-VN",
      targetDurationSeconds: 180,
      models: { text: "gemini-text", image: "gemini-image", music: "lyria-3.5" },
      resume: false,
      store,
      songPlanner: {
        async plan() { events.push("plan"); return validSongPlan(); }
      },
      musicGenerator: {
        async generate() {
          events.push("song");
          return { mimeType: "audio/mpeg", bytes: MP3, outputText: RETURNED_LYRICS };
        }
      },
      storyboardPlanner: {
        async plan() { events.push("storyboard"); return validStoryboard(); }
      },
      imageGenerator: {
        async generateImage() { events.push("image"); return { mimeType: "image/jpeg", bytes: JPEG }; },
        async generateSpeech() { throw new Error("speech is not used"); }
      },
      flowGeneratorFactory: async () => ({
        generator: {
          async generate(input): Promise<FlowArtifact> {
            events.push("flow");
            if (flowFailure) throw flowFailure;
            await mkdir(input.outDir, { recursive: true });
            const path = join(input.outDir, "generated.mp4");
            await writeFile(path, MP4);
            return { path, metadataPath: `${path}.json` };
          }
        },
        close
      }),
      probeMedia: async (path) => path.endsWith("song.mp3")
        ? { duration: 180, size: MP3.length, hasVideo: false, hasAudio: true, streams: [{ codecType: "audio", codecName: "mp3", channels: 2 }] }
        : { duration: 8, size: MP4.length, hasVideo: true, hasAudio: false, width: 1920, height: 1080, streams: [{ codecType: "video", codecName: "h264", width: 1920, height: 1080 }] },
      renderer: async (input): Promise<MusicVideoRenderResult> => {
        events.push("render");
        await mkdir(join(root, "output"), { recursive: true });
        await writeFile(input.outputPath, MP4);
        const sha256 = createHash("sha256").update(MP4).digest("hex");
        const result = {
          outputPath: input.outputPath,
          reportPath: input.reportPath,
          duration: 180,
          bytes: MP4.length,
          sha256,
          width: 1920,
          height: 1080,
          captionMode: "embedded" as const
        };
        await writeFile(input.reportPath, `${JSON.stringify({
          ...result,
          fps: 30,
          visualCount: validStoryboard().entries.length,
          renderedAt: new Date().toISOString()
        })}\n`);
        return result;
      }
    };
  }

  it("runs stages in order, checkpoints every asset, and reaches READY", async () => {
    const root = await newRoot();
    const events: string[] = [];
    const input = await dependencies(root, events);

    const result = await runMusicVideo(input);

    expect(result).toMatchObject({ stage: "READY", outputPath: join(root, "output", "final.mp4"), duration: 180 });
    expect(events.slice(0, 3)).toEqual(["plan", "song", "storyboard"]);
    expect(events.filter((event) => event === "image")).toHaveLength(4);
    expect(events.filter((event) => event === "flow")).toHaveLength(4);
    expect(events.at(-2)).toBe("flow-close");
    expect(events.at(-1)).toBe("render");

    const state = await input.store.load();
    expect(state.stage).toBe("READY");
    const journal = JSON.parse(await readFile(input.store.paths().journal, "utf8"));
    expect(journal.entries).toEqual(Array.from({ length: 4 }, () => expect.objectContaining({ status: "COMPLETED" })));
    await expect(access(input.store.paths().captions)).resolves.toBeUndefined();
    await expect(access(input.store.paths().final)).resolves.toBeUndefined();
  });

  it("returns an existing verified READY result without contacting providers", async () => {
    const root = await newRoot();
    const firstEvents: string[] = [];
    const first = await dependencies(root, firstEvents);
    await runMusicVideo(first);

    const resumeEvents: string[] = [];
    const resumed = await dependencies(root, resumeEvents);
    resumed.resume = true;
    const result = await runMusicVideo(resumed);

    expect(result.stage).toBe("READY");
    expect(resumeEvents).toEqual([]);
  });

  it("pauses with redacted action guidance and closes Flow on quota failure", async () => {
    const root = await newRoot();
    const events: string[] = [];
    const input = await dependencies(root, events, new CreditLimitError("quota reached with token=secret-value"));

    await expect(runMusicVideo(input)).rejects.toBeInstanceOf(CreditLimitError);

    expect(events).toContain("flow-close");
    expect((await input.store.load()).stage).toBe("PAUSED");
    const action = await readFile(input.store.paths().actionRequired, "utf8");
    expect(action).toContain("CREDIT_LIMIT");
    expect(action).toContain("--resume");
    expect(action).toContain("--topic");
    expect(action).toContain("--out");
    expect(action).not.toContain("secret-value");
  });

  it("records FAILED for an ordinary provider error", async () => {
    const root = await newRoot();
    const input = await dependencies(root, []);
    input.songPlanner.plan = async () => { throw new Error("planner unavailable"); };

    await expect(runMusicVideo(input)).rejects.toThrow(/planner unavailable/);
    expect((await input.store.load()).stage).toBe("FAILED");
  });

  it("records CANCELLED when the caller aborts", async () => {
    const root = await newRoot();
    const input = await dependencies(root, []);
    const controller = new AbortController();
    controller.abort();
    input.signal = controller.signal;

    await expect(runMusicVideo(input)).rejects.toMatchObject({ name: "AbortError" });
    expect((await input.store.load()).stage).toBe("CANCELLED");
  });

  it("cancels while a provider request is still pending", async () => {
    const root = await newRoot();
    const input = await dependencies(root, []);
    const controller = new AbortController();
    input.signal = controller.signal;
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolvePromise) => { notifyStarted = resolvePromise; });
    input.musicGenerator.generate = async () => {
      notifyStarted();
      return new Promise(() => undefined);
    };

    const running = runMusicVideo(input);
    await started;
    controller.abort();

    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect((await input.store.load()).stage).toBe("CANCELLED");
  });
});
