import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.js";
import { CreditLimitError } from "../src/errors.js";
import type { FlowAutomation } from "../src/flow/types.js";
import type { SceneGenerator } from "../src/shorts/flow-generator.js";
import type { GeminiMediaTransport } from "../src/shorts/gemini-transport.js";
import { GenerationJournalStore } from "../src/shorts/generation-journal.js";
import { ProjectStore } from "../src/shorts/project-store.js";
import { validCreativePlan } from "./fixtures/shorts.js";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
const MP4 = new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d]);

describe("shorts generate CLI", () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })));
  });

  it("loads a planned project and generates all scenes with injected adapters", async () => {
    const project = await createProject();
    let imageCalls = 0;
    let speechCalls = 0;
    let flowCalls = 0;
    const gemini: GeminiMediaTransport = {
      async generateImage() { imageCalls += 1; return { mimeType: "image/jpeg", bytes: JPEG }; },
      async generateSpeech() { speechCalls += 1; return { sampleRate: 24000, channels: 1, bitsPerSample: 16, pcm: new Uint8Array([0, 0]) }; }
    };
    const sceneGenerator: SceneGenerator = {
      async generate(input) {
        flowCalls += 1;
        const path = join(input.outDir, `ep-${String(input.episodeIndex).padStart(2, "0")}-scene-${String(input.sceneIndex).padStart(2, "0")}.mp4`);
        await mkdir(input.outDir, { recursive: true });
        await writeFile(path, MP4);
        return { path, metadataPath: `${path}.json` };
      }
    };
    const program = createProgram({ shortsMedia: gemini, shortsSceneGenerator: sceneGenerator, environment: {} });

    await program.parseAsync(["node", "gflow", "shorts", "generate", project.statePath, "--resume"]);

    const journal = JSON.parse(await readFile(join(project.root, "generation.json"), "utf8"));
    expect(journal).toMatchObject({ status: "GENERATED", scenes: Array.from({ length: 100 }, () => ({ status: "COMPLETED" })) });
    expect([imageCalls, speechCalls, flowCalls]).toEqual([0, 100, 100]);
  });

  it("requires a Gemini key only when no media adapter is injected", async () => {
    const project = await createProject();
    let openedBrowser = false;
    const program = createProgram({
      environment: {},
      flowAutomationFactory: async () => {
        openedBrowser = true;
        throw new Error("browser should not open");
      }
    });

    await expect(program.parseAsync(["node", "gflow", "shorts", "generate", project.statePath])).rejects.toThrow(/GEMINI_API_KEY/);
    expect(openedBrowser).toBe(false);
  });

  it("rejects a manifest path instead of the project.json path", async () => {
    const project = await createProject();
    const program = createProgram({ shortsMedia: completeGemini(), shortsSceneGenerator: emptyGenerator() });

    await expect(program.parseAsync(["node", "gflow", "shorts", "generate", join(project.root, "creative-plan.json")]))
      .rejects.toThrow(/project\.json/i);
  });

  it("does not generate a project before it reaches PLANNED", async () => {
    const root = await newRoot();
    const store = new ProjectStore(root);
    await store.create({ topic: validCreativePlan().topic, language: "vi-VN", textModel: "text", imageModel: "image", ttsModel: "tts" });
    const program = createProgram({ shortsMedia: completeGemini(), shortsSceneGenerator: emptyGenerator() });

    await expect(program.parseAsync(["node", "gflow", "shorts", "generate", store.paths().state]))
      .rejects.toThrow(/PLANNED/i);
  });

  it("requires --resume when a generation journal already exists", async () => {
    const project = await createProject();
    await new GenerationJournalStore(project.root).create(project.state.planHash!);
    let imageCalls = 0;
    const media = completeGemini();
    const gemini: GeminiMediaTransport = {
      ...media,
      async generateImage(input) { imageCalls += 1; return media.generateImage(input); }
    };
    const program = createProgram({ shortsMedia: gemini, shortsSceneGenerator: emptyGenerator() });

    await expect(program.parseAsync(["node", "gflow", "shorts", "generate", project.statePath]))
      .rejects.toThrow(/--resume/i);
    expect(imageCalls).toBe(0);
  });

  it("closes the single Flow session after a quota pause", async () => {
    const project = await createProject();
    const close = vi.fn(async () => undefined);
    const runJob = vi.fn(async () => { throw new CreditLimitError("quota reached"); });
    const automation: FlowAutomation = { runJob };
    const flowAutomationFactory = vi.fn(async () => ({ automation, close }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const program = createProgram({ shortsMedia: completeGemini(), flowAutomationFactory });

    await expect(program.parseAsync(["node", "gflow", "shorts", "generate", project.statePath, "--profile", "shorts", "--browser", "chromium"]))
      .rejects.toBeInstanceOf(CreditLimitError);

    expect(flowAutomationFactory).toHaveBeenCalledWith({ profile: "shorts", headed: true, browser: "chromium" });
    expect(runJob).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(project.root, "generation.json"), "utf8")).status).toBe("PAUSED");
  });

  async function newRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "gflow-shorts-generate-cli-"));
    roots.push(root);
    return root;
  }

  async function createProject() {
    const root = await newRoot();
    const store = new ProjectStore(root);
    await store.create({ topic: validCreativePlan().topic, language: "vi-VN", textModel: "gemini-text", imageModel: "gemini-image", ttsModel: "gemini-tts" });
    const state = await store.savePlan(validCreativePlan());
    return { root, state, statePath: store.paths().state };
  }

  function completeGemini(): GeminiMediaTransport {
    return {
      async generateImage() { return { mimeType: "image/jpeg", bytes: JPEG }; },
      async generateSpeech() { return { sampleRate: 24000, channels: 1, bitsPerSample: 16, pcm: new Uint8Array([0, 0]) }; }
    };
  }

  function emptyGenerator(): SceneGenerator {
    return { async generate() { throw new Error("Unexpected Flow generation"); } };
  }
});
