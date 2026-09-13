import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pcmToWav, writeNarration, writeSceneImage } from "../src/shorts/media-artifacts.js";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 1, 0xff, 0xd9]);
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

describe("shorts media artifacts", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gflow-media-artifacts-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes a JPEG when MIME and magic bytes agree", async () => {
    const path = join(root, "episodes", "01", "scenes", "01", "start.jpg");

    const artifact = await writeSceneImage({ root, path, media: { mimeType: "image/jpeg", bytes: JPEG } });

    expect(artifact).toMatchObject({ path: "episodes/01/scenes/01/start.jpg", bytes: JPEG.length, mimeType: "image/jpeg" });
    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(new Uint8Array(await readFile(path))).toEqual(JPEG);
  });

  it("writes a PNG when MIME and magic bytes agree", async () => {
    const path = join(root, "episodes", "01", "scenes", "01", "start.png");

    await expect(writeSceneImage({ root, path, media: { mimeType: "image/png", bytes: PNG } }))
      .resolves.toMatchObject({ path: "episodes/01/scenes/01/start.png", mimeType: "image/png" });
  });

  it("rejects a MIME-signature mismatch and an output outside root", async () => {
    await expect(writeSceneImage({
      root,
      path: join(root, "start.png"),
      media: { mimeType: "image/png", bytes: JPEG }
    })).rejects.toThrow(/signature/i);
    await expect(writeSceneImage({
      root,
      path: join(root, "..", "outside.jpg"),
      media: { mimeType: "image/jpeg", bytes: JPEG }
    })).rejects.toThrow(/outside/i);
  });

  it("wraps PCM in canonical mono 24 kHz 16-bit WAV", () => {
    const wav = pcmToWav({ sampleRate: 24000, channels: 1, bitsPerSample: 16, pcm: new Uint8Array([0, 0, 1, 0]) });
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);

    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe("WAVE");
    expect(view.getUint32(24, true)).toBe(24000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(new TextDecoder().decode(wav.slice(36, 40))).toBe("data");
    expect(view.getUint32(40, true)).toBe(4);
  });

  it("rejects odd PCM and writes narration as WAV", async () => {
    const validAudio = { sampleRate: 24000 as const, channels: 1 as const, bitsPerSample: 16 as const, pcm: new Uint8Array([0, 0, 1, 0]) };
    expect(() => pcmToWav({ ...validAudio, pcm: new Uint8Array([0]) })).toThrow(/PCM/i);

    const path = join(root, "episodes", "01", "scenes", "01", "narration.wav");
    const artifact = await writeNarration({ root, path, audio: validAudio });
    expect(artifact).toMatchObject({ path: "episodes/01/scenes/01/narration.wav", mimeType: "audio/wav", bytes: 48 });
  });
});
