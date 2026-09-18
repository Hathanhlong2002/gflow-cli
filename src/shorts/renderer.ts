import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { RenderError } from "../errors.js";
import { SHORTS_EPISODE_COUNT, SHORTS_SCENE_COUNT } from "./schema.js";

export interface MediaProbeStream {
  codecType: "video" | "audio" | "other";
  codecName?: string;
  width?: number;
  height?: number;
  rFrameRate?: string;
  sampleRate?: number;
  channels?: number;
}

export interface MediaProbeResult {
  duration: number;
  size: number;
  bitRate?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  streams: MediaProbeStream[];
}

export interface MergeClipsOptions {
  clipPaths: string[];
  outputPath: string;
  targetWidth?: number;
  targetHeight?: number;
  fps?: number;
  narrationAudioPath?: string;
  duckingVolume?: number;
  narrationVolume?: number;
  timeoutMs?: number;
}

export interface MergeResult {
  outputPath: string;
  duration: number;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
}

export interface EpisodeRenderOptions {
  projectRoot: string;
  episodeIndex: number;
  outputPath?: string;
  timeoutMs?: number;
}

export interface EpisodeRenderResult extends MergeResult {
  episodeIndex: number;
  sceneCount: number;
  mediaReportPath: string;
}

export interface ProjectRenderOptions {
  projectRoot: string;
  episodeIndex?: number;
  timeoutMs?: number;
}

export interface ProjectRenderResult {
  projectRoot: string;
  episodes: EpisodeRenderResult[];
}

function runProcess(
  command: string,
  args: string[],
  timeoutMs = 180_000
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { shell: false });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new RenderError(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ENOENT") {
        rejectPromise(new RenderError(`${command} is not installed or not found in PATH`));
      } else {
        rejectPromise(new RenderError(`${command} execution failed: ${err.message}`));
      }
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectPromise(new RenderError(`${command} exited with code ${code}: ${stderr.trim()}`));
      } else {
        resolvePromise({ stdout, stderr });
      }
    });
  });
}

export async function probeMedia(filePath: string): Promise<MediaProbeResult> {
  const absolutePath = resolve(filePath);
  try {
    await access(absolutePath);
  } catch {
    throw new RenderError(`Media file does not exist or cannot be read: ${absolutePath}`);
  }

  const { stdout } = await runProcess("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration,size,bit_rate:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
    "-of",
    "json",
    absolutePath
  ]);

  interface FfprobeRawOutput {
    format?: { duration?: string; size?: string; bit_rate?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      sample_rate?: string;
      channels?: number;
    }>;
  }

  const data = JSON.parse(stdout) as FfprobeRawOutput;
  const streams: MediaProbeStream[] = (data.streams ?? []).map((s) => ({
    codecType: s.codec_type === "video" ? "video" : s.codec_type === "audio" ? "audio" : "other",
    codecName: s.codec_name,
    width: s.width,
    height: s.height,
    rFrameRate: s.r_frame_rate,
    sampleRate: s.sample_rate ? Number.parseInt(s.sample_rate, 10) : undefined,
    channels: s.channels
  }));

  const videoStream = streams.find((s) => s.codecType === "video");
  const audioStream = streams.find((s) => s.codecType === "audio");
  const duration = data.format?.duration ? Number.parseFloat(data.format.duration) : 0;
  const size = data.format?.size ? Number.parseInt(data.format.size, 10) : 0;

  return {
    duration,
    size,
    bitRate: data.format?.bit_rate ? Number.parseInt(data.format.bit_rate, 10) : undefined,
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
    width: videoStream?.width,
    height: videoStream?.height,
    streams
  };
}

