import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planShortsProject } from "../src/shorts/plan-service.js";
import { ProjectStore, type CreateProjectInput } from "../src/shorts/project-store.js";
import type { PlanInput } from "../src/shorts/planner.js";
import type { CreativePlan } from "../src/shorts/schema.js";
import { validCreativePlan } from "./fixtures/shorts.js";

const validConfig: CreateProjectInput = {
  topic: "Những bí ẩn của đại dương",
  language: "vi-VN",
  textModel: "gemini-2.5-flash",
  imageModel: "gemini-2.5-flash-image",
  ttsModel: "gemini-2.5-flash-preview-tts"
};

describe("planShortsProject", () => {
  let outputDir: string;
  let store: ProjectStore;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), "gflow-shorts-plan-service-"));
    store = new ProjectStore(outputDir);
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it("creates state, calls the planner, and persists the result", async () => {
    const plan = validCreativePlan();
    const planner = { plan: vi.fn<[PlanInput], Promise<CreativePlan>>(async () => plan) };

    const state = await planShortsProject({ config: validConfig, store, planner });

    expect(state.stage).toBe("PLANNED");
    expect(state.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(planner.plan).toHaveBeenCalledWith({
      topic: validConfig.topic,
      language: validConfig.language,
      model: validConfig.textModel
    });
  });

  it("leaves a durable CREATED project when planning fails", async () => {
    const planner = {
      plan: vi.fn<[PlanInput], Promise<CreativePlan>>(async () => {
        throw new Error("provider unavailable");
      })
    };

    await expect(planShortsProject({ config: validConfig, store, planner })).rejects.toThrow("provider unavailable");
    await expect(store.load()).resolves.toMatchObject({ stage: "CREATED" });
  });

  it("returns an existing PLANNED project without another provider call", async () => {
    await store.create(validConfig);
    const existing = await store.savePlan(validCreativePlan());
    const planner = { plan: vi.fn<[PlanInput], Promise<CreativePlan>>() };

    await expect(planShortsProject({ config: validConfig, store, planner })).resolves.toEqual(existing);
    expect(planner.plan).not.toHaveBeenCalled();
  });

  it("replans an existing project when force is true", async () => {
    await store.create(validConfig);
    const previous = await store.savePlan(validCreativePlan());
    const replacement = validCreativePlan();
    replacement.seriesTitle = "Một tiêu đề mới";
    const planner = { plan: vi.fn<[PlanInput], Promise<CreativePlan>>(async () => replacement) };

    const next = await planShortsProject({ config: validConfig, store, planner, force: true });

    expect(planner.plan).toHaveBeenCalledOnce();
    expect(next.planHash).not.toBe(previous.planHash);
  });

  it("rejects config drift before calling the provider", async () => {
    await store.create(validConfig);
    const planner = { plan: vi.fn<[PlanInput], Promise<CreativePlan>>() };

    await expect(planShortsProject({
      config: { ...validConfig, textModel: "gemini-different" },
      store,
      planner
    })).rejects.toThrow(/configuration does not match/i);
    expect(planner.plan).not.toHaveBeenCalled();
  });
});
