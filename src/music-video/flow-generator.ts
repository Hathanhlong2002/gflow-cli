import { z } from "zod";
import type { FlowArtifact, FlowAutomation } from "../flow/types.js";
import { parseVideoJob } from "../jobs/schema.js";
import { storyboardEntrySchema, type StoryboardEntry } from "./schema.js";

export interface GenerateVisualClipInput {
  entry: StoryboardEntry;
  startFramePath: string;
  outDir: string;
}

export interface VisualClipGenerator {
  generate(input: GenerateVisualClipInput): Promise<FlowArtifact>;
}

export class MusicVideoFlowGenerator implements VisualClipGenerator {
  constructor(private readonly automation: FlowAutomation) {}

  async generate(input: GenerateVisualClipInput): Promise<FlowArtifact> {
    const entry = storyboardEntrySchema.parse(input.entry);
    if (entry.mode !== "flow-video") throw new Error(`${entry.id} is not selected for Flow video generation`);
    const startFrame = z.string().trim().min(1).parse(input.startFramePath);
    const outDir = z.string().trim().min(1).parse(input.outDir);
    const job = parseVideoJob({
      id: `music-${entry.id}`,
      type: "video",
      prompt: `${entry.visual}\n${entry.motionPrompt}`,
      ratio: "16:9",
      duration: 8,
      startFrame,
      outputs: 1
    });
    const result = await this.automation.runJob({ job, outDir });
    if (result.artifacts.length !== 1) {
      throw new Error(`Flow must return exactly one video artifact for ${entry.id}`);
    }
    return result.artifacts[0];
  }
}
