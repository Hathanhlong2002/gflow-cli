import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgram } from "../src/cli.js";
import type { RunMusicVideoInput } from "../src/music-video/orchestrator.js";

describe("music-video CLI", () => {
  const roots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function newRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "gflow-music-cli-"));
    roots.push(root);
    return root;
  }

  it("exposes a one-command music-video workflow", () => {
    const musicVideo = createProgram().commands.find((command) => command.name() === "music-video");
    expect(musicVideo).toBeDefined();
    expect(musicVideo?.commands.find((command) => command.name() === "run")).toBeDefined();
  });

  it("documents the workflow, provenance, and caption limitation", async () => {
    const readme = await readFile(resolve("README.md"), "utf8");
    for (const requiredText of [
      "gflow music-video run",
      "GEMINI_API_KEY",
      "--resume",
      "lyria-3.5",
      "SynthID",
      "1920x1080",
      "approximate"
    ]) {
      expect(readme).toContain(requiredText);
    }
  });

  it("uses Vietnamese three-minute defaults and prints the final output", async () => {
    const root = await newRoot();
    const runner = vi.fn(async (input: RunMusicVideoInput) => ({
      stage: "READY" as const,
      outputPath: input.store.paths().final,
      reportPath: input.store.paths().mediaReport,
      duration: 180,
      bytes: 20,
      sha256: "a".repeat(64),
      width: 1920,
      height: 1080,
      captionMode: "embedded" as const
    }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const flowAutomationFactory = vi.fn();
    const program = createProgram({
      environment: { GEMINI_API_KEY: "test-key" },
      musicVideoRunner: runner,
      flowAutomationFactory
    });

    await program.parseAsync([
      "node", "gflow", "music-video", "run",
      "--topic", "Tình yêu",
      "--out", root
    ]);

    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0][0]).toMatchObject({
      root: resolve(root),
      topic: "Tình yêu",
      language: "vi-VN",
      targetDurationSeconds: 180,
      models: {
        text: "gemini-3.5-flash",
        image: "gemini-2.5-flash-image",
        music: "lyria-3.5"
      },
      resume: false
    });
    expect(flowAutomationFactory).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("final.mp4"));
  });

  it("fails before creating a project or opening Chrome when the API key is absent", async () => {
    const root = await newRoot();
    const flowAutomationFactory = vi.fn();
    const runner = vi.fn();
    const program = createProgram({ environment: {}, flowAutomationFactory, musicVideoRunner: runner });

    await expect(program.parseAsync([
      "node", "gflow", "music-video", "run",
      "--topic", "Tình yêu",
      "--out", root
    ])).rejects.toThrow(/GEMINI_API_KEY is required/);

    expect(runner).not.toHaveBeenCalled();
    expect(flowAutomationFactory).not.toHaveBeenCalled();
    await expect(readFile(join(root, "project.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("passes resume and session options to the lazy Flow factory", async () => {
    const root = await newRoot();
    let received: RunMusicVideoInput | undefined;
    const flowAutomationFactory = vi.fn(async () => ({ automation: { runJob: vi.fn() }, close: vi.fn() }));
    const program = createProgram({
      environment: { GEMINI_API_KEY: "test-key" },
      flowAutomationFactory,
      musicVideoRunner: async (input) => {
        received = input;
        await input.flowGeneratorFactory();
        return {
          stage: "READY", outputPath: input.store.paths().final, reportPath: input.store.paths().mediaReport,
          duration: 180, bytes: 20, sha256: "a".repeat(64), width: 1920, height: 1080, captionMode: "burned"
        };
      }
    });

    await program.parseAsync([
      "node", "gflow", "music-video", "run", "--topic", "Tình yêu", "--out", root,
      "--resume", "--profile", "music", "--browser", "chromium", "--no-headed"
    ]);

    expect(received?.resume).toBe(true);
    expect(flowAutomationFactory).toHaveBeenCalledWith({ profile: "music", browser: "chromium", headed: false });
  });
});
