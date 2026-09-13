import { describe, expect, it } from "vitest";
import { parseCreativePlan, parseTopic } from "../src/shorts/schema.js";
import { validCreativePlan } from "./fixtures/shorts.js";

describe("shorts creative plan schema", () => {
  it("accepts exactly ten episodes with ten eight-second scenes", () => {
    const plan = parseCreativePlan(validCreativePlan());

    expect(plan.episodes).toHaveLength(10);
    expect(plan.episodes.every((episode) => episode.scenes.length === 10)).toBe(true);
    expect(plan.episodes.flatMap((episode) => episode.scenes).every((scene) => scene.durationSeconds === 8)).toBe(true);
  });

  it.each(["ab", "a\0bc", "line\nbreak", "x".repeat(301)])("rejects unsafe topic %j", (topic) => {
    expect(() => parseTopic(topic)).toThrow();
  });

  it("trims a valid topic", () => {
    expect(parseTopic("  Đại dương kỳ bí  ")).toBe("Đại dương kỳ bí");
  });

  it("rejects the wrong episode count", () => {
    const plan = validCreativePlan();
    plan.episodes.pop();

    expect(() => parseCreativePlan(plan)).toThrow();
  });

  it("rejects the wrong scene count", () => {
    const plan = validCreativePlan();
    plan.episodes[0].scenes.pop();

    expect(() => parseCreativePlan(plan)).toThrow();
  });

  it("rejects unknown fields", () => {
    const plan: ReturnType<typeof validCreativePlan> & { injected?: string } = validCreativePlan();
    plan.injected = "untrusted model field";

    expect(() => parseCreativePlan(plan)).toThrow();
  });

  it("rejects non-eight-second scenes", () => {
    const plan = validCreativePlan();
    plan.episodes[0].scenes[0].durationSeconds = 7;

    expect(() => parseCreativePlan(plan)).toThrow();
  });

  it("rejects episode and scene ids that do not match their positions", () => {
    const wrongEpisode = validCreativePlan();
    wrongEpisode.episodes[0].id = "episode-02";
    expect(() => parseCreativePlan(wrongEpisode)).toThrow(/episode id/i);

    const wrongScene = validCreativePlan();
    wrongScene.episodes[0].scenes[0].id = "scene-02";
    expect(() => parseCreativePlan(wrongScene)).toThrow(/scene id/i);
  });
});
