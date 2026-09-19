import { z } from "zod";

const TIMELINE_EPSILON_SECONDS = 0.01;
const modelNameSchema = z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9._-]+$/, "invalid model name");
const finiteSecondsSchema = z.number().finite().min(0).max(600);

export const musicVideoTopicSchema = z
  .string()
  .trim()
  .min(3)
  .max(300)
  .refine(
    (value) => Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint > 31 && codePoint !== 127;
    }),
    "topic contains control characters"
  );

export const songSectionKindSchema = z.enum([
  "intro",
  "verse",
  "pre-chorus",
  "chorus",
  "bridge",
  "climax",
  "outro",
  "instrumental"
]);

export const songSectionSchema = z
  .object({
    id: z.string().regex(/^section-\d{2}$/),
    kind: songSectionKindSchema,
    startSeconds: finiteSecondsSchema,
    endSeconds: finiteSecondsSchema,
    lyrics: z.array(z.string().trim().min(1).max(300)).max(20),
    energy: z.number().int().min(1).max(5)
  })
  .strict()
  .refine((section) => section.endSeconds > section.startSeconds, {
    message: "section end must be after start"
  });

export const songPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    topic: musicVideoTopicSchema,
    language: z.string().trim().min(2).max(35),
    title: z.string().trim().min(1).max(150),
    genre: z.string().trim().min(1).max(200),
    mood: z.string().trim().min(1).max(300),
    bpm: z.number().int().min(40).max(240),
    key: z.string().trim().min(1).max(50).optional(),
    vocalDirection: z.string().trim().min(1).max(500),
    targetDurationSeconds: z.number().int().min(30).max(240),
    continuity: z
      .object({
        characters: z.array(z.string().trim().min(1).max(1000)).max(20),
        locations: z.array(z.string().trim().min(1).max(1000)).max(30),
        palette: z.string().trim().min(1).max(500),
        wardrobe: z.string().trim().min(1).max(500),
        prohibitedChanges: z.array(z.string().trim().min(1).max(500)).max(30)
      })
      .strict(),
    // Gemini's structured-output schema validator rejects this request body with a bare
    // HTTP 400 once sections.maxItems climbs much past 8 alongside the plan's other fields
    // (verified empirically); keep this in sync with MUSIC_PLAN_RESPONSE_SCHEMA in song-planner.ts.
    sections: z.array(songSectionSchema).min(2).max(8)
  })
  .strict()
  .superRefine((plan, context) => {
    plan.sections.forEach((section, index) => {
      const expectedId = `section-${String(index + 1).padStart(2, "0")}`;
      if (section.id !== expectedId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sections", index, "id"],
          message: `section id must be ${expectedId}`
        });
      }

      const expectedStart = index === 0 ? 0 : plan.sections[index - 1].endSeconds;
      if (Math.abs(section.startSeconds - expectedStart) > TIMELINE_EPSILON_SECONDS) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sections", index, "startSeconds"],
          message: "song sections must form a continuous timeline without gaps or overlap"
        });
      }
    });

    const finalEnd = plan.sections.at(-1)?.endSeconds;
    if (finalEnd !== undefined && Math.abs(finalEnd - plan.targetDurationSeconds) > TIMELINE_EPSILON_SECONDS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sections", plan.sections.length - 1, "endSeconds"],
        message: "final section end must match target duration"
      });
    }
  });

export const storyboardEntrySchema = z
  .object({
    id: z.string().regex(/^visual-\d{3}$/),
    startSeconds: finiteSecondsSchema,
    endSeconds: finiteSecondsSchema,
    mode: z.enum(["flow-video", "animated-image"]),
    sectionId: z.string().regex(/^section-\d{2}$/),
    visual: z.string().trim().min(1).max(2000),
    motionPrompt: z.string().trim().min(1).max(2000),
    importance: z.number().int().min(1).max(5)
  })
  .strict()
  .refine((entry) => entry.endSeconds > entry.startSeconds, {
    message: "storyboard entry end must be after start"
  });

