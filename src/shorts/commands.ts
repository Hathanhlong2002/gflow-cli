import { resolve } from "node:path";
import type { Command } from "commander";
import { GoogleGeminiTransport } from "./gemini-transport.js";
import { planShortsProject } from "./plan-service.js";
import { GeminiStoryPlanner, type StoryPlanner } from "./planner.js";
import { ProjectStore } from "./project-store.js";
import { SHORTS_EPISODE_COUNT, SHORTS_SCENE_COUNT } from "./schema.js";

const DEFAULT_LANGUAGE = "vi-VN";
const DEFAULT_TEXT_MODEL = "gemini-2.5-flash";
const DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";
const DEFAULT_TTS_MODEL = "gemini-2.5-flash-preview-tts";

export interface ShortsCommandDependencies {
  environment?: NodeJS.ProcessEnv;
  storyPlanner?: StoryPlanner;
}

interface PlanCommandOptions {
  topic: string;
  out: string;
  language: string;
  textModel: string;
  imageModel: string;
  ttsModel: string;
  force: boolean;
}

function resolvePlanner(dependencies: ShortsCommandDependencies): StoryPlanner {
  if (dependencies.storyPlanner) return dependencies.storyPlanner;
  const apiKey = (dependencies.environment ?? process.env).GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is required for shorts planning");
  return new GeminiStoryPlanner(new GoogleGeminiTransport({ apiKey }));
}

export function registerShortsCommands(program: Command, dependencies: ShortsCommandDependencies = {}): void {
  const shorts = program.command("shorts").description("Plan, generate, render, and publish vertical short-video series.");

  shorts
    .command("plan")
    .description("Turn one topic into a validated 10-episode creative manifest with Gemini.")
    .requiredOption("--topic <text>", "series topic")
    .requiredOption("--out <path>", "project output directory")
    .option("--language <tag>", "viewer-facing language", DEFAULT_LANGUAGE)
    .option("--text-model <name>", "Gemini structured-output model", DEFAULT_TEXT_MODEL)
    .option("--image-model <name>", "Gemini scene-image model for later stages", DEFAULT_IMAGE_MODEL)
    .option("--tts-model <name>", "Gemini narration model for later stages", DEFAULT_TTS_MODEL)
    .option("--force", "replace an existing creative plan", false)
    .action(async (command: PlanCommandOptions) => {
      const planner = resolvePlanner(dependencies);
      const outputDir = resolve(process.cwd(), command.out);
      const store = new ProjectStore(outputDir);
      const state = await planShortsProject({
        config: {
          topic: command.topic,
          language: command.language,
          textModel: command.textModel,
          imageModel: command.imageModel,
          ttsModel: command.ttsModel
        },
        store,
        planner,
        force: command.force
      });

      console.log(`planned ${SHORTS_EPISODE_COUNT} episodes (${SHORTS_SCENE_COUNT} scenes each)`);
      console.log(`stage ${state.stage}`);
      console.log(`manifest ${store.paths().plan}`);
    });
}