export async function mergeClips(options: MergeClipsOptions): Promise<MergeResult> {
  const {
    clipPaths,
    outputPath,
    targetWidth = 1080,
    targetHeight = 1920,
    fps = 30,
    narrationAudioPath,
    duckingVolume = 0.25,
    narrationVolume = 1.0,
    timeoutMs = 300_000
  } = options;

  if (!clipPaths || clipPaths.length === 0) {
    throw new RenderError("No input clips provided for merging");
  }

  const resolvedClipPaths = clipPaths.map((p) => resolve(p));
  const resolvedOutputPath = resolve(outputPath);

  // Probe all input clips
  const clipProbes = await Promise.all(resolvedClipPaths.map((p) => probeMedia(p)));

  for (let i = 0; i < clipProbes.length; i += 1) {
    if (!clipProbes[i].hasVideo) {
      throw new RenderError(`Input clip has no video stream: ${resolvedClipPaths[i]}`);
    }
  }

  // Check optional narration audio
  let hasNarration = false;
  if (narrationAudioPath) {
    const resolvedNarration = resolve(narrationAudioPath);
    try {
      await access(resolvedNarration);
      const narrationProbe = await probeMedia(resolvedNarration);
      if (narrationProbe.hasAudio) {
        hasNarration = true;
      }
    } catch {
      // Narration not accessible, proceed without narration
      hasNarration = false;
    }
  }

  // Build FFmpeg command arguments with shell: false
  const args: string[] = ["-y", "-hide_banner", "-v", "error"];

  // Add all input clips
  for (const clipPath of resolvedClipPaths) {
    args.push("-i", clipPath);
  }

  const narrationInputIndex = resolvedClipPaths.length;
  if (hasNarration && narrationAudioPath) {
    args.push("-i", resolve(narrationAudioPath));
  }

  // Build filter_complex
  const filterParts: string[] = [];
  const concatInputs: string[] = [];

  for (let i = 0; i < clipProbes.length; i += 1) {
    const probe = clipProbes[i];
    // Video normalization
    filterParts.push(
      `[${i}:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[v${i}]`
    );

    // Audio normalization (or silent fallback if clip has no audio)
    if (probe.hasAudio) {
      filterParts.push(`[${i}:a]aformat=sample_rates=48000:channel_layouts=stereo[a${i}]`);
    } else {
      const clipDuration = probe.duration > 0 ? probe.duration : 8;
      filterParts.push(
        `anullsrc=channel_layout=stereo:sample_rate=48000:d=${clipDuration}[a${i}]`
      );
    }

    concatInputs.push(`[v${i}][a${i}]`);
  }

  // Concat all normalized clips
  filterParts.push(
    `${concatInputs.join("")}concat=n=${clipProbes.length}:v=1:a=1[concatv][concata]`
  );

  let finalAudioLabel = "[concata]";
  if (hasNarration) {
    // Duck scene audio and mix with narration
    filterParts.push(
      `[concata]volume=${duckingVolume}[bg_audio]`,
      `[${narrationInputIndex}:a]volume=${narrationVolume}[narr_audio]`,
      `[bg_audio][narr_audio]amix=inputs=2:duration=first:dropout_transition=2[mixeda]`
    );
    finalAudioLabel = "[mixeda]";
  }

  args.push(
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    "[concatv]",
    "-map",
    finalAudioLabel,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-movflags",
    "+faststart"
  );

  await mkdir(dirname(resolvedOutputPath), { recursive: true, mode: 0o700 });
  const temporaryOutputPath = join(
    dirname(resolvedOutputPath),
    `.${basename(resolvedOutputPath)}.${randomUUID()}.tmp.mp4`
  );
  args.push(temporaryOutputPath);

  try {
    await runProcess("ffmpeg", args, timeoutMs);
    await rename(temporaryOutputPath, resolvedOutputPath);
  } catch (error) {
    await unlink(temporaryOutputPath).catch(() => undefined);
    throw error;
  }

  const outputProbe = await probeMedia(resolvedOutputPath);
  const fileBytes = await readFile(resolvedOutputPath);
  const sha256 = createHash("sha256").update(fileBytes).digest("hex");

  return {
    outputPath: resolvedOutputPath,
    duration: outputProbe.duration,
    bytes: fileBytes.byteLength,
    sha256,
    width: outputProbe.width ?? targetWidth,
    height: outputProbe.height ?? targetHeight
  };
}

