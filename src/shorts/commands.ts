import { access, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import { BROWSER_CHANNELS, DEFAULT_BROWSER_CHANNEL, type BrowserChannel } from "../browser/session.js";
import { CreditLimitError, GenerationBlockedError, LoginRequiredError, ManualActionRequiredError, RateLimitedError, UiContractError } from "../errors.js";
import type { FlowAutomation } from "../flow/types.js";
import { GoogleFlowSceneGenerator, type SceneGenerator } from "./flow-generator.js";
import { generateShortsProject } from "./generation-service.js";
import { GenerationJournalStore } from "./generation-journal.js";
import { GoogleGeminiTransport, type GeminiMediaTransport } from "./gemini-transport.js";
import { planShortsProject } from "./plan-service.js";
import { GeminiStoryPlanner, type StoryPlanner } from "./planner.js";
import { ProjectStore, type ProjectState } from "./project-store.js";
import { parseCreativePlan } from "./schema.js";
import { SHORTS_EPISODE_COUNT, SHORTS_SCENE_COUNT } from "./schema.js";

const DEFAULT_LANGUAGE = "vi-VN";
const DEFAULT_TEXT_MODEL = "gemini-3.5-flash";
const DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";
const DEFAULT_TTS_MODEL = "gemini-2.5-flash-preview-tts";

export interface ShortsCommandDependencies {
  environment?: NodeJS.ProcessEnv;
  storyPlanner?: StoryPlanner;
  shortsMedia?: GeminiMediaTransport;
  shortsSceneGenerator?: SceneGenerator;
  flowAutomationFactory?: (options: { profile: string; headed: boolean; browser: BrowserChannel }) => Promise<{ automation: FlowAutomation; close(): Promise<void> }>;
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

interface GenerateCommandOptions {
  resume: boolean;
  profile: string;
  headed: boolean;
  browser: string;
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

  shorts
    .command("generate")
    .description("Generate and checkpoint images, narration, and Flow clips for a planned project.")
    .argument("<project-json>", "path to project.json")
    .option("--resume", "resume an existing generation journal", false)
    .option("--profile <name>", "Google Chrome profile to use for Flow", "default")
    .option("--browser <name>", "browser channel for Flow automation", DEFAULT_BROWSER_CHANNEL)
    .option("--headed", "show browser", true)
    .option("--no-headed", "run browser headless")
    .action(async (projectJson: string, command: GenerateCommandOptions) => {
      const statePath = resolve(process.cwd(), projectJson);
      const root = dirname(statePath);
      const store = new ProjectStore(root);
      if (statePath !== store.paths().state) throw new Error("Expected the project's project.json path, not a manifest path");

      const project: ProjectState = await store.load();
      if (project.stage !== "PLANNED" || !project.planHash) throw new Error("Shorts project must be PLANNED before generation");
      const plan = parseCreativePlan(JSON.parse(await readFile(store.paths().plan, "utf8")) as unknown);
      if (plan.topic !== project.topic) throw new Error("Creative plan topic does not match project state");
      if (!BROWSER_CHANNELS.includes(command.browser as BrowserChannel)) {
        throw new Error(`Browser must be one of: ${BROWSER_CHANNELS.join(", ")}`);
      }

      const media = resolveMedia(dependencies);
      const journalPath = new GenerationJournalStore(root);
      try {
        await access(join(root, "generation.json"));
        if (!command.resume) throw new Error("A generation journal already exists; pass --resume to continue it");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      let owned: { automation: FlowAutomation; close(): Promise<void> } | undefined;
      try {
        let sceneGenerator = dependencies.shortsSceneGenerator;
        if (!sceneGenerator) {
          if (!dependencies.flowAutomationFactory) throw new Error("Flow automation is not configured");
          owned = await dependencies.flowAutomationFactory({
            profile: command.profile,
            headed: command.headed,
            browser: command.browser as BrowserChannel
          });
          sceneGenerator = new GoogleFlowSceneGenerator(owned.automation);
        }

        const result = await generateShortsProject({
          root,
          project,
          plan,
          journalStore: journalPath,
          gemini: media,
          sceneGenerator,
          resume: command.resume
        });
        const completed = result.scenes.filter((scene) => scene.status === "COMPLETED").length;
        console.log(`generation ${result.status.toLowerCase()}: ${completed}/${result.scenes.length} scenes complete`);
        console.log(`journal ${root}/generation.json`);
      } catch (error) {
        if (
          error instanceof LoginRequiredError || error instanceof ManualActionRequiredError ||
          error instanceof CreditLimitError || error instanceof RateLimitedError ||
          error instanceof UiContractError || error instanceof GenerationBlockedError
        ) console.error(`Generation paused. Review ${root}/action-required.json, resolve it manually, then run again with --resume.`);
        throw error;
      } finally {
        await owned?.close();
      }
    });
}

function resolveMedia(dependencies: ShortsCommandDependencies): GeminiMediaTransport {
  if (dependencies.shortsMedia) return dependencies.shortsMedia;
  const apiKey = (dependencies.environment ?? process.env).GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is required for shorts generation");
  return new GoogleGeminiTransport({ apiKey });
}
