import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.js";
import type { PlanInput } from "../src/shorts/planner.js";
import type { CreativePlan } from "../src/shorts/schema.js";
import { validCreativePlan } from "./fixtures/shorts.js";

describe("shorts CLI", () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), "gflow-shorts-cli-"));
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  it("plans ten episodes from only a topic and output directory", async () => {
    const planner = {
      plan: vi.fn<[PlanInput], Promise<CreativePlan>>(async () => validCreativePlan())
    };
    const program = createProgram({ storyPlanner: planner, environment: {} });

    await program.parseAsync([
      "node",
      "gflow",
      "shorts",
      "plan",
      "--topic",
      validCreativePlan().topic,
      "--out",
      outputDir
    ]);

    expect(planner.plan).toHaveBeenCalledWith({
      topic: validCreativePlan().topic,
      language: "vi-VN",
      model: "gemini-2.5-flash"
    });
    const state = JSON.parse(await readFile(join(outputDir, "project.json"), "utf8"));
    const plan = JSON.parse(await readFile(join(outputDir, "creative-plan.json"), "utf8"));
    expect(state).toMatchObject({ stage: "PLANNED" });
    expect(plan.episodes).toHaveLength(10);
  });

  it("fails before creating a project when the API key is absent", async () => {
    const program = createProgram({ environment: {} });

    await expect(program.parseAsync([
      "node",
      "gflow",
      "shorts",
      "plan",
      "--topic",
      validCreativePlan().topic,
      "--out",
      outputDir
    ])).rejects.toThrow(/GEMINI_API_KEY is required/);

    await expect(readFile(join(outputDir, "project.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps existing commands and exposes shorts in top-level help", () => {
    const help = createProgram().helpInformation();

    expect(help).toContain("shorts");
    expect(help).toContain("image");
    expect(help).toContain("video");
    expect(help).toContain("batch");
  });

  it("passes configurable language and model names to project state", async () => {
    const plan = validCreativePlan();
    plan.language = "en-US";
    const planner = { plan: vi.fn<[PlanInput], Promise<CreativePlan>>(async () => plan) };
    const program = createProgram({ storyPlanner: planner, environment: {} });

    await program.parseAsync([
      "node",
      "gflow",
      "shorts",
      "plan",
      "--topic",
      plan.topic,
      "--out",
      outputDir,
      "--language",
      "en-US",
      "--text-model",
      "gemini-text-custom",
      "--image-model",
      "gemini-image-custom",
      "--tts-model",
      "gemini-tts-custom"
    ]);

    const state = JSON.parse(await readFile(join(outputDir, "project.json"), "utf8"));
    expect(state).toMatchObject({
      language: "en-US",
      models: { text: "gemini-text-custom", image: "gemini-image-custom", tts: "gemini-tts-custom" }
    });
  });
});