export async function renderEpisode(options: EpisodeRenderOptions): Promise<EpisodeRenderResult> {
  const root = resolve(options.projectRoot);
  const epPad = String(options.episodeIndex).padStart(2, "0");
  const episodeDir = join(root, "episodes", epPad);

  // Discover scene clips
  const clipPaths: string[] = [];
  const sceneNarrationPaths: string[] = [];

  for (let sceneIndex = 1; sceneIndex <= SHORTS_SCENE_COUNT; sceneIndex += 1) {
    const scPad = String(sceneIndex).padStart(2, "0");
    const sceneClip = join(episodeDir, "scenes", scPad, "clip.mp4");
    const sceneNarration = join(episodeDir, "scenes", scPad, "narration.wav");

    try {
      await access(sceneClip);
      clipPaths.push(sceneClip);
      try {
        await access(sceneNarration);
        sceneNarrationPaths.push(sceneNarration);
      } catch {
        // narration optional
      }
    } catch {
      // Scene clip not found; continue checking
    }
  }

  if (clipPaths.length === 0) {
    throw new RenderError(`No scene clips found for episode ${options.episodeIndex} in ${episodeDir}`);
  }

  // Check if an episode-level narration exists, or if scene narrations can be concatenated
  const episodeNarrationPath = join(episodeDir, "narration.wav");
  let resolvedNarration: string | undefined;

  try {
    await access(episodeNarrationPath);
    resolvedNarration = episodeNarrationPath;
  } catch {
    // If scene narration files exist for all found clips, concatenate them into episode narration
    if (sceneNarrationPaths.length === clipPaths.length && sceneNarrationPaths.length > 0) {
      try {
        await concatAudioFiles(sceneNarrationPaths, episodeNarrationPath);
        resolvedNarration = episodeNarrationPath;
      } catch {
        resolvedNarration = undefined;
      }
    }
  }

  const defaultOutputPath = join(episodeDir, "final.mp4");
  const targetOutputPath = options.outputPath ? resolve(options.outputPath) : defaultOutputPath;

  const result = await mergeClips({
    clipPaths,
    outputPath: targetOutputPath,
    narrationAudioPath: resolvedNarration,
    timeoutMs: options.timeoutMs
  });

  const mediaReportPath = join(episodeDir, "media-report.json");
  const report = {
    episodeIndex: options.episodeIndex,
    outputPath: relative(root, targetOutputPath),
    durationSeconds: result.duration,
    width: result.width,
    height: result.height,
    sceneCount: clipPaths.length,
    bytes: result.bytes,
    sha256: result.sha256,
    renderedAt: new Date().toISOString()
  };

  await writeFile(mediaReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return {
    ...result,
    episodeIndex: options.episodeIndex,
    sceneCount: clipPaths.length,
    mediaReportPath
  };
}

export async function renderShortsProject(
  options: ProjectRenderOptions
): Promise<ProjectRenderResult> {
  const root = resolve(options.projectRoot);
  const episodes: EpisodeRenderResult[] = [];

  if (options.episodeIndex !== undefined) {
    const epResult = await renderEpisode({
      projectRoot: root,
      episodeIndex: options.episodeIndex,
      timeoutMs: options.timeoutMs
    });
    episodes.push(epResult);
  } else {
    for (let ep = 1; ep <= SHORTS_EPISODE_COUNT; ep += 1) {
      const epDir = join(root, "episodes", String(ep).padStart(2, "0"));
      try {
        const stats = await stat(epDir);
        if (!stats.isDirectory()) continue;
      } catch {
        continue;
      }

      try {
        const epResult = await renderEpisode({
          projectRoot: root,
          episodeIndex: ep,
          timeoutMs: options.timeoutMs
        });
        episodes.push(epResult);
      } catch (error) {
        // If an episode has no scenes yet, skip it gracefully when rendering full project
        if (error instanceof RenderError && error.message.includes("No scene clips found")) {
          continue;
        }
        throw error;
      }
    }
  }

  if (episodes.length === 0) {
    throw new RenderError(`No renderable episodes found in project at ${root}`);
  }

  return {
    projectRoot: root,
    episodes
  };
}

async function concatAudioFiles(inputPaths: string[], outputPath: string): Promise<void> {
  if (inputPaths.length === 0) return;
  if (inputPaths.length === 1) {
    const bytes = await readFile(inputPaths[0]);
    await writeFile(outputPath, bytes);
    return;
  }

  const args: string[] = ["-y", "-hide_banner", "-v", "error"];
  for (const path of inputPaths) {
    args.push("-i", path);
  }

  const filterInputs = inputPaths.map((_, i) => `[${i}:a]`).join("");
  args.push(
    "-filter_complex",
    `${filterInputs}concat=n=${inputPaths.length}:v=0:a=1[outa]`,
    "-map",
    "[outa]",
    "-c:a",
    "pcm_s16le",
    "-ar",
    "24000",
    outputPath
  );

  await runProcess("ffmpeg", args, 60_000);
}
