import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectStore, type CreateProjectInput } from "../src/shorts/project-store.js";
import { validCreativePlan } from "./fixtures/shorts.js";

const validInput: CreateProjectInput = {
  topic: "  Đại dương kỳ bí  ",
  language: "vi-VN",
  textModel: "gemini-2.5-flash",
  imageModel: "gemini-2.5-flash-image",
  ttsModel: "gemini-2.5-flash-preview-tts"
};

describe("ProjectStore", () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), "gflow-shorts-store-"));
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it("creates normalized project state beneath the selected directory", async () => {
    const store = new ProjectStore(outputDir);

    const state = await store.create(validInput);

    expect(state).toMatchObject({
      schemaVersion: 1,
      projectId: "dai-duong-ky-bi",
      stage: "CREATED",
      topic: "Đại dương kỳ bí",
      language: "vi-VN",
      models: {
        text: "gemini-2.5-flash",
        image: "gemini-2.5-flash-image",
        tts: "gemini-2.5-flash-preview-tts"
      }
    });
    expect(JSON.parse(await readFile(join(outputDir, "project.json"), "utf8"))).toEqual(state);
  });

  it("uses fixed manifest paths beneath the selected output directory", () => {
    expect(new ProjectStore(outputDir).paths()).toEqual({
      root: resolve(outputDir),
      state: join(resolve(outputDir), "project.json"),
      plan: join(resolve(outputDir), "creative-plan.json")
    });
  });

  it("persists a validated creative plan and its exact SHA-256 digest", async () => {
    const store = new ProjectStore(outputDir);
    await store.create({ ...validInput, topic: validCreativePlan().topic });

    const state = await store.savePlan(validCreativePlan());
    const planBytes = await readFile(join(outputDir, "creative-plan.json"));

    expect(state.stage).toBe("PLANNED");
    expect(state.planHash).toBe(createHash("sha256").update(planBytes).digest("hex"));
    expect(JSON.parse(planBytes.toString("utf8"))).toEqual(validCreativePlan());
  });

  it("rejects invalid plans before changing durable state", async () => {
    const store = new ProjectStore(outputDir);
    await store.create(validInput);
    const invalid = validCreativePlan();
    invalid.episodes.pop();

    await expect(store.savePlan(invalid)).rejects.toThrow();
    await expect(store.load()).resolves.toMatchObject({ stage: "CREATED" });
  });

  it("rejects a plan for a different topic", async () => {
    const store = new ProjectStore(outputDir);
    await store.create(validInput);
    const plan = validCreativePlan();
    plan.topic = "Một chủ đề khác";

    await expect(store.savePlan(plan)).rejects.toThrow(/topic/i);
  });

  it("rejects unknown fields when loading state", async () => {
    const store = new ProjectStore(outputDir);
    const state = await store.create(validInput);
    await writeFile(join(outputDir, "project.json"), JSON.stringify({ ...state, injected: true }), "utf8");

    await expect(store.load()).rejects.toThrow();
  });

  it("does not overwrite an existing project", async () => {
    const store = new ProjectStore(outputDir);
    await store.create(validInput);

    await expect(store.create(validInput)).rejects.toThrow(/already exists/i);
  });
});
