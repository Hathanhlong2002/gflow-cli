import { describe, expect, it, vi } from "vitest";
import type { FlowAutomation, FlowJobResult } from "../src/flow/types.js";
import { MusicVideoFlowGenerator } from "../src/music-video/flow-generator.js";
import type { StoryboardEntry } from "../src/music-video/schema.js";

const entry: StoryboardEntry = {
  id: "visual-001",
  startSeconds: 0,
  endSeconds: 8,
  mode: "flow-video",
  sectionId: "section-01",
  visual: "A couple meets beneath warm streetlights after rain",
  motionPrompt: "Slow cinematic dolly forward",
  importance: 5
};

const flowResult: FlowJobResult = {
  jobId: "music-visual-001",
  artifacts: [{ path: "/project/assets/visual-001/generated.mp4", metadataPath: "/project/assets/visual-001/generated.json" }],
  flowUrl: "https://flow.google.com"
};

describe("MusicVideoFlowGenerator", () => {
  it("maps a selected entry to one eight-second widescreen Frames job", async () => {
    let received: Parameters<FlowAutomation["runJob"]>[0] | undefined;
    const automation: FlowAutomation = {
      async runJob(input) {
        received = input;
        return flowResult;
      }
    };

    const result = await new MusicVideoFlowGenerator(automation).generate({
      entry,
      startFramePath: "/project/assets/visual-001/start.jpg",
      outDir: "/project/assets/visual-001"
    });

    expect(received).toEqual({
      job: {
        id: "music-visual-001",
        type: "video",
        prompt: `${entry.visual}\n${entry.motionPrompt}`,
        ratio: "16:9",
        duration: 8,
        startFrame: "/project/assets/visual-001/start.jpg",
        outputs: 1,
        out: "./gflow-output",
        ingredients: [],
        character: []
      },
      outDir: "/project/assets/visual-001"
    });
    expect(result).toEqual(flowResult.artifacts[0]);
  });

  it("rejects non-Flow entries and invalid ids before browser automation", async () => {
    const runJob = vi.fn(async () => flowResult);
    const generator = new MusicVideoFlowGenerator({ runJob });

    await expect(generator.generate({
      entry: { ...entry, mode: "animated-image" },
      startFramePath: "/project/assets/visual-001/start.jpg",
      outDir: "/project/assets/visual-001"
    })).rejects.toThrow(/Flow/i);
    await expect(generator.generate({
      entry: { ...entry, id: "../../unsafe" } as StoryboardEntry,
      startFramePath: "/project/assets/visual-001/start.jpg",
      outDir: "/project/assets/visual-001"
    })).rejects.toThrow(/id|invalid/i);
    expect(runJob).not.toHaveBeenCalled();
  });

  it.each([
    { artifacts: [] },
    { artifacts: [flowResult.artifacts[0], { path: "/project/extra.mp4", metadataPath: "/project/extra.json" }] }
  ])("rejects a result that does not contain exactly one artifact", async ({ artifacts }) => {
    const generator = new MusicVideoFlowGenerator({ runJob: vi.fn(async () => ({ ...flowResult, artifacts })) });
    await expect(generator.generate({
      entry,
      startFramePath: "/project/assets/visual-001/start.jpg",
      outDir: "/project/assets/visual-001"
    })).rejects.toThrow(/exactly one/i);
  });

  it("preserves typed provider failures for pause handling", async () => {
    const { CreditLimitError } = await import("../src/errors.js");
    const failure = new CreditLimitError("quota reached");
    const generator = new MusicVideoFlowGenerator({ runJob: vi.fn(async () => { throw failure; }) });
    await expect(generator.generate({
      entry,
      startFramePath: "/project/assets/visual-001/start.jpg",
      outDir: "/project/assets/visual-001"
    })).rejects.toBe(failure);
  });
});
