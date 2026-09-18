import { readFile } from "node:fs/promises";
import {
  CreditLimitError,
  GenerationBlockedError,
  LoginRequiredError,
  ManualActionRequiredError,
  RateLimitedError,
  UiContractError
} from "../errors.js";
import type { GeminiMediaTransport } from "../shorts/gemini-transport.js";
import { buildCaptionCues, reconcileLyrics, renderAss } from "./captions.js";
import type { VisualClipGenerator } from "./flow-generator.js";
import type { GeneratedSong, MusicGenerator } from "./lyria-transport.js";
import { redactSensitiveText } from "./project-store.js";
import type { MusicVideoProjectStore } from "./project-store.js";
import type { MusicMediaProbe, MusicVideoRenderResult, RenderMusicVideoInput } from "./renderer.js";
import type { MusicVideoArtifact, MusicVideoJournal, MusicVideoProjectState, Storyboard } from "./schema.js";
import type { SongPlanner } from "./song-planner.js";
import type { StoryboardPlanner } from "./storyboard-planner.js";

export interface RunMusicVideoInput {
  root: string;
  topic: string;
  language: string;
  targetDurationSeconds: number;
  models: { text: string; image: string; music: string };
  resume: boolean;
  store: MusicVideoProjectStore;
  songPlanner: SongPlanner;
  musicGenerator: MusicGenerator;
  storyboardPlanner: StoryboardPlanner;
  imageGenerator: GeminiMediaTransport;
  flowGeneratorFactory: () => Promise<{ generator: VisualClipGenerator; close(): Promise<void> }>;
  probeMedia(path: string): Promise<MusicMediaProbe>;
  renderer(input: RenderMusicVideoInput): Promise<MusicVideoRenderResult>;
}

