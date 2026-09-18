import { describe, expect, it } from "vitest";
import {
  parseMusicVideoProjectState,
  parseSongPlan,
  parseStoryboard
} from "../src/music-video/schema.js";
import { validProjectState, validSongPlan, validStoryboard } from "./fixtures/music-video.js";

describe("music-video schemas", () => {
  it("accepts a strict, continuous song plan", () => {
    const plan = validSongPlan();
    expect(parseSongPlan(plan)).toEqual(plan);
  });

  it("rejects overlapping or out-of-order song sections", () => {
    const plan = validSongPlan();
    const sections = plan.sections.map((section) => ({ ...section }));
    sections[1].startSeconds = 19;

    expect(() => parseSongPlan({ ...plan, sections })).toThrow(/continuous|overlap|start/i);
  });

  it("rejects song plans that do not cover the target duration", () => {
    const plan = validSongPlan();
    const sections = plan.sections.map((section) => ({ ...section }));
    sections[2].endSeconds = 170;

    expect(() => parseSongPlan({ ...plan, sections })).toThrow(/duration|end/i);
  });

  it("rejects control characters and extra fields", () => {
    expect(() => parseSongPlan({ ...validSongPlan(), topic: "Tình\u0000yêu" })).toThrow();
    expect(() => parseSongPlan({ ...validSongPlan(), unexpected: true })).toThrow();
  });

  it("accepts a storyboard that covers the real song duration", () => {
    const storyboard = validStoryboard();
    expect(parseStoryboard(storyboard, 180)).toEqual(storyboard);
  });

  it("rejects storyboard gaps, unordered IDs, and a mismatched duration", () => {
    const storyboard = validStoryboard();
    const gap = storyboard.entries.map((entry) => ({ ...entry }));
    gap[1].startSeconds = 46;
    expect(() => parseStoryboard({ ...storyboard, entries: gap }, 180)).toThrow(/continuous|gap|start/i);

    const ids = storyboard.entries.map((entry) => ({ ...entry }));
    ids[1].id = "visual-004";
    expect(() => parseStoryboard({ ...storyboard, entries: ids }, 180)).toThrow(/visual-002|id/i);

    expect(() => parseStoryboard(storyboard, 179)).toThrow(/duration/i);
  });

  it("requires exactly min(8, entry count) Flow entries", () => {
    const storyboard = validStoryboard();
    const entries = storyboard.entries.map((entry, index) => ({
      ...entry,
      mode: index === 0 ? "flow-video" as const : "animated-image" as const
    }));
    expect(() => parseStoryboard({ ...storyboard, entries }, 180)).toThrow(/Flow/i);
  });

  it("validates durable project state and rejects untrusted model names", () => {
    const state = validProjectState();
    expect(parseMusicVideoProjectState(state)).toEqual(state);
    expect(() => parseMusicVideoProjectState({
      ...state,
      models: { ...state.models, music: "../../unsafe" }
    })).toThrow(/model|music/i);
  });
});
