import { describe, expect, it, vi } from "vitest";
import type { GeminiJsonRequest } from "../src/shorts/gemini-transport.js";
import { GeminiStoryPlanner } from "../src/shorts/planner.js";
import { validCreativePlan } from "./fixtures/shorts.js";

const input = {
  topic: "Những bí ẩn của đại dương",
  language: "vi-VN",
  model: "gemini-2.5-flash"
};

describe("GeminiStoryPlanner", () => {
  it("returns the first valid structured plan", async () => {
    const plan = validCreativePlan();
    const transport = { generateJson: vi.fn(async () => plan) };
    const planner = new GeminiStoryPlanner(transport);

    await expect(planner.plan(input)).resolves.toEqual(plan);
    expect(transport.generateJson).toHaveBeenCalledOnce();
  });

  it("repairs invalid output without echoing the untrusted response", async () => {
    const transport = {
      generateJson: vi
        .fn<[GeminiJsonRequest], Promise<unknown>>()
        .mockResolvedValueOnce({ injected: "DO-NOT-ECHO-THIS" })
        .mockResolvedValueOnce(validCreativePlan())
    };
    const planner = new GeminiStoryPlanner(transport);

    await expect(planner.plan(input)).resolves.toEqual(validCreativePlan());
    const repairRequest = transport.generateJson.mock.calls[1]![0];
    expect(repairRequest.prompt).toContain("Validation issues");
    expect(repairRequest.prompt).not.toContain("DO-NOT-ECHO-THIS");
  });

  it("makes at most two repair attempts", async () => {
    const transport = { generateJson: vi.fn(async () => ({ bad: true })) };
    const planner = new GeminiStoryPlanner(transport);

    await expect(planner.plan(input)).rejects.toThrow(/invalid creative plan after 3 attempts/i);
    expect(transport.generateJson).toHaveBeenCalledTimes(3);
  });

  it("rejects a valid-shaped plan for a different topic", async () => {
    const wrongTopic = validCreativePlan();
    wrongTopic.topic = "Một chủ đề khác";
    const transport = { generateJson: vi.fn(async () => wrongTopic) };
    const planner = new GeminiStoryPlanner(transport);

    await expect(planner.plan(input)).rejects.toThrow(/invalid creative plan after 3 attempts/i);
    expect(transport.generateJson).toHaveBeenCalledTimes(3);
  });

  it("sends a schema requiring exactly ten episodes and ten scenes", async () => {
    const transport = { generateJson: vi.fn<[GeminiJsonRequest], Promise<unknown>>(async () => validCreativePlan()) };
    const planner = new GeminiStoryPlanner(transport);

    await planner.plan(input);

    const schema = transport.generateJson.mock.calls[0]![0].responseSchema as {
      properties: { episodes: { minItems: number; maxItems: number; items: { properties: { scenes: { minItems: number; maxItems: number } } } } };
    };
    expect(schema.properties.episodes).toMatchObject({ minItems: 10, maxItems: 10 });
    expect(schema.properties.episodes.items.properties.scenes).toMatchObject({ minItems: 10, maxItems: 10 });
  });
});
