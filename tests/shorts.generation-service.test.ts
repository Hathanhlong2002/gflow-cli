import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CreditLimitError } from "../src/errors.js";
import type { FlowArtifact } from "../src/flow/types.js";
import type { GeminiMediaTransport } from "../src/shorts/gemini-transport.js";
import { GenerationJournalStore } from "../src/shorts/generation-journal.js";
import type { SceneGenerator } from "../src/shorts/flow-generator.js";
import { ProjectStore } from "../src/shorts/project-store.js";
import { generateShortsProject } from "../src/shorts/generation-service.js";
import { validCreativePlan } from "./fixtures/shorts.js";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);
const WAV_PCM = new Uint8Array([0x00, 0x00]);
const MP4 = new Uint8Array([0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 0x69, 0x73, 0x6f, 0x6d]);

describe("generateShortsProject", () => {
  const roots: string[] = [];
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("checkpoints all scene media and serializes Flow jobs", async () => {
    const harness = await createHarness();
    let speechCalls = 0;
    let flowCalls = 0;
    let flowActive = 0;
    let maxFlowActive = 0;
    const gemini: GeminiMediaTransport = {
      async generateImage() {
        throw new Error("Shorts generation must not request Gemini images");
      },
      async generateSpeech() { speechCalls += 1; return { sampleRate: 24000, channels: 1, bitsPerSample: 16, pcm: WAV_PCM }; }
    };
    const sceneGenerator: SceneGenerator = {
      async generate(input) {
        flowCalls += 1;
        flowActive += 1;
        maxFlowActive = Math.max(maxFlowActive, flowActive);
        await new Promise((resolve) => setTimeout(resolve, 1));
        const artifact = await writeFlowArtifact(input.outDir, input.episodeIndex, input.sceneIndex);
        flowActive -= 1;
        return artifact;
      }
    };

    const result = await generateShortsProject({ ...harness, gemini, sceneGenerator });

    expect(result.status).toBe("GENERATED");
    expect(result.scenes).toHaveLength(100);
    expect(result.scenes.every((scene) => scene.status === "COMPLETED" && !scene.image && scene.narration && scene.video)).toBe(true);
    expect([speechCalls, flowCalls, maxFlowActive]).toEqual([100, 100, 1]);
    const clip = await readFile(join(harness.root, "episodes/01/scenes/01/clip.mp4"));
    expect(createHash("sha256").update(clip).digest("hex")).toBe(result.scenes[0].video?.sha256);
  });

  it("generates and checkpoints every Flow video before requesting narration", async () => {
    const harness = await createHarness();
    let speechCalls = 0;
    let flowCalls = 0;
    const gemini: GeminiMediaTransport = {
      async generateImage() {
        throw new Error("Shorts generation must not request Gemini images");
      },
      async generateSpeech() {
        speechCalls += 1;
        throw new Error("Gemini TTS quota exhausted");
      }
    };
    const sceneGenerator: SceneGenerator = {
      async generate(input) {
        flowCalls += 1;
        return writeFlowArtifact(input.outDir, input.episodeIndex, input.sceneIndex);
      }
    };

    await expect(generateShortsProject({ ...harness, gemini, sceneGenerator }))
      .rejects.toThrow("Gemini TTS quota exhausted");

    const checkpoint = await harness.journalStore.load();
    expect([flowCalls, speechCalls]).toEqual([100, 1]);
    expect(checkpoint.scenes.every((scene) => scene.video && !scene.narration)).toBe(true);
  });

  it("pauses durably on quota and does not rotate accounts", async () => {
    const harness = await createHarness();
    let flowCalls = 0;
    const gemini = completeGemini();
    const sceneGenerator: SceneGenerator = {
      async generate(input) {
        flowCalls += 1;
        if (flowCalls === 4) throw new CreditLimitError("quota reached");
        return writeFlowArtifact(input.outDir, input.episodeIndex, input.sceneIndex);
      }
    };

    await expect(generateShortsProject({ ...harness, gemini, sceneGenerator })).rejects.toBeInstanceOf(CreditLimitError);
    expect((await harness.journalStore.load()).status).toBe("PAUSED");
    expect(JSON.parse(await readFile(join(harness.root, "action-required.json"), "utf8"))).toEqual({
      code: "CREDIT_LIMIT",
      userAction: "Resolve the Flow quota issue manually, then resume this project."
    });
    expect(flowCalls).toBe(4);
  });

  it("resumes after quota without repeating checkpointed images or narration", async () => {
    const harness = await createHarness();
    let speechCalls = 0;
    let flowCalls = 0;
    const gemini: GeminiMediaTransport = {
      async generateImage() { throw new Error("Shorts generation must not request Gemini images"); },
      async generateSpeech() { speechCalls += 1; return { sampleRate: 24000, channels: 1, bitsPerSample: 16, pcm: WAV_PCM }; }
    };
    const sceneGenerator: SceneGenerator = {
      async generate(input) {
        flowCalls += 1;
        if (flowCalls === 4) throw new CreditLimitError("quota reached");
        return writeFlowArtifact(input.outDir, input.episodeIndex, input.sceneIndex);
      }
    };

    await expect(generateShortsProject({ ...harness, gemini, sceneGenerator })).rejects.toBeInstanceOf(CreditLimitError);
    const resumed = await generateShortsProject({ ...harness, gemini, sceneGenerator, resume: true });

    expect(resumed.status).toBe("GENERATED");
    expect([speechCalls, flowCalls]).toEqual([100, 101]);
    await expect(readFile(join(harness.root, "action-required.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a resume when the creative plan hash differs from the journal", async () => {
    const harness = await createHarness();
    const changedPlan = validCreativePlan();
    changedPlan.seriesTitle = "A different series";

    await expect(generateShortsProject({
      ...harness,
      plan: changedPlan,
      gemini: completeGemini(),
      sceneGenerator: { async generate(input) { return writeFlowArtifact(input.outDir, input.episodeIndex, input.sceneIndex); } }
    })).rejects.toThrow(/plan hash/i);
  });

  it("refuses to trust a journaled artifact whose checksum changed", async () => {
    const harness = await createHarness();
    await harness.journalStore.create(harness.project.planHash!);
    const paths = harness.journalStore.pathsFor(1, 1);
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.imageJpeg, new Uint8Array([0xff, 0xd8, 0xff, 0x55]));
    const journal = await harness.journalStore.load();
    journal.scenes[0].image = {
      path: "episodes/01/scenes/01/start.jpg",
      bytes: 4,
      sha256: "0".repeat(64),
      mimeType: "image/jpeg"
    };
    await harness.journalStore.save(journal);

    await expect(generateShortsProject({
      ...harness,
      resume: true,
      gemini: completeGemini(),
      sceneGenerator: { async generate(input) { return writeFlowArtifact(input.outDir, input.episodeIndex, input.sceneIndex); } }
    })).rejects.toThrow(/checksum/i);
  });

  async function createHarness() {
    const root = await mkdtemp(join(tmpdir(), "gflow-shorts-generation-"));
    roots.push(root);
    const projectStore = new ProjectStore(root);
    await projectStore.create({
      topic: "Những bí ẩn của đại dương",
      language: "vi-VN",
      textModel: "gemini-2.5-flash",
      imageModel: "gemini-image",
      ttsModel: "gemini-tts"
    });
    const project = await projectStore.savePlan(validCreativePlan());
    return {
      root,
      project,
      plan: validCreativePlan(),
      journalStore: new GenerationJournalStore(root),
      resume: false
    };
  }

  function completeGemini(): GeminiMediaTransport {
    return {
      async generateImage() { return { mimeType: "image/jpeg", bytes: JPEG }; },
      async generateSpeech() { return { sampleRate: 24000, channels: 1, bitsPerSample: 16, pcm: WAV_PCM }; }
    };
  }

  async function writeFlowArtifact(outDir: string, episodeIndex: number, sceneIndex: number): Promise<FlowArtifact> {
    const path = join(outDir, `ep-${String(episodeIndex).padStart(2, "0")}-scene-${String(sceneIndex).padStart(2, "0")}.mp4`);
    await mkdir(outDir, { recursive: true });
    await writeFile(path, MP4);
    return { path, metadataPath: `${path}.json` };
  }
});
