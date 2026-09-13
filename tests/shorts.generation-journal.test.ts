import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GenerationJournalStore } from "../src/shorts/generation-journal.js";

describe("GenerationJournalStore", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gflow-generation-journal-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates exactly 100 ordered pending scene records", async () => {
    const journal = await new GenerationJournalStore(root).create("a".repeat(64));

    expect(journal.status).toBe("GENERATING");
    expect(journal.scenes).toHaveLength(100);
    expect(journal.scenes[0]).toMatchObject({
      id: "ep-01-scene-01",
      episodeIndex: 1,
      sceneIndex: 1,
      status: "PENDING"
    });
    expect(journal.scenes[99]).toMatchObject({
      id: "ep-10-scene-10",
      episodeIndex: 10,
      sceneIndex: 10,
      status: "PENDING"
    });
  });

  it("uses only fixed numeric scene paths beneath the output root", () => {
    const store = new GenerationJournalStore(root);

    expect(store.pathsFor(2, 3)).toEqual({
      directory: join(resolve(root), "episodes", "02", "scenes", "03"),
      imageJpeg: join(resolve(root), "episodes", "02", "scenes", "03", "start.jpg"),
      imagePng: join(resolve(root), "episodes", "02", "scenes", "03", "start.png"),
      narration: join(resolve(root), "episodes", "02", "scenes", "03", "narration.wav"),
      video: join(resolve(root), "episodes", "02", "scenes", "03", "clip.mp4"),
      metadata: join(resolve(root), "episodes", "02", "scenes", "03", "artifact.json")
    });
    expect(() => store.pathsFor(0, 1)).toThrow(/index/i);
    expect(() => store.pathsFor(1, 11)).toThrow(/index/i);
    expect(() => store.pathsFor(1.5, 1)).toThrow(/index/i);
  });

  it("atomically checkpoints one image without changing other scenes", async () => {
    const store = new GenerationJournalStore(root);
    const journal = await store.create("a".repeat(64));
    journal.scenes[0].image = {
      path: "episodes/01/scenes/01/start.jpg",
      bytes: 4,
      sha256: "b".repeat(64),
      mimeType: "image/jpeg"
    };

    await store.save(journal);
    const loaded = await store.load();

    expect(loaded.scenes.filter((scene) => scene.image)).toHaveLength(1);
    expect(loaded.scenes[1]).toMatchObject({ id: "ep-01-scene-02", status: "PENDING" });
  });

  it("rejects unknown fields in persisted state", async () => {
    const store = new GenerationJournalStore(root);
    const journal = await store.create("a".repeat(64));
    await writeFile(join(root, "generation.json"), JSON.stringify({ ...journal, injected: true }), "utf8");

    await expect(store.load()).rejects.toThrow();
  });

  it("rejects scene IDs that do not match their indexes", async () => {
    const store = new GenerationJournalStore(root);
    const journal = await store.create("a".repeat(64));
    journal.scenes[0].id = "ep-01-scene-02";

    await expect(store.save(journal)).rejects.toThrow(/scene id/i);
  });

  it("rejects unsafe artifact paths and malformed digests", async () => {
    const store = new GenerationJournalStore(root);
    const journal = await store.create("a".repeat(64));
    journal.scenes[0].image = {
      path: "../../outside.jpg",
      bytes: 4,
      sha256: "not-a-digest",
      mimeType: "image/jpeg"
    };

    await expect(store.save(journal)).rejects.toThrow();
  });

  it("rejects an artifact whose MIME and filename do not match its field", async () => {
    const store = new GenerationJournalStore(root);
    const journal = await store.create("a".repeat(64));
    journal.scenes[0].image = {
      path: "episodes/01/scenes/01/narration.wav",
      bytes: 44,
      sha256: "b".repeat(64),
      mimeType: "audio/wav"
    };

    await expect(store.save(journal)).rejects.toThrow(/image artifact/i);
  });

  it("writes parseable JSON with a trailing newline", async () => {
    const store = new GenerationJournalStore(root);
    await store.create("a".repeat(64));
    const bytes = await readFile(join(root, "generation.json"));

    expect(bytes.at(-1)).toBe(10);
    expect(() => JSON.parse(bytes.toString("utf8"))).not.toThrow();
  });
});
