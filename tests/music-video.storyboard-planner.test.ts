import { describe, expect, it } from "vitest";
import type { GeminiJsonRequest, GeminiTransport } from "../src/shorts/gemini-transport.js";
import { buildTimelineWindows, GeminiStoryboardPlanner } from "../src/music-video/storyboard-planner.js";
import { validSongPlan } from "./fixtures/music-video.js";

function visualMetadata(durationSeconds = 178.4) {
  return buildTimelineWindows(durationSeconds, 8).map((window, index) => ({
    id: window.id,
    sectionId: index < 2 ? "section-01" : index < 10 ? "section-02" : "section-03",
    visual: `Cinematic love story shot ${index + 1}`,
    motionPrompt: `Camera movement ${index + 1}`,
    importance: index === 0 || index === 22 ? 5 : (index % 5) + 1,
    suggestedMode: index % 3 === 0 ? "flow-video" : "animated-image"
  }));
}

describe("music-video storyboard planner", () => {
  it("builds exact eight-second windows plus one final partial window", () => {
    const windows = buildTimelineWindows(178.4, 8);
    expect(windows).toHaveLength(23);
    expect(windows[0]).toEqual({ id: "visual-001", startSeconds: 0, endSeconds: 8 });
    expect(windows[21]).toEqual({ id: "visual-022", startSeconds: 168, endSeconds: 176 });
    expect(windows[22]).toEqual({ id: "visual-023", startSeconds: 176, endSeconds: 178.4 });
  });

  it("joins validated metadata onto owned timestamps and selects eight Flow moments", async () => {
    const requests: GeminiJsonRequest[] = [];
    const transport: GeminiTransport = {
      async generateJson(input) {
        requests.push(input);
        return { entries: visualMetadata() };
      }
    };
    const planner = new GeminiStoryboardPlanner(transport);
    const storyboard = await planner.plan({ plan: validSongPlan(), durationSeconds: 178.4, model: "gemini-text" });

    expect(storyboard.durationSeconds).toBe(178.4);
    expect(storyboard.entries).toHaveLength(23);
    expect(storyboard.entries.filter((entry) => entry.mode === "flow-video")).toHaveLength(8);
    expect(storyboard.entries[0].mode).toBe("flow-video");
    expect(storyboard.entries.at(-1)?.mode).toBe("flow-video");
    expect(storyboard.entries.some((entry) => entry.mode === "flow-video" && entry.sectionId === "section-03")).toBe(true);
    expect(storyboard.entries[0]).toMatchObject({ startSeconds: 0, endSeconds: 8 });
    expect(storyboard.entries.at(-1)).toMatchObject({ endSeconds: 178.4 });

    expect(requests).toHaveLength(1);
    expect(requests[0].prompt).toContain("visual-001");
    expect(requests[0].prompt).toContain("visual-023");
    expect(requests[0].systemInstruction).toMatch(/topic.*data|untrusted data/i);
  });

  it("rejects invalid durations before contacting Gemini", async () => {
    let calls = 0;
    const planner = new GeminiStoryboardPlanner({ async generateJson() { calls += 1; return {}; } });
    for (const durationSeconds of [Number.NaN, Number.POSITIVE_INFINITY, 29, 241]) {
      await expect(planner.plan({ plan: validSongPlan(), durationSeconds, model: "gemini-text" })).rejects.toThrow();
    }
    expect(calls).toBe(0);
  });

  it("rejects missing, duplicate, mismatched, or extra visual metadata", async () => {
    const candidates = [
      { entries: visualMetadata().slice(1) },
      { entries: visualMetadata().map((entry, index) => index === 1 ? { ...entry, id: "visual-001" } : entry) },
      { entries: visualMetadata().map((entry, index) => index === 2 ? { ...entry, sectionId: "section-03" } : entry) },
      { entries: visualMetadata().map((entry, index) => index === 0 ? { ...entry, unsafePath: "../../etc" } : entry) }
    ];

    for (const candidate of candidates) {
      const planner = new GeminiStoryboardPlanner({ async generateJson() { return candidate; } });
      await expect(planner.plan({ plan: validSongPlan(), durationSeconds: 178.4, model: "gemini-text" }))
        .rejects.toThrow(/storyboard|metadata|attempts|section/i);
    }
  });
});
