import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { z } from "zod";
import { RenderError } from "../errors.js";
import type { Storyboard } from "./schema.js";

export interface MusicMediaStream {
  codecType: "video" | "audio" | "other";
  codecName?: string;
  width?: number;
  height?: number;
  rFrameRate?: string;
  sampleRate?: number;
  channels?: number;
}

export interface MusicMediaProbe {
  duration: number;
  size: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  streams: MusicMediaStream[];
}

export interface VisualAssetPaths {
  imagePath: string;
  videoPath?: string;
}

export interface RenderMusicVideoInput {
  storyboard: Storyboard;
  assets: Record<string, VisualAssetPaths>;
  songPath: string;
  captionsPath: string;
  outputPath: string;
  reportPath: string;
  targetWidth?: number;
  targetHeight?: number;
  fps?: number;
  timeoutMs?: number;
}

export interface MusicVideoRenderResult {
  outputPath: string;
  reportPath: string;
  duration: number;
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  captionMode: "burned" | "embedded";
}

interface ProcessOptions {
  timeoutMs: number;
  cwd?: string;
}

function runProcess(command: string, args: string[], options: ProcessOptions): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { shell: false, cwd: options.cwd });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finishReject(new RenderError(`${command} timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finishReject(new RenderError(error.code === "ENOENT"
        ? `${command} is not installed or not found in PATH`
        : `${command} execution failed: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (code !== 0) rejectPromise(new RenderError(`${command} exited with code ${code}: ${stderr.trim()}`));
      else resolvePromise({ stdout, stderr });
    });
  });
}

export async function probeMusicMedia(filePath: string): Promise<MusicMediaProbe> {
  const path = resolve(filePath);
  try {
    await access(path);
  } catch {
    throw new RenderError(`Media file does not exist or cannot be read: ${path}`);
  }
  const { stdout } = await runProcess("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels",
    "-of", "json",
    path
  ], { timeoutMs: 30_000 });

  const rawSchema = z.object({
    format: z.object({ duration: z.string().optional(), size: z.string().optional() }).passthrough().optional(),
    streams: z.array(z.object({
      codec_type: z.string().optional(),
      codec_name: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      r_frame_rate: z.string().optional(),
      sample_rate: z.string().optional(),
      channels: z.number().optional()
    }).passthrough()).optional()
  }).passthrough();
  let raw: z.infer<typeof rawSchema>;
  try {
    raw = rawSchema.parse(JSON.parse(stdout) as unknown);
  } catch {
    throw new RenderError("FFprobe returned invalid JSON");
  }
  const streams: MusicMediaStream[] = (raw.streams ?? []).map((stream) => ({
    codecType: stream.codec_type === "video" ? "video" : stream.codec_type === "audio" ? "audio" : "other",
    codecName: stream.codec_name,
    width: stream.width,
    height: stream.height,
    rFrameRate: stream.r_frame_rate,
    sampleRate: stream.sample_rate ? Number.parseInt(stream.sample_rate, 10) : undefined,
    channels: stream.channels
  }));
  const video = streams.find((stream) => stream.codecType === "video");
  return {
    duration: raw.format?.duration ? Number.parseFloat(raw.format.duration) : 0,
    size: raw.format?.size ? Number.parseInt(raw.format.size, 10) : 0,
    hasVideo: streams.some((stream) => stream.codecType === "video"),
    hasAudio: streams.some((stream) => stream.codecType === "audio"),
    width: video?.width,
    height: video?.height,
    streams
  };
}

async function atomicWriteText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

function validateTimeline(storyboard: Storyboard): void {
  if (!Number.isFinite(storyboard.durationSeconds) || storyboard.durationSeconds <= 0 || storyboard.entries.length === 0) {
    throw new RenderError("Storyboard duration and entries are required");
  }
  storyboard.entries.forEach((entry, index) => {
    const expectedStart = index === 0 ? 0 : storyboard.entries[index - 1].endSeconds;
    if (Math.abs(entry.startSeconds - expectedStart) > 0.01 || entry.endSeconds <= entry.startSeconds) {
      throw new RenderError(`Storyboard timeline is not continuous at ${entry.id}`);
    }
  });
  if (Math.abs(storyboard.entries.at(-1)!.endSeconds - storyboard.durationSeconds) > 0.01) {
    throw new RenderError("Storyboard timeline does not cover the song duration");
  }
}

function fadeFilters(duration: number): string {
  const fadeDuration = Math.min(0.2, duration / 4);
  const fadeOutStart = Math.max(0, duration - fadeDuration);
  return `fade=t=in:st=0:d=${fadeDuration.toFixed(3)},fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeDuration.toFixed(3)}`;
}

async function supportsFfmpegFilter(name: string): Promise<boolean> {
  const safeName = z.string().regex(/^[a-z0-9_]+$/).parse(name);
  const { stdout } = await runProcess("ffmpeg", ["-hide_banner", "-filters"], { timeoutMs: 30_000 });
  return new RegExp(`^\\s*[TSC.]{3}\\s+${safeName}\\s+`, "m").test(stdout);
}

