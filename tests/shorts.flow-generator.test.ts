import { describe, expect, it, vi } from "vitest";
import { GoogleFlowSceneGenerator } from "../src/shorts/flow-generator.js";
import type { FlowAutomation, FlowJobResult } from "../src/flow/types.js";
import type { ScenePlan } from "../src/shorts/schema.js";
import { validCreativePlan } from "./fixtures/shorts.js";

const flowResult: FlowJobResult = {
  jobId: "ep-02-scene-03",
  artifacts: [{ path: "/tmp/flow/clip.mp4", metadataPath: "/tmp/flow/clip.json" }],
  flowUrl: "https://labs.google/fx/tools/flow"
};

describe("GoogleFlowSceneGenerator", () => {
  it("maps a planned scene to one 8-second vertical Flow job", async () => {
    let received: Parameters<FlowAutomation["runJob"]>[0] | undefined;
    const automation: FlowAutomation = {
      async runJob(input) {
        received = input;
        return flowResult;
      }
    };
    const scene = validCreativePlan().episodes[1].scenes[2];

    const result = await new GoogleFlowSceneGenerator(automation).generate({
      episodeIndex: 2,
      sceneIndex: 3,
      scene,
      imagePath: "/project/episodes/02/scenes/03/start.jpg",
      outDir: "/project/flow-output"
    });

    expect(received).toEqual({
      job: {
        id: "ep-02-scene-03",
        type: "video",
        prompt: "Khung cảnh dưới biển 3\nMáy quay tiến chậm trong cảnh 3",
        ratio: "9:16",
        duration: 8,
        outputs: 1,
        startFrame: "/project/episodes/02/scenes/03/start.jpg",
        out: "./gflow-output",
        ingredients: [],
        character: []
      },
      outDir: "/project/flow-output"
    });
    expect(result).toEqual(flowResult.artifacts[0]);
  });

  it.each([
    { label: "zero", artifacts: [] },
    { label: "multiple", artifacts: [flowResult.artifacts[0], { path: "/tmp/flow/extra.mp4", metadataPath: "/tmp/flow/extra.json" }] }
  ])("rejects a Flow result with $label artifacts", async ({ artifacts }) => {
      const automation: FlowAutomation = { runJob: vi.fn(async () => ({ ...flowResult, artifacts })) };
      await expect(new GoogleFlowSceneGenerator(automation).generate({
        episodeIndex: 1,
        sceneIndex: 1,
        scene: validCreativePlan().episodes[0].scenes[0],
        imagePath: "/project/start.jpg",
        outDir: "/project/out"
      })).rejects.toThrow(/exactly one/i);
  });

  it("does not allow scene data to override the fixed job configuration", async () => {
    let received: Parameters<FlowAutomation["runJob"]>[0] | undefined;
    const automation: FlowAutomation = {
      async runJob(input) {
        received = input;
        return flowResult;
      }
    };
    const untrustedScene = {
      ...validCreativePlan().episodes[0].scenes[0],
      id: "scene-01",
      startFrame: "/tmp/attacker.png",
      outDir: "/tmp/attacker",
      outputs: 8
    } as ScenePlan;

    await new GoogleFlowSceneGenerator(automation).generate({
      episodeIndex: 1,
      sceneIndex: 1,
      scene: untrustedScene,
      imagePath: "/project/fixed/start.png",
      outDir: "/project/fixed-out"
    });

    expect(received?.job).toMatchObject({ outputs: 1, startFrame: "/project/fixed/start.png", ratio: "9:16", duration: 8 });
    expect(received?.outDir).toBe("/project/fixed-out");
  });

  it("preserves typed Flow errors for pause handling by the orchestrator", async () => {
    const { CreditLimitError } = await import("../src/errors.js");
    const failure = new CreditLimitError("quota reached");
    const automation: FlowAutomation = { runJob: vi.fn(async () => { throw failure; }) };

    await expect(new GoogleFlowSceneGenerator(automation).generate({
      episodeIndex: 1,
      sceneIndex: 1,
      scene: validCreativePlan().episodes[0].scenes[0],
      imagePath: "/project/start.jpg",
      outDir: "/project/out"
    })).rejects.toBe(failure);
  });
});
