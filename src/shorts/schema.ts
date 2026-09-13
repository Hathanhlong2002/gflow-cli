import { z } from "zod";

export const SHORTS_EPISODE_COUNT = 10;
export const SHORTS_SCENE_COUNT = 10;
export const SHORTS_SCENE_DURATION_SECONDS = 8;

const positionedId = (prefix: "episode" | "scene", index: number): string =>
  `${prefix}-${String(index + 1).padStart(2, "0")}`;

export const topicSchema = z
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

export const scenePlanSchema = z
  .object({
    id: z.string().regex(/^scene-(0[1-9]|10)$/),
    durationSeconds: z.literal(SHORTS_SCENE_DURATION_SECONDS),
    visual: z.string().trim().min(1).max(2000),
    motionPrompt: z.string().trim().min(1).max(2000),
    narration: z.string().trim().min(1).max(1000),
    caption: z.string().trim().min(1).max(300)
  })
  .strict();

export const episodePlanSchema = z
  .object({
    id: z.string().regex(/^episode-(0[1-9]|10)$/),
    title: z.string().trim().min(1).max(100),
    hook: z.string().trim().min(1).max(300),
    description: z.string().trim().min(1).max(2200),
    hashtags: z.array(z.string().regex(/^#[\p{L}\p{N}_]+$/u)).min(3).max(5),
    scenes: z.array(scenePlanSchema).length(SHORTS_SCENE_COUNT)
  })
  .strict();

export const creativePlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    topic: topicSchema,
    language: z.string().trim().min(2).max(35),
    seriesTitle: z.string().trim().min(1).max(150),
    seriesPremise: z.string().trim().min(1).max(2000),
    continuity: z
      .object({
        characters: z.array(z.string().trim().min(1).max(1000)).max(20),
        locations: z.array(z.string().trim().min(1).max(1000)).max(30),
        palette: z.string().trim().min(1).max(500),
        cameraLanguage: z.string().trim().min(1).max(500),
        prohibitedChanges: z.array(z.string().trim().min(1).max(500)).max(30)
      })
      .strict(),
    episodes: z.array(episodePlanSchema).length(SHORTS_EPISODE_COUNT)
  })
  .strict()
  .superRefine((plan, context) => {
    plan.episodes.forEach((episode, episodeIndex) => {
      const expectedEpisodeId = positionedId("episode", episodeIndex);
      if (episode.id !== expectedEpisodeId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["episodes", episodeIndex, "id"],
          message: `episode id must be ${expectedEpisodeId}`
        });
      }

      episode.scenes.forEach((scene, sceneIndex) => {
        const expectedSceneId = positionedId("scene", sceneIndex);
        if (scene.id !== expectedSceneId) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["episodes", episodeIndex, "scenes", sceneIndex, "id"],
            message: `scene id must be ${expectedSceneId}`
          });
        }
      });
    });
  });

export type ScenePlan = z.infer<typeof scenePlanSchema>;
export type EpisodePlan = z.infer<typeof episodePlanSchema>;
export type CreativePlan = z.infer<typeof creativePlanSchema>;

export function parseTopic(value: unknown): string {
  return topicSchema.parse(value);
}

export function parseCreativePlan(value: unknown): CreativePlan {
  return creativePlanSchema.parse(value);
}
