import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RenderError } from "../src/errors.js";
import { probeMusicMedia, renderMusicVideo } from "../src/music-video/renderer.js";
import type { Storyboard } from "../src/music-video/schema.js";

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args], { shell: false });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer | string) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${stderr}`)));
  });
}

describe("hybrid music-video renderer", () => {
  let root: string;
  let imageOne: string;
  let imageTwo: string;
  let flowClip: string;
  let song: string;
  let captions: string;

  const storyboard: Storyboard = {
    schemaVersion: 1,
    durationSeconds: 5,
    entries: [
      {
        id: "visual-001", startSeconds: 0, endSeconds: 2, mode: "animated-image",
        sectionId: "section-01", visual: "blue", motionPrompt: "slow zoom", importance: 3
      },
      {
        id: "visual-002", startSeconds: 2, endSeconds: 4, mode: "flow-video",
        sectionId: "section-01", visual: "red", motionPrompt: "dolly", importance: 5
      },
      {
        id: "visual-003", startSeconds: 4, endSeconds: 5, mode: "animated-image",
        sectionId: "section-01", visual: "green", motionPrompt: "slow zoom", importance: 4
      }
    ]
  };

  beforeAll(async () => {
    const temp = await mkdtemp(join(tmpdir(), "gflow-music-render-"));
    root = join(temp, "project's: sample");
    await mkdir(join(root, "captions"), { recursive: true });
    imageOne = join(root, "blue.png");
    imageTwo = join(root, "green.png");
    flowClip = join(root, "flow clip.mp4");
    song = join(root, "song.mp3");
    captions = join(root, "captions", "lyrics.ass");
    await runFfmpeg(["-f", "lavfi", "-i", "color=c=blue:s=640x360", "-frames:v", "1", imageOne]);
    await runFfmpeg(["-f", "lavfi", "-i", "color=c=green:s=640x360", "-frames:v", "1", imageTwo]);
    await runFfmpeg([
      "-f", "lavfi", "-i", "color=c=red:s=640x360:d=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", flowClip
    ]);
    await runFfmpeg([
      "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
      "-c:a", "libmp3lame", "-ar", "44100", "-ac", "2", song
    ]);
    await writeFile(captions, [
      "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1920", "PlayResY: 1080", "",
      "[V4+ Styles]",
      "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
      "Style: Karaoke,Arial,54,&H00FFFFFF,&H0000D7FF,&H00101010,&H90000000,-1,0,0,0,100,100,0,0,1,4,1,2,80,80,72,1",
      "", "[Events]", "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
      "Dialogue: 0,0:00:00.50,0:00:04.50,Karaoke,,0,0,0,,Tình yêu", ""
    ].join("\n"));
  }, 30_000);

  afterAll(async () => {
    if (root) await rm(join(root, ".."), { recursive: true, force: true });
  });

  it("renders animated stills and a Flow clip against the authoritative song", async () => {
    const outputPath = join(root, "output", "final video.mp4");
    const reportPath = join(root, "output", "media-report.json");
    const result = await renderMusicVideo({
      storyboard,
      assets: {
        "visual-001": { imagePath: imageOne },
        "visual-002": { imagePath: imageOne, videoPath: flowClip },
        "visual-003": { imagePath: imageTwo }
      },
      songPath: song,
      captionsPath: captions,
      outputPath,
      reportPath,
      targetWidth: 1920,
      targetHeight: 1080,
      fps: 30
    });

    expect(result).toMatchObject({
      outputPath,
      duration: expect.any(Number),
      width: 1920,
      height: 1080,
      captionMode: expect.stringMatching(/^(burned|embedded)$/)
    });
    expect(result.duration).toBeGreaterThanOrEqual(4.75);
    expect(result.duration).toBeLessThanOrEqual(5.25);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(access(reportPath)).resolves.toBeUndefined();

    const probe = await probeMusicMedia(outputPath);
    expect(probe).toMatchObject({ hasVideo: true, hasAudio: true, width: 1920, height: 1080 });
    expect(probe.streams.some((stream) => stream.codecType === "video" && stream.codecName === "h264")).toBe(true);
    expect(probe.streams.find((stream) => stream.codecType === "video")?.sampleAspectRatio).toBe("1:1");
    expect(probe.streams.some((stream) => stream.codecType === "audio" && stream.codecName === "aac" && stream.channels === 2)).toBe(true);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(report.duration).toBe(result.duration);
    expect(report).not.toHaveProperty("durationSeconds");
    expect(report.captionMode).toBe(result.captionMode);
    if (result.captionMode === "embedded") {
      expect(probe.streams.some((stream) => stream.codecType === "other" && stream.codecName === "mov_text")).toBe(true);
    }
    expect((await readdir(join(root, "output"))).some((name) => name.includes(".tmp"))).toBe(false);
  }, 30_000);

  it("fails before rendering when a required visual asset is missing", async () => {
    await expect(renderMusicVideo({
      storyboard,
      assets: {
        "visual-001": { imagePath: imageOne },
        "visual-002": { imagePath: imageOne },
        "visual-003": { imagePath: imageTwo }
      },
      songPath: song,
      captionsPath: captions,
      outputPath: join(root, "output", "missing.mp4"),
      reportPath: join(root, "output", "missing-report.json")
    })).rejects.toThrow(/video.*visual-002|visual-002.*video/i);
  });

  it("cleans temporary output after an FFmpeg timeout", async () => {
    const outputPath = join(root, "output", "timeout.mp4");
    await expect(renderMusicVideo({
      storyboard,
      assets: {
        "visual-001": { imagePath: imageOne },
        "visual-002": { imagePath: imageOne, videoPath: flowClip },
        "visual-003": { imagePath: imageTwo }
      },
      songPath: song,
      captionsPath: captions,
      outputPath,
      reportPath: join(root, "output", "timeout-report.json"),
      timeoutMs: 1
    })).rejects.toBeInstanceOf(RenderError);
    await expect(access(outputPath)).rejects.toThrow();
    expect((await readdir(join(root, "output"))).some((name) => name.includes("timeout.mp4") && name.includes(".tmp"))).toBe(false);
  });
});
