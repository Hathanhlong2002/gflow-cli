import { resolve } from "node:path";
import { InvalidArgumentError } from "commander";
import type { Command } from "commander";
import { BROWSER_CHANNELS, DEFAULT_BROWSER_CHANNEL, type BrowserChannel } from "../browser/session.js";
import type { FlowAutomation } from "../flow/types.js";
import { GoogleGeminiTransport, type GeminiMediaTransport } from "../shorts/gemini-transport.js";
import { MusicVideoFlowGenerator } from "./flow-generator.js";
import { GoogleLyriaTransport, type MusicGenerator } from "./lyria-transport.js";
import { runMusicVideo, type RunMusicVideoInput } from "./orchestrator.js";
import { MusicVideoProjectStore } from "./project-store.js";
import { probeMusicMedia, renderMusicVideo } from "./renderer.js";
import { GeminiSongPlanner, type SongPlanner } from "./song-planner.js";
import { GeminiStoryboardPlanner, type StoryboardPlanner } from "./storyboard-planner.js";

const DEFAULT_LANGUAGE = "vi-VN";
const DEFAULT_DURATION_SECONDS = 180;
const DEFAULT_TEXT_MODEL = "gemini-3.5-flash";
const DEFAULT_IMAGE_MODEL = "gemini-2.5-flash-image";
const DEFAULT_MUSIC_MODEL = "lyria-3.5";

type MusicVideoRunner = (input: RunMusicVideoInput) => ReturnType<typeof runMusicVideo>;

export interface MusicVideoCommandDependencies {
  environment?: NodeJS.ProcessEnv;
  musicVideoRunner?: MusicVideoRunner;
  musicVideoSongPlanner?: SongPlanner;
  musicVideoMusicGenerator?: MusicGenerator;
  musicVideoStoryboardPlanner?: StoryboardPlanner;
  musicVideoMedia?: GeminiMediaTransport;
  musicVideoProbe?: RunMusicVideoInput["probeMedia"];
  musicVideoRenderer?: RunMusicVideoInput["renderer"];
  flowAutomationFactory?: (options: {
    profile: string;
    headed: boolean;
    browser: BrowserChannel;
  }) => Promise<{ automation: FlowAutomation; close(): Promise<void> }>;
}

interface RunCommandOptions {
  topic: string;
  out: string;
  language: string;
  duration: number;
  textModel: string;
  imageModel: string;
  musicModel: string;
  resume: boolean;
  profile: string;
  headed: boolean;
  browser: BrowserChannel;
}

function parseDuration(value: string): number {
  if (!/^\d+$/.test(value)) throw new InvalidArgumentError("must be an integer from 30 to 240 seconds");
  const duration = Number.parseInt(value, 10);
  if (duration < 30 || duration > 240) throw new InvalidArgumentError("must be an integer from 30 to 240 seconds");
  return duration;
}

function parseBrowser(value: string): BrowserChannel {
  if (!BROWSER_CHANNELS.includes(value as BrowserChannel)) {
    throw new InvalidArgumentError(`must be one of: ${BROWSER_CHANNELS.join(", ")}`);
  }
  return value as BrowserChannel;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function registerMusicVideoCommands(program: Command, dependencies: MusicVideoCommandDependencies = {}): void {
  const musicVideo = program.command("music-video").description("Create a complete widescreen vocal music video from one topic.");

  musicVideo
    .command("run")
    .description("Plan a song, generate music and visuals, then render a resumable 16:9 video.")
    .requiredOption("--topic <text>", "song topic")
    .requiredOption("--out <path>", "project output directory")
    .option("--language <tag>", "lyrics and viewer-facing language", DEFAULT_LANGUAGE)
    .option("--duration <seconds>", "target song duration", parseDuration, DEFAULT_DURATION_SECONDS)
    .option("--text-model <name>", "Gemini planning model", DEFAULT_TEXT_MODEL)
    .option("--image-model <name>", "Gemini image model", DEFAULT_IMAGE_MODEL)
    .option("--music-model <name>", "Google music model", DEFAULT_MUSIC_MODEL)
    .option("--resume", "resume a checkpointed run", false)
    .option("--profile <name>", "Google Chrome profile to use for Flow", "default")
    .option("--browser <name>", "browser channel for Flow automation", parseBrowser, DEFAULT_BROWSER_CHANNEL)
    .option("--headed", "show browser", true)
    .option("--no-headed", "run browser headless")
    .action(async (command: RunCommandOptions) => {
      const apiKey = (dependencies.environment ?? process.env).GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY is required for music-video generation");
      if (!dependencies.flowAutomationFactory) throw new Error("Flow automation is not configured");

      const gemini = new GoogleGeminiTransport({ apiKey });
      const store = new MusicVideoProjectStore(resolve(process.cwd(), command.out));
      const abortController = new AbortController();
      const abort = () => abortController.abort(new DOMException("Music-video run interrupted", "AbortError"));
      process.once("SIGINT", abort);
      process.once("SIGTERM", abort);
      const resumeCommand = [
        "gflow music-video run",
        `--topic ${shellQuote(command.topic)}`,
        `--out ${shellQuote(store.paths().root)}`,
        `--language ${shellQuote(command.language)}`,
        `--duration ${command.duration}`,
        `--text-model ${shellQuote(command.textModel)}`,
        `--image-model ${shellQuote(command.imageModel)}`,
        `--music-model ${shellQuote(command.musicModel)}`,
        `--profile ${shellQuote(command.profile)}`,
        `--browser ${command.browser}`,
        command.headed ? "--headed" : "--no-headed",
        "--resume"
      ].join(" ");
      try {
        const result = await (dependencies.musicVideoRunner ?? runMusicVideo)({
          root: store.paths().root,
          topic: command.topic,
          language: command.language,
          targetDurationSeconds: command.duration,
          models: { text: command.textModel, image: command.imageModel, music: command.musicModel },
          resume: command.resume,
          store,
          songPlanner: dependencies.musicVideoSongPlanner ?? new GeminiSongPlanner(gemini),
          musicGenerator: dependencies.musicVideoMusicGenerator ?? new GoogleLyriaTransport({ apiKey }),
          storyboardPlanner: dependencies.musicVideoStoryboardPlanner ?? new GeminiStoryboardPlanner(gemini),
          imageGenerator: dependencies.musicVideoMedia ?? gemini,
          flowGeneratorFactory: async () => {
            const owned = await dependencies.flowAutomationFactory!({
              profile: command.profile,
              headed: command.headed,
              browser: command.browser
            });
            return { generator: new MusicVideoFlowGenerator(owned.automation), close: owned.close };
          },
          probeMedia: dependencies.musicVideoProbe ?? probeMusicMedia,
          renderer: dependencies.musicVideoRenderer ?? renderMusicVideo,
          resumeCommand,
          signal: abortController.signal
        });

        console.log(`music video ready: ${result.outputPath}`);
        console.log(`${result.duration.toFixed(1)}s, ${result.width}x${result.height}, captions ${result.captionMode}`);
      } finally {
        process.off("SIGINT", abort);
        process.off("SIGTERM", abort);
      }
    });
}
