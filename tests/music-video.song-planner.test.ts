import { describe, expect, it } from "vitest";
import type { GeminiJsonRequest, GeminiTransport } from "../src/shorts/gemini-transport.js";
import { GeminiSongPlanner } from "../src/music-video/song-planner.js";
import { validSongPlan } from "./fixtures/music-video.js";

describe("Gemini song planner", () => {
  it("requests an original timestamped Vietnamese song plan", async () => {
    const requests: GeminiJsonRequest[] = [];
    const transport: GeminiTransport = {
      async generateJson(input) {
        requests.push(input);
        return validSongPlan();
      }
    };
    const planner = new GeminiSongPlanner(transport);

    await expect(planner.plan({
      topic: "Tình yêu",
      language: "vi-VN",
      model: "gemini-text",
      targetDurationSeconds: 180
    })).resolves.toEqual(validSongPlan());

    expect(requests).toHaveLength(1);
    expect(requests[0].systemInstruction).toMatch(/topic as data/i);
    expect(requests[0].systemInstruction).toMatch(/original lyrics/i);
    expect(requests[0].systemInstruction).toMatch(/not imitate|never imitate/i);
    expect(requests[0].prompt).toContain(JSON.stringify("Tình yêu"));
    expect(requests[0].prompt).toMatch(/vi-VN/);
    expect(requests[0].prompt).toMatch(/180 seconds/);
    expect(requests[0].prompt).toMatch(/timestamp/i);
  });

  it("repairs invalid candidates at most twice after the initial request", async () => {
    const requests: GeminiJsonRequest[] = [];
    const transport: GeminiTransport = {
      async generateJson(input) {
        requests.push(input);
        return { ...validSongPlan(), sections: [] };
      }
    };
    const planner = new GeminiSongPlanner(transport);

    await expect(planner.plan({
      topic: "Tình yêu",
      language: "vi-VN",
      model: "gemini-text",
      targetDurationSeconds: 180
    })).rejects.toThrow(/after 3 attempts/i);

    expect(requests).toHaveLength(3);
    expect(requests[1].prompt).toMatch(/validation issues/i);
    expect(requests[1].prompt).toMatch(/sections/);
    expect(requests[1].prompt).not.toContain(JSON.stringify({ ...validSongPlan(), sections: [] }));
  });

  it("rejects a candidate that changes the exact topic, language, or duration", async () => {
    for (const candidate of [
      { ...validSongPlan(), topic: "Chủ đề khác" },
      { ...validSongPlan(), language: "en-US" },
      { ...validSongPlan(), targetDurationSeconds: 160 }
    ]) {
      const planner = new GeminiSongPlanner({ async generateJson() { return candidate; } });
      await expect(planner.plan({
        topic: "Tình yêu",
        language: "vi-VN",
        model: "gemini-text",
        targetDurationSeconds: 180
      })).rejects.toThrow(/after 3 attempts/i);
    }
  });

  it("validates model and duration before contacting Gemini", async () => {
    let calls = 0;
    const planner = new GeminiSongPlanner({ async generateJson() { calls += 1; return validSongPlan(); } });

    await expect(planner.plan({
      topic: "Tình yêu",
      language: "vi-VN",
      model: "../../unsafe",
      targetDurationSeconds: 180
    })).rejects.toThrow();
    await expect(planner.plan({
      topic: "Tình yêu",
      language: "vi-VN",
      model: "gemini-text",
      targetDurationSeconds: 10
    })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