export async function renderMusicVideo(input: RenderMusicVideoInput): Promise<MusicVideoRenderResult> {
  validateTimeline(input.storyboard);
  const width = z.number().int().min(320).max(7680).parse(input.targetWidth ?? 1920);
  const height = z.number().int().min(240).max(4320).parse(input.targetHeight ?? 1080);
  const fps = z.number().int().min(1).max(120).parse(input.fps ?? 30);
  const timeoutMs = z.number().int().positive().max(3_600_000).parse(input.timeoutMs ?? 600_000);
  const songPath = resolve(input.songPath);
  const captionsPath = resolve(input.captionsPath);
  const outputPath = resolve(input.outputPath);
  const reportPath = resolve(input.reportPath);

  await access(songPath).catch(() => { throw new RenderError(`Song file does not exist: ${songPath}`); });
  await access(captionsPath).catch(() => { throw new RenderError(`Caption file does not exist: ${captionsPath}`); });
  if (basename(captionsPath) !== "lyrics.ass") throw new RenderError("Caption filename must be lyrics.ass");

  const args: string[] = ["-y", "-hide_banner", "-v", "error"];
  const filterParts: string[] = [];
  const concatLabels: string[] = [];

  for (let index = 0; index < input.storyboard.entries.length; index += 1) {
    const entry = input.storyboard.entries[index];
    const asset = input.assets[entry.id];
    if (!asset?.imagePath) throw new RenderError(`Image asset is missing for ${entry.id}`);
    const duration = entry.endSeconds - entry.startSeconds;
    const sourcePath = entry.mode === "flow-video" ? asset.videoPath : asset.imagePath;
    if (entry.mode === "flow-video" && !sourcePath) throw new RenderError(`Flow video asset is missing for ${entry.id}`);
    if (!sourcePath) throw new RenderError(`Visual asset is missing for ${entry.id}`);
    await access(resolve(sourcePath)).catch(() => { throw new RenderError(`Visual asset cannot be read for ${entry.id}`); });

    if (entry.mode === "animated-image") {
      args.push("-loop", "1", "-framerate", String(fps), "-t", duration.toFixed(3), "-i", resolve(sourcePath));
      const frameCount = Math.max(1, Math.ceil(duration * fps));
      filterParts.push(
        `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},` +
        `zoompan=z='min(zoom+0.0005,1.08)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frameCount}:s=${width}x${height}:fps=${fps},` +
        `trim=duration=${duration.toFixed(3)},setsar=1,setpts=PTS-STARTPTS,${fadeFilters(duration)}[v${index}]`
      );
    } else {
      args.push("-i", resolve(sourcePath));
      filterParts.push(
        `[${index}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},` +
        `tpad=stop_mode=clone:stop_duration=${duration.toFixed(3)},trim=duration=${duration.toFixed(3)},` +
        `setpts=PTS-STARTPTS,${fadeFilters(duration)}[v${index}]`
      );
    }
    concatLabels.push(`[v${index}]`);
  }

  const songInputIndex = input.storyboard.entries.length;
  const canBurnCaptions = await supportsFfmpegFilter("ass");
  const captionMode = canBurnCaptions ? "burned" : "embedded";
  args.push("-i", songPath);
  filterParts.push(`${concatLabels.join("")}concat=n=${concatLabels.length}:v=1:a=0[concatv]`);
  if (canBurnCaptions) {
    filterParts.push("[concatv]ass=filename=lyrics.ass[captioned]");
  } else {
    args.push("-i", captionsPath);
  }

  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const temporaryOutputPath = `${dirname(outputPath)}/.${basename(outputPath)}.${randomUUID()}.tmp.mp4`;
  args.push(
    "-filter_complex", filterParts.join(";"),
    "-map", canBurnCaptions ? "[captioned]" : "[concatv]",
    "-map", `${songInputIndex}:a:0`,
    "-t", input.storyboard.durationSeconds.toFixed(3),
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-r", String(fps),
    "-c:a", "aac",
    "-b:a", "192k",
    "-ar", "48000",
    "-ac", "2",
    "-movflags", "+faststart"
  );
  if (!canBurnCaptions) {
    const captionInputIndex = songInputIndex + 1;
    args.push(
      "-map", `${captionInputIndex}:0`,
      "-c:s", "mov_text",
      "-metadata:s:s:0", "language=vie",
      "-disposition:s:0", "default"
    );
  }
  args.push(temporaryOutputPath);

  try {
    await runProcess("ffmpeg", args, { timeoutMs, cwd: dirname(captionsPath) });
    await rename(temporaryOutputPath, outputPath);
  } catch (error) {
    await unlink(temporaryOutputPath).catch(() => undefined);
    if (error instanceof RenderError) throw error;
    throw new RenderError(error instanceof Error ? error.message : "FFmpeg render failed");
  }

  const probe = await probeMusicMedia(outputPath);
  const video = probe.streams.find((stream) => stream.codecType === "video");
  const audio = probe.streams.find((stream) => stream.codecType === "audio");
  if (
    !video || !audio || video.codecName !== "h264" || audio.codecName !== "aac" || audio.channels !== 2 ||
    probe.width !== width || probe.height !== height || Math.abs(probe.duration - input.storyboard.durationSeconds) > 0.25
  ) {
    throw new RenderError(`Rendered media contract failed: ${JSON.stringify({
      videoCodec: video?.codecName,
      audioCodec: audio?.codecName,
      audioChannels: audio?.channels,
      width: probe.width,
      height: probe.height,
      duration: probe.duration,
      expectedDuration: input.storyboard.durationSeconds
    })}`);
  }

  const bytes = await readFile(outputPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const report = {
    outputPath,
    durationSeconds: probe.duration,
    width,
    height,
    fps,
    bytes: bytes.byteLength,
    sha256,
    visualCount: input.storyboard.entries.length,
    captionMode,
    renderedAt: new Date().toISOString()
  };
  await atomicWriteText(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return {
    outputPath,
    reportPath,
    duration: probe.duration,
    bytes: bytes.byteLength,
    sha256,
    width,
    height,
    captionMode
  };
}
