import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { SHORTS_EPISODE_COUNT, SHORTS_SCENE_COUNT } from "./schema.js";

const indexSchema = z.number().int().min(1).max(10);
const artifactPathSchema = z.string().regex(
  /^episodes\/(0[1-9]|10)\/scenes\/(0[1-9]|10)\/(?:start\.(?:jpg|png)|narration\.wav|clip\.mp4)$/
);

function artifactMatchesField(
  field: "image" | "narration" | "video",
  artifact: { path: string; mimeType: string }
): boolean {
  if (field === "image") {
    return (
      (artifact.mimeType === "image/jpeg" && artifact.path.endsWith("/start.jpg")) ||
      (artifact.mimeType === "image/png" && artifact.path.endsWith("/start.png"))
    );
  }
  if (field === "narration") {
    return artifact.mimeType === "audio/wav" && artifact.path.endsWith("/narration.wav");
  }
  return artifact.mimeType === "video/mp4" && artifact.path.endsWith("/clip.mp4");
}

export const artifactRecordSchema = z
  .object({
    path: artifactPathSchema,
    bytes: z.number().int().positive().max(200 * 1024 * 1024),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: z.enum(["image/jpeg", "image/png", "audio/wav", "video/mp4"])
  })
  .strict();

export const sceneGenerationRecordSchema = z
  .object({
    id: z.string().regex(/^ep-(0[1-9]|10)-scene-(0[1-9]|10)$/),
    episodeIndex: indexSchema,
    sceneIndex: indexSchema,
    status: z.enum(["PENDING", "MEDIA_READY", "COMPLETED", "FAILED"]),
    image: artifactRecordSchema.optional(),
    narration: artifactRecordSchema.optional(),
    video: artifactRecordSchema.optional(),
    error: z
      .object({
        code: z.string().regex(/^[A-Z0-9_]+$/),
        message: z.string().min(1).max(500)
      })
      .strict()
      .optional()
  })
  .strict();

export const generationJournalSchema = z
  .object({
    schemaVersion: z.literal(1),
    planHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: z.enum(["GENERATING", "PAUSED", "GENERATED"]),
    scenes: z.array(sceneGenerationRecordSchema).length(SHORTS_EPISODE_COUNT * SHORTS_SCENE_COUNT),
    updatedAt: z.string().datetime()
  })
  .strict()
  .superRefine((journal, context) => {
    journal.scenes.forEach((scene, position) => {
      const episodeIndex = Math.floor(position / SHORTS_SCENE_COUNT) + 1;
      const sceneIndex = (position % SHORTS_SCENE_COUNT) + 1;
      const expectedId = formatSceneId(episodeIndex, sceneIndex);
      if (scene.id !== expectedId || scene.episodeIndex !== episodeIndex || scene.sceneIndex !== sceneIndex) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scenes", position, "id"],
          message: `scene id and indexes must match ${expectedId}`
        });
      }

      const prefix = `episodes/${padIndex(episodeIndex)}/scenes/${padIndex(sceneIndex)}/`;
      for (const [field, artifact] of [
        ["image", scene.image],
        ["narration", scene.narration],
        ["video", scene.video]
      ] as const) {
        if (artifact && !artifact.path.startsWith(prefix)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["scenes", position, field, "path"],
            message: `artifact path must belong to ${expectedId}`
          });
        }
        if (artifact && !artifactMatchesField(field, artifact)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["scenes", position, field],
            message: `${field} artifact MIME type and filename do not match`
          });
        }
      }
    });
  });

export type ArtifactRecord = z.infer<typeof artifactRecordSchema>;
export type SceneGenerationRecord = z.infer<typeof sceneGenerationRecordSchema>;
export type GenerationJournal = z.infer<typeof generationJournalSchema>;

export interface ScenePaths {
  directory: string;
  imageJpeg: string;
  imagePng: string;
  narration: string;
  video: string;
  metadata: string;
}

function padIndex(index: number): string {
  return String(index).padStart(2, "0");
}

function assertIndex(index: number): void {
  if (!Number.isInteger(index) || index < 1 || index > 10) {
    throw new Error("Episode and scene index must be an integer from 1 to 10");
  }
}

function formatSceneId(episodeIndex: number, sceneIndex: number): string {
  return `ep-${padIndex(episodeIndex)}-scene-${padIndex(sceneIndex)}`;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export class GenerationJournalStore {
  private readonly root: string;
  private readonly journalPath: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.journalPath = join(this.root, "generation.json");
  }

  pathsFor(episodeIndex: number, sceneIndex: number): ScenePaths {
    assertIndex(episodeIndex);
    assertIndex(sceneIndex);
    const directory = join(this.root, "episodes", padIndex(episodeIndex), "scenes", padIndex(sceneIndex));
    return {
      directory,
      imageJpeg: join(directory, "start.jpg"),
      imagePng: join(directory, "start.png"),
      narration: join(directory, "narration.wav"),
      video: join(directory, "clip.mp4"),
      metadata: join(directory, "artifact.json")
    };
  }

  async create(planHash: string): Promise<GenerationJournal> {
    const scenes: SceneGenerationRecord[] = [];
    for (let episodeIndex = 1; episodeIndex <= SHORTS_EPISODE_COUNT; episodeIndex += 1) {
      for (let sceneIndex = 1; sceneIndex <= SHORTS_SCENE_COUNT; sceneIndex += 1) {
        scenes.push({
          id: formatSceneId(episodeIndex, sceneIndex),
          episodeIndex,
          sceneIndex,
          status: "PENDING"
        });
      }
    }
    const journal = generationJournalSchema.parse({
      schemaVersion: 1,
      planHash,
      status: "GENERATING",
      scenes,
      updatedAt: new Date().toISOString()
    });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.save(journal);
    return journal;
  }

  async load(): Promise<GenerationJournal> {
    const text = await readFile(this.journalPath, "utf8");
    return generationJournalSchema.parse(JSON.parse(text) as unknown);
  }

  async save(value: GenerationJournal): Promise<void> {
    const journal = generationJournalSchema.parse({ ...value, updatedAt: new Date().toISOString() });
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await atomicWrite(this.journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  }
}