export const storyboardSchema = z
  .object({
    schemaVersion: z.literal(1),
    durationSeconds: z.number().finite().min(30).max(240),
    entries: z.array(storyboardEntrySchema).min(1).max(60)
  })
  .strict()
  .superRefine((storyboard, context) => {
    storyboard.entries.forEach((entry, index) => {
      const expectedId = `visual-${String(index + 1).padStart(3, "0")}`;
      if (entry.id !== expectedId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index, "id"],
          message: `storyboard id must be ${expectedId}`
        });
      }
      const expectedStart = index === 0 ? 0 : storyboard.entries[index - 1].endSeconds;
      if (Math.abs(entry.startSeconds - expectedStart) > TIMELINE_EPSILON_SECONDS) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index, "startSeconds"],
          message: "storyboard entries must form a continuous timeline without gaps or overlap"
        });
      }
    });

    const finalEnd = storyboard.entries.at(-1)?.endSeconds;
    if (finalEnd !== undefined && Math.abs(finalEnd - storyboard.durationSeconds) > TIMELINE_EPSILON_SECONDS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries", storyboard.entries.length - 1, "endSeconds"],
        message: "storyboard end must match duration"
      });
    }

    const expectedFlowCount = Math.min(8, storyboard.entries.length);
    const flowCount = storyboard.entries.filter((entry) => entry.mode === "flow-video").length;
    if (flowCount !== expectedFlowCount) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries"],
        message: `storyboard must contain exactly ${expectedFlowCount} Flow entries`
      });
    }
  });

export const musicVideoStageSchema = z.enum([
  "CREATED",
  "SONG_PLANNED",
  "SONG_READY",
  "STORYBOARDED",
  "ASSETS_GENERATING",
  "ASSETS_READY",
  "RENDERING",
  "READY",
  "PAUSED",
  "FAILED",
  "CANCELLED"
]);

export const musicVideoProjectStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    stage: musicVideoStageSchema,
    topic: musicVideoTopicSchema,
    language: z.string().trim().min(2).max(35),
    targetDurationSeconds: z.number().int().min(30).max(240),
    models: z
      .object({
        text: modelNameSchema,
        image: modelNameSchema,
        music: modelNameSchema
      })
      .strict(),
    planHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    songHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    storyboardHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

export const musicVideoArtifactSchema = z
  .object({
    path: z.string().regex(/^(?:audio\/(?:song\.mp3|lyrics\.txt|lyria-response\.json)|captions\/lyrics\.ass|assets\/visual-\d{3}\/(?:start\.(?:jpg|png)|clip\.mp4)|output\/(?:final\.mp4|media-report\.json))$/),
    bytes: z.number().int().positive().max(1024 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: z.enum(["audio/mpeg", "image/jpeg", "image/png", "video/mp4", "text/plain", "text/x-ass", "application/json"])
  })
  .strict();

export const musicVideoJournalSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    status: musicVideoStageSchema,
    song: musicVideoArtifactSchema.optional(),
    captions: musicVideoArtifactSchema.optional(),
    final: musicVideoArtifactSchema.optional(),
    entries: z.array(
      z.object({
        id: z.string().regex(/^visual-\d{3}$/),
        status: z.enum(["PENDING", "IMAGE_READY", "COMPLETED", "FAILED"]),
        image: musicVideoArtifactSchema.optional(),
        video: musicVideoArtifactSchema.optional(),
        error: z.object({
          code: z.string().regex(/^[A-Z0-9_]+$/),
          message: z.string().min(1).max(500)
        }).strict().optional()
      }).strict()
    ).max(60),
    updatedAt: z.string().datetime()
  })
  .strict();

export type SongSectionKind = z.infer<typeof songSectionKindSchema>;
export type SongSection = z.infer<typeof songSectionSchema>;
export type SongPlan = z.infer<typeof songPlanSchema>;
export type StoryboardEntry = z.infer<typeof storyboardEntrySchema>;
export type Storyboard = z.infer<typeof storyboardSchema>;
export type MusicVideoStage = z.infer<typeof musicVideoStageSchema>;
export type MusicVideoProjectState = z.infer<typeof musicVideoProjectStateSchema>;
export type MusicVideoArtifact = z.infer<typeof musicVideoArtifactSchema>;
export type MusicVideoJournal = z.infer<typeof musicVideoJournalSchema>;

export function parseSongPlan(value: unknown): SongPlan {
  return songPlanSchema.parse(value);
}

export function parseStoryboard(value: unknown, expectedDurationSeconds?: number): Storyboard {
  const storyboard = storyboardSchema.parse(value);
  if (
    expectedDurationSeconds !== undefined &&
    Math.abs(storyboard.durationSeconds - expectedDurationSeconds) > TIMELINE_EPSILON_SECONDS
  ) {
    throw new Error("Storyboard duration does not match the probed song duration");
  }
  return storyboard;
}

export function parseMusicVideoProjectState(value: unknown): MusicVideoProjectState {
  return musicVideoProjectStateSchema.parse(value);
}

export function parseMusicVideoJournal(value: unknown): MusicVideoJournal {
  return musicVideoJournalSchema.parse(value);
}
