import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MusicVideoProjectStore } from "../src/music-video/project-store.js";

const MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

describe("music-video project store", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createStore() {
    const root = await mkdtemp(join(tmpdir(), "gflow-music-store-"));
    roots.push(root);
    const store = new MusicVideoProjectStore(root);
    const state = await store.create({
      topic: "Tình yêu",
      language: "vi-VN",
      targetDurationSeconds: 180,
      textModel: "gemini-3.5-flash",
      imageModel: "gemini-2.5-flash-image",
      musicModel: "lyria-3.5"
    });
    return { root, store, state };
  }

  it("creates private durable state and rejects a different existing configuration", async () => {
    const { store, state } = await createStore();
    expect(state).toMatchObject({ projectId: "tinh-yeu", stage: "CREATED", topic: "Tình yêu" });
    expect((await stat(store.paths().state)).mode & 0o777).toBe(0o600);

    await expect(store.create({
      topic: "Chủ đề khác",
      language: "vi-VN",
      targetDurationSeconds: 180,
      textModel: "gemini-3.5-flash",
      imageModel: "gemini-2.5-flash-image",
      musicModel: "lyria-3.5"
    })).rejects.toThrow(/exists|configuration|topic/i);
  });

  it("writes validated song and image artifacts atomically with hashes", async () => {
    const { root, store } = await createStore();
    const song = await store.writeSong({
      mimeType: "audio/mpeg",
      bytes: MP3,
      outputText: "Mưa rơi bên hiên vắng"
    });
    const image = await store.writeImage("visual-001", { mimeType: "image/jpeg", bytes: JPEG });

    expect(song.path).toBe("audio/song.mp3");
    expect(song.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(image.path).toBe("assets/visual-001/start.jpg");
    expect(await store.artifactMatchesDisk(song)).toBe(true);
    expect(await readFile(store.paths().lyrics, "utf8")).toBe("Mưa rơi bên hiên vắng\n");
    expect((await readdir(root)).some((name) => name.includes(".tmp"))).toBe(false);

    await writeFile(store.paths().song, new Uint8Array([...MP3, 1]));
    expect(await store.artifactMatchesDisk(song)).toBe(false);
  });

  it("rejects unsafe paths and media whose signatures do not match", async () => {
    const { root, store } = await createStore();
    await expect(store.recordArtifact(join(root, "..", "outside.mp4"), "video/mp4")).rejects.toThrow(/outside/i);
    await expect(store.writeSong({ mimeType: "audio/mpeg", bytes: new Uint8Array([1, 2, 3]), outputText: "lyrics" }))
      .rejects.toThrow(/MP3/i);
    await expect(store.writeImage("visual-001", { mimeType: "image/jpeg", bytes: new Uint8Array([1, 2, 3]) }))
      .rejects.toThrow(/signature/i);
    await expect(store.writeImage("../../unsafe", { mimeType: "image/jpeg", bytes: JPEG })).rejects.toThrow(/id/i);
  });

  it("appends schema-validated events and redacts credential-like text", async () => {
    const { store } = await createStore();
    await store.appendEvent({ stage: "SONG_READY", message: "provider key AIza123456789012345678901234567890 failed" });

    const event = JSON.parse((await readFile(store.paths().events, "utf8")).trim());
    expect(event).toMatchObject({ stage: "SONG_READY" });
    expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false);
    expect(event.message).toContain("[REDACTED]");
    expect(event.message).not.toContain("AIza123");
  });
});
