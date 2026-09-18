import { describe, expect, it } from "vitest";
import { buildCaptionCues, reconcileLyrics, renderAss } from "../src/music-video/captions.js";
import { validSongPlan } from "./fixtures/music-video.js";

const RETURNED_LYRICS = [
  "[Intro]",
  "Mưa rơi bên hiên vắng",
  "[Verse]",
  "Em đi qua ngày rất xanh",
  "Mang theo nụ cười trong lành",
  "[Chorus]",
  "Tình yêu đưa ta về gần nhau",
  "Qua bao tháng năm bạc màu"
].join("\n");

describe("music-video lyric captions", () => {
  it("reconciles provider text with the planned original lyric lines", () => {
    const result = reconcileLyrics(validSongPlan(), RETURNED_LYRICS);
    expect(result.matchedRatio).toBe(1);
    expect(result.lines).toEqual(validSongPlan().sections.flatMap((section) => section.lyrics));
  });

  it("accepts minor provider formatting changes but rejects substantially different lyrics", () => {
    const minorChange = RETURNED_LYRICS.replace("Mưa rơi bên hiên vắng", "Mưa rơi, bên hiên vắng!");
    expect(reconcileLyrics(validSongPlan(), minorChange).matchedRatio).toBe(1);
    expect(() => reconcileLyrics(validSongPlan(), "Một bài hát hoàn toàn khác\nKhông có lời đã duyệt"))
      .toThrow(/lyrics|match/i);
  });

  it("distributes line cues inside scaled song sections without overlaps", () => {
    const result = buildCaptionCues(validSongPlan(), 178.4);
    expect(result.timing).toBe("approximate");
    expect(result.cues).toHaveLength(5);
    expect(result.cues[0].startSeconds).toBe(0);
    expect(result.cues.at(-1)!.endSeconds).toBeLessThanOrEqual(178.4);
    for (let index = 1; index < result.cues.length; index += 1) {
      expect(result.cues[index].startSeconds).toBeGreaterThanOrEqual(result.cues[index - 1].endSeconds);
    }
  });

  it("uses valid provider line timestamps when supplied", () => {
    const providerCues = [
      { text: "Mưa rơi bên hiên vắng", startSeconds: 1, endSeconds: 8 },
      { text: "Em đi qua ngày rất xanh", startSeconds: 21, endSeconds: 30 },
      { text: "Mang theo nụ cười trong lành", startSeconds: 31, endSeconds: 40 },
      { text: "Tình yêu đưa ta về gần nhau", startSeconds: 81, endSeconds: 90 },
      { text: "Qua bao tháng năm bạc màu", startSeconds: 91, endSeconds: 100 }
    ];
    const result = buildCaptionCues(validSongPlan(), 178.4, providerCues);
    expect(result).toEqual({ timing: "provider", cues: providerCues });
  });

  it("renders readable 1080p ASS and escapes untrusted dialogue text", () => {
    const ass = renderAss([
      { text: "Em {yêu}\\anh,\n\"mãi\"", startSeconds: 1.25, endSeconds: 4.5 }
    ]);

    expect(ass).toContain("PlayResX: 1920");
    expect(ass).toContain("PlayResY: 1080");
    expect(ass).toMatch(/Style: Karaoke,[^\n]*,5[0-9],/);
    expect(ass).toContain("Dialogue: 0,0:00:01.25,0:00:04.50,Karaoke");
    expect(ass).toContain("Em \\{yêu\\}\\\\anh,\\N\"mãi\"");
  });

  it("rejects provider cues that overlap, exceed duration, or change lyric text", () => {
    const base = buildCaptionCues(validSongPlan(), 178.4).cues;
    expect(() => buildCaptionCues(validSongPlan(), 178.4, [
      { ...base[0], startSeconds: 0, endSeconds: 10 },
      { ...base[1], startSeconds: 9, endSeconds: 12 }
    ])).toThrow(/overlap|timeline/i);
    expect(() => buildCaptionCues(validSongPlan(), 178.4, [
      { ...base[0], endSeconds: 180 }
    ])).toThrow(/duration|timeline/i);
    expect(() => buildCaptionCues(validSongPlan(), 178.4, [
      { ...base[0], text: "Lời khác" }
    ])).toThrow(/lyrics|text/i);
  });
});
