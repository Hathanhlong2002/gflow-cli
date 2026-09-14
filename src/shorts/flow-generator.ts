import type { FlowAutomation, FlowArtifact } from "../flow/types.js";
import { parseVideoJob } from "../jobs/schema.js";
import type { ScenePlan } from "./schema.js";

export interface GenerateSceneInput {
  episodeIndex: number;
  sceneIndex: number;
  scene: ScenePlan;
  outDir: string;
}

export interface SceneGenerator {
  generate(input: GenerateSceneInput): Promise<FlowArtifact>;
}

export class GoogleFlowSceneGenerator implements SceneGenerator {
  constructor(private readonly automation: FlowAutomation) {}

  async generate(input: GenerateSceneInput): Promise<FlowArtifact> {
    const episodeIndex = assertIndex(input.episodeIndex, "episode");
    const sceneIndex = assertIndex(input.sceneIndex, "scene");
    const id = `ep-${String(episodeIndex).padStart(2, "0")}-scene-${String(sceneIndex).padStart(2, "0")}`;
    const job = parseVideoJob({
      id,
      type: "video",
      prompt: `${input.scene.visual}\n${input.scene.motionPrompt}`,
      ratio: "9:16",
      duration: 8,
      outputs: 1
    });

    const result = await this.automation.runJob({ job, outDir: input.outDir });
    if (result.artifacts.length !== 1) {
      throw new Error(`Flow must return exactly one video artifact for ${id}`);
    }
    return result.artifacts[0];
  }
}

function assertIndex(value: number, kind: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error(`${kind} index must be an integer from 1 to 10`);
  }
  return value;
}
