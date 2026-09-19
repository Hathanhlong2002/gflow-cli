import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { probeMedia, mergeClips, renderEpisode } from "../src/shorts/renderer.js";
import { RenderError } from "../src/errors.js";

function runCmd(args: string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("ffmpeg", args, { shell: false });
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`ffmpeg exited with code ${code}`));
    });
    child.on("error", rejectPromise);
  });
}

describe("shorts renderer and video merging", () => {
  let tempDir: string;
  let clip1: string;
  let clip2: string;
  let clipNoAudio: string;
  let narrationWav: string;

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "gflow-render-test-"));
    clip1 = join(tempDir, "clip1.mp4");
    clip2 = join(tempDir, "clip2.mp4");
    clipNoAudio = join(tempDir, "clip_no_audio.mp4");
    narrationWav = join(tempDir, "narration.wav");

    // Generate clip1: 1s blue 1080x1920 with 48kHz audio
    await runCmd([
      "-y",
      "-f", "lavfi", "-i", "color=c=blue:s=1080x1920:d=1",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
      "-c:v", "libx264", "-c:a", "aac",
      "-pix_fmt", "yuv420p",
      clip1
    ]);

    // Generate clip2: 1s red 1080x1920 with 48kHz audio
    await runCmd([
      "-y",
      "-f", "lavfi", "-i", "color=c=red:s=1080x1920:d=1",
      "-f", "lavfi", "-i", "sine=frequency=880:duration=1",
      "-c:v", "libx264", "-c:a", "aac",
      "-pix_fmt", "yuv420p",
      clip2
    ]);

    // Generate clipNoAudio: 1s green 720x1280 WITHOUT audio track
    await runCmd([
      "-y",
      "-f", "lavfi", "-i", "color=c=green:s=720x1280:d=1",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-an",
      clipNoAudio
    ]);

    // Generate narration WAV: 1.5s sine tone
    await runCmd([
      "-y",
      "-f", "lavfi", "-i", "sine=frequency=330:duration=1.5",
      "-c:a", "pcm_s16le",
      "-ar", "24000",
      narrationWav
    ]);
  });

  afterAll(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it("probes video and audio streams correctly", async () => {
    const probe = await probeMedia(clip1);
    expect(probe.hasVideo).toBe(true);
    expect(probe.hasAudio).toBe(true);
    expect(probe.width).toBe(1080);
    expect(probe.height).toBe(1920);
    expect(probe.duration).toBeGreaterThan(0.9);
  });

  it("detects video files without audio stream", async () => {
    const probe = await probeMedia(clipNoAudio);
    expect(probe.hasVideo).toBe(true);
    expect(probe.hasAudio).toBe(false);
  });

  it("merges multiple video clips seamlessly, even when audio is missing on some", async () => {
    const output = join(tempDir, "merged.mp4");
    const result = await mergeClips({
      clipPaths: [clip1, clipNoAudio, clip2],
      outputPath: output,
      targetWidth: 1080,
      targetHeight: 1920,
      fps: 30
    });

    expect(result.outputPath).toBe(output);
    expect(result.duration).toBeGreaterThanOrEqual(2.8);
    expect(result.width).toBe(1080);
    expect(result.height).toBe(1920);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);

    const probe = await probeMedia(output);
    expect(probe.hasVideo).toBe(true);
    expect(probe.hasAudio).toBe(true);
  });

  it("mixes narration audio over merged scene clips", async () => {
    const output = join(tempDir, "merged_with_narration.mp4");
    const result = await mergeClips({
      clipPaths: [clip1, clip2],
      outputPath: output,
      narrationAudioPath: narrationWav
    });

    expect(result.duration).toBeGreaterThanOrEqual(1.9);
    const probe = await probeMedia(output);
    expect(probe.hasAudio).toBe(true);
  });

  it("renders episode from scene directories and writes media-report.json", async () => {
    const projectRoot = join(tempDir, "project");
    const scene1Dir = join(projectRoot, "episodes", "01", "scenes", "01");
    const scene2Dir = join(projectRoot, "episodes", "01", "scenes", "02");
    await mkdir(scene1Dir, { recursive: true });
    await mkdir(scene2Dir, { recursive: true });

    // Copy sample clips to scene paths
    await runCmd(["-y", "-i", clip1, "-c", "copy", join(scene1Dir, "clip.mp4")]);
    await runCmd(["-y", "-i", clip2, "-c", "copy", join(scene2Dir, "clip.mp4")]);

    const result = await renderEpisode({
      projectRoot,
      episodeIndex: 1
    });

    expect(result.episodeIndex).toBe(1);
    expect(result.sceneCount).toBe(2);
    expect(result.outputPath).toBe(join(projectRoot, "episodes", "01", "final.mp4"));
    expect(result.mediaReportPath).toBe(join(projectRoot, "episodes", "01", "media-report.json"));

    const probe = await probeMedia(result.outputPath);
    expect(probe.duration).toBeGreaterThanOrEqual(1.9);
  });

  it("throws RenderError when input files do not exist or are empty", async () => {
    await expect(
      mergeClips({
        clipPaths: [],
        outputPath: join(tempDir, "empty.mp4")
      })
    ).rejects.toThrow(RenderError);

    await expect(
      mergeClips({
        clipPaths: [join(tempDir, "non_existent.mp4")],
        outputPath: join(tempDir, "out.mp4")
      })
    ).rejects.toThrow(RenderError);
  });
});
