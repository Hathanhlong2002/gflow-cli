import { z } from "zod";
import { parseSongPlan, type SongPlan } from "./schema.js";

export interface CaptionCue {
  text: string;
  startSeconds: number;
  endSeconds: number;
}

export interface CaptionBuildResult {
  timing: "provider" | "approximate";
  cues: CaptionCue[];
}

const cueSchema = z.object({
  text: z.string().trim().min(1).max(600),
  startSeconds: z.number().finite().min(0).max(600),
  endSeconds: z.number().finite().positive().max(600)
}).strict().refine((cue) => cue.endSeconds > cue.startSeconds, "caption end must be after start");

const providerTimingSchema = z.union([
  z.array(cueSchema).min(1).max(500),
  z.object({ cues: z.array(cueSchema).min(1).max(500) }).strict()
]);

export function parseProviderCaptionCues(structureText?: string): CaptionCue[] | undefined {
  if (!structureText) return undefined;
  const bounded = z.string().min(1).max(2 * 1024 * 1024).parse(structureText);
  try {
    const parsed = providerTimingSchema.parse(JSON.parse(bounded) as unknown);
    return Array.isArray(parsed) ? parsed : parsed.cues;
  } catch {
    return undefined;
  }
}

function normalizeLyric(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("vi")
    // Lyria prefixes every line with section/timestamp tags, e.g. "[[A0]]" on its own line
    // and "[0.0:] lyric text" on content lines; strip those leading tags (not just a
    // whole-line tag) before comparing against the plain planned lyrics.
    .replace(/^\s*(?:\[[^\]]*\]\s*)+/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function plannedLines(plan: SongPlan): string[] {
  return plan.sections.flatMap((section) => section.lyrics);
}

export function reconcileLyrics(planInput: SongPlan, outputText: string): { lines: string[]; matchedRatio: number } {
  const plan = parseSongPlan(planInput);
  const providerLines = z.string().trim().min(1).max(2 * 1024 * 1024).parse(outputText)
    .split(/\r?\n/)
    .map(normalizeLyric)
    .filter((line) => line.length > 0);
  const providerSet = new Set(providerLines);
  const lines = plannedLines(plan);
  const matched = lines.filter((line) => providerSet.has(normalizeLyric(line))).length;
  const matchedRatio = lines.length === 0 ? 1 : matched / lines.length;
  if (matchedRatio < 0.6) {
    throw new Error(`Generated lyrics match only ${Math.round(matchedRatio * 100)}% of the planned original lyrics`);
  }
  return { lines, matchedRatio };
}

function validateProviderCues(plan: SongPlan, durationSeconds: number, value: CaptionCue[]): CaptionCue[] {
  const cues = z.array(cueSchema).min(1).max(500).parse(value);
  const allowedLyrics = new Set(plannedLines(plan).map(normalizeLyric));
  cues.forEach((cue, index) => {
    if (!allowedLyrics.has(normalizeLyric(cue.text))) {
      throw new Error(`Provider caption text at index ${index} does not match planned lyrics`);
    }
    if (cue.endSeconds > durationSeconds + 0.01) {
      throw new Error(`Provider caption timeline exceeds song duration at index ${index}`);
    }
    if (index > 0 && cue.startSeconds < cues[index - 1].endSeconds - 0.01) {
      throw new Error(`Provider caption timeline overlaps at index ${index}`);
    }
  });
  return cues;
}

function approximateCues(plan: SongPlan, durationSeconds: number): CaptionCue[] {
  const scale = durationSeconds / plan.targetDurationSeconds;
  return plan.sections.flatMap((section) => {
    if (section.lyrics.length === 0) return [];
    const start = section.startSeconds * scale;
    const end = Math.min(durationSeconds, section.endSeconds * scale);
    const weights = section.lyrics.map((line) => Math.max(1, Array.from(line).length));
    const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    let cursor = start;
    return section.lyrics.map((line, index) => {
      const next = index === section.lyrics.length - 1
        ? end
        : cursor + ((end - start) * weights[index]) / totalWeight;
      const cue = { text: line, startSeconds: cursor, endSeconds: next };
      cursor = next;
      return cue;
    });
  });
}

export function buildCaptionCues(
  planInput: SongPlan,
  durationSecondsInput: number,
  providerCues?: CaptionCue[]
): CaptionBuildResult {
  const plan = parseSongPlan(planInput);
  const durationSeconds = z.number().finite().min(30).max(240).parse(durationSecondsInput);
  if (providerCues) {
    return { timing: "provider", cues: validateProviderCues(plan, durationSeconds, providerCues) };
  }
  return { timing: "approximate", cues: approximateCues(plan, durationSeconds) };
}

function formatAssTimestamp(secondsInput: number): string {
  const centiseconds = Math.max(0, Math.round(secondsInput * 100));
  const hours = Math.floor(centiseconds / 360_000);
  const minutes = Math.floor((centiseconds % 360_000) / 6_000);
  const seconds = Math.floor((centiseconds % 6_000) / 100);
  const fraction = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(fraction).padStart(2, "0")}`;
}

function wrapTwoLines(value: string): string {
  const explicit = value.split(/\r?\n/).slice(0, 2);
  if (explicit.length > 1 || explicit[0].length <= 46) return explicit.join("\n");
  const words = explicit[0].split(/\s+/);
  let bestIndex = 1;
  let smallestDifference = Number.POSITIVE_INFINITY;
  for (let index = 1; index < words.length; index += 1) {
    const left = words.slice(0, index).join(" ").length;
    const right = words.slice(index).join(" ").length;
    const difference = Math.abs(left - right);
    if (difference < smallestDifference) {
      smallestDifference = difference;
      bestIndex = index;
    }
  }
  return `${words.slice(0, bestIndex).join(" ")}\n${words.slice(bestIndex).join(" ")}`;
}

function escapeAssText(value: string): string {
  return wrapTwoLines(value)
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r?\n/g, "\\N");
}

export function renderAss(cuesInput: CaptionCue[]): string {
  const cues = z.array(cueSchema).min(1).max(500).parse(cuesInput);
  const dialogue = cues.map((cue) => [
    "Dialogue: 0",
    formatAssTimestamp(cue.startSeconds),
    formatAssTimestamp(cue.endSeconds),
    "Karaoke",
    "",
    "0",
    "0",
    "0",
    "",
    escapeAssText(cue.text)
  ].join(","));

  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1920",
    "PlayResY: 1080",
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    "Style: Karaoke,Arial,54,&H00FFFFFF,&H0000D7FF,&H00101010,&H90000000,-1,0,0,0,100,100,0,0,1,4,1,2,80,80,72,1",
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    ...dialogue,
    ""
  ].join("\n");
}