export interface MusicVideoRunResult extends MusicVideoRenderResult {
  stage: "READY";
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isPauseError(error: unknown): error is (
  LoginRequiredError | ManualActionRequiredError | CreditLimitError | RateLimitedError | UiContractError | GenerationBlockedError
) {
  return error instanceof LoginRequiredError || error instanceof ManualActionRequiredError ||
    error instanceof CreditLimitError || error instanceof RateLimitedError ||
    error instanceof UiContractError || error instanceof GenerationBlockedError;
}

function configMatches(input: RunMusicVideoInput, state: MusicVideoProjectState): boolean {
  return input.topic.trim() === state.topic && input.language.trim() === state.language &&
    input.targetDurationSeconds === state.targetDurationSeconds &&
    input.models.text === state.models.text && input.models.image === state.models.image && input.models.music === state.models.music;
}

async function loadOptionalJournal(store: MusicVideoProjectStore): Promise<MusicVideoJournal | undefined> {
  try {
    return await store.loadJournal();
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function updateStage(
  store: MusicVideoProjectStore,
  state: MusicVideoProjectState,
  stage: MusicVideoProjectState["stage"],
  message: string,
  extra: Partial<Pick<MusicVideoProjectState, "planHash" | "songHash" | "storyboardHash">> = {}
): Promise<MusicVideoProjectState> {
  const next = await store.saveState({ ...state, ...extra, stage });
  await store.appendEvent({ stage, message });
  return next;
}

async function loadReadyResult(store: MusicVideoProjectStore, journal: MusicVideoJournal): Promise<MusicVideoRunResult | undefined> {
  if (!journal.final || !(await store.artifactMatchesDisk(journal.final))) return undefined;
  try {
    const report = JSON.parse(await readFile(store.paths().mediaReport, "utf8")) as MusicVideoRenderResult;
    if (
      typeof report.duration !== "number" || typeof report.width !== "number" || typeof report.height !== "number" ||
      typeof report.sha256 !== "string" || report.outputPath !== store.paths().final
    ) return undefined;
    return { ...report, stage: "READY" };
  } catch {
    return undefined;
  }
}

function imagePathFor(store: MusicVideoProjectStore, artifact: MusicVideoArtifact): string {
  return store.resolveArtifactPath(artifact);
}

export async function runMusicVideo(input: RunMusicVideoInput): Promise<MusicVideoRunResult> {
  let state: MusicVideoProjectState;
  try {
    state = await input.store.load();
    if (!input.resume) throw new Error("A music-video project already exists; pass --resume to continue it");
    if (!configMatches(input, state)) throw new Error("Music-video configuration does not match the existing project");
  } catch (error) {
    if (!isNotFound(error)) throw error;
    if (input.resume) throw new Error("Cannot resume because the music-video project does not exist");
    state = await input.store.create({
      topic: input.topic,
      language: input.language,
      targetDurationSeconds: input.targetDurationSeconds,
      textModel: input.models.text,
      imageModel: input.models.image,
      musicModel: input.models.music
    });
  }

  let journal = await loadOptionalJournal(input.store);
  if (state.stage === "READY" && journal) {
    const ready = await loadReadyResult(input.store, journal);
    if (ready) return ready;
  }

  try {
    let plan;
    if (state.planHash) {
      plan = await input.store.loadPlan();
    } else {
      plan = await input.songPlanner.plan({
        topic: state.topic,
        language: state.language,
        model: state.models.text,
        targetDurationSeconds: state.targetDurationSeconds
      });
      const saved = await input.store.savePlan(plan);
      state = await updateStage(input.store, state, "SONG_PLANNED", "Song plan validated and saved", { planHash: saved.sha256 });
    }

    let song: GeneratedSong;
    let songArtifact: MusicVideoArtifact;
    if (journal?.song && await input.store.artifactMatchesDisk(journal.song)) {
      songArtifact = journal.song;
      song = {
        mimeType: "audio/mpeg",
        bytes: new Uint8Array(await readFile(input.store.paths().song)),
        outputText: (await readFile(input.store.paths().lyrics, "utf8")).trim()
      };
    } else if (state.songHash) {
      songArtifact = await input.store.recordArtifact(input.store.paths().song, "audio/mpeg");
      if (songArtifact.sha256 !== state.songHash) throw new Error("Recorded song hash does not match audio/song.mp3");
      song = {
        mimeType: "audio/mpeg",
        bytes: new Uint8Array(await readFile(input.store.paths().song)),
        outputText: (await readFile(input.store.paths().lyrics, "utf8")).trim()
      };
    } else {
      song = await input.musicGenerator.generate({ model: state.models.music, plan });
      reconcileLyrics(plan, song.outputText);
      songArtifact = await input.store.writeSong(song);
      await input.store.writeLyriaResponse({ outputText: song.outputText, ...(song.structureText ? { structureText: song.structureText } : {}) });
      state = await updateStage(input.store, state, "SONG_READY", "Generated song validated and saved", { songHash: songArtifact.sha256 });
    }

    const songProbe = await input.probeMedia(input.store.paths().song);
    if (!songProbe.hasAudio || !Number.isFinite(songProbe.duration) || songProbe.duration < 30 || songProbe.duration > 240) {
      throw new Error("Generated song does not contain a valid 30-240 second audio stream");
    }

    let storyboard: Storyboard;
    if (state.storyboardHash) {
      storyboard = await input.store.loadStoryboard();
    } else {
      storyboard = await input.storyboardPlanner.plan({ plan, durationSeconds: songProbe.duration, model: state.models.text });
      const saved = await input.store.saveStoryboard(storyboard);
      state = await updateStage(input.store, state, "STORYBOARDED", "Visual storyboard validated and saved", { storyboardHash: saved.sha256 });
    }

    if (!journal) {
      journal = await input.store.saveJournal({
        schemaVersion: 1,
        projectId: state.projectId,
        status: "STORYBOARDED",
        song: songArtifact,
        entries: storyboard.entries.map((entry) => ({ id: entry.id, status: "PENDING" })),
        updatedAt: new Date().toISOString()
      });
    }

    state = await updateStage(input.store, state, "ASSETS_GENERATING", "Generating storyboard assets");
    journal.status = "ASSETS_GENERATING";
    journal.song = songArtifact;
    await input.store.saveJournal(journal);

    for (const entry of storyboard.entries) {
      const record = journal.entries.find((candidate) => candidate.id === entry.id);
      if (!record) throw new Error(`Generation journal is missing ${entry.id}`);
      if (!record.image || !(await input.store.artifactMatchesDisk(record.image))) {
        const media = await input.imageGenerator.generateImage({
          model: state.models.image,
          prompt: [entry.visual, entry.motionPrompt, `Continuity: ${JSON.stringify(plan.continuity)}`].join("\n"),
          aspectRatio: "16:9"
        });
        record.image = await input.store.writeImage(entry.id, media);
      }
      record.status = entry.mode === "flow-video" ? "IMAGE_READY" : "COMPLETED";
      record.error = undefined;
      journal = await input.store.saveJournal(journal);
    }

    let ownedFlow: Awaited<ReturnType<RunMusicVideoInput["flowGeneratorFactory"]>> | undefined;
    try {
      for (const entry of storyboard.entries.filter((candidate) => candidate.mode === "flow-video")) {
        const record = journal.entries.find((candidate) => candidate.id === entry.id)!;
        if (record.video && await input.store.artifactMatchesDisk(record.video)) {
          record.status = "COMPLETED";
          continue;
        }
        ownedFlow ??= await input.flowGeneratorFactory();
        const imagePath = imagePathFor(input.store, record.image!);
        const generated = await ownedFlow.generator.generate({
          entry,
          startFramePath: imagePath,
          outDir: input.store.assetPaths(entry.id).directory
        });
        const clipProbe = await input.probeMedia(generated.path);
        if (!clipProbe.hasVideo) throw new Error(`Flow artifact for ${entry.id} has no video stream`);
        record.video = await input.store.writeVideo(entry.id, generated.path);
        record.status = "COMPLETED";
        record.error = undefined;
        journal = await input.store.saveJournal(journal);
      }
    } finally {
      await ownedFlow?.close();
    }

    const lyricCheck = reconcileLyrics(plan, song.outputText);
    if (!journal.captions || !(await input.store.artifactMatchesDisk(journal.captions))) {
      const captionBuild = buildCaptionCues(plan, songProbe.duration);
      journal.captions = await input.store.writeCaptions(renderAss(captionBuild.cues));
      await input.store.appendEvent({
        stage: "ASSETS_READY",
        message: `Lyrics reconciled at ${Math.round(lyricCheck.matchedRatio * 100)}%; caption timing is ${captionBuild.timing}`
      });
    }
    journal.status = "ASSETS_READY";
    journal = await input.store.saveJournal(journal);
    state = await updateStage(input.store, state, "ASSETS_READY", "All visual assets and captions are ready");

    if (journal.final && await input.store.artifactMatchesDisk(journal.final)) {
      const ready = await loadReadyResult(input.store, journal);
      if (ready) {
        state = await updateStage(input.store, state, "READY", "Existing final render verified");
        return ready;
      }
    }

    state = await updateStage(input.store, state, "RENDERING", "Rendering final music video");
    journal.status = "RENDERING";
    journal = await input.store.saveJournal(journal);
    const assets = Object.fromEntries(journal.entries.map((record) => [record.id, {
      imagePath: imagePathFor(input.store, record.image!),
      ...(record.video ? { videoPath: input.store.resolveArtifactPath(record.video) } : {})
    }]));
    const rendered = await input.renderer({
      storyboard,
      assets,
      songPath: input.store.paths().song,
      captionsPath: input.store.paths().captions,
      outputPath: input.store.paths().final,
      reportPath: input.store.paths().mediaReport
    });
    journal.final = await input.store.recordArtifact(rendered.outputPath, "video/mp4");
    journal.status = "READY";
    journal = await input.store.saveJournal(journal);
    state = await updateStage(input.store, state, "READY", "Final music video passed media validation");
    await input.store.clearActionRequired();
    return { ...rendered, stage: "READY" };
  } catch (error) {
    if (isPauseError(error)) {
      state = await input.store.saveState({ ...state, stage: "PAUSED" });
      if (journal) {
        journal.status = "PAUSED";
        await input.store.saveJournal(journal);
      }
      await input.store.writeActionRequired({
        code: error.code,
        message: redactSensitiveText(error.message),
        resumeCommand: "gflow music-video run --resume"
      });
      await input.store.appendEvent({ stage: "PAUSED", code: error.code, message: error.message });
    }
    throw error;
  }
}
