import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { parseCreativePlan, parseTopic, type CreativePlan } from "./schema.js";

const modelNameSchema = z.string().trim().min(1).max(200);

const createProjectInputSchema = z
  .object({
    topic: z.unknown(),
    language: z.string().trim().min(2).max(35),
    textModel: modelNameSchema,
    imageModel: modelNameSchema,
    ttsModel: modelNameSchema
  })
  .strict();

const projectStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    stage: z.enum(["CREATED", "PLANNED"]),
    topic: z.string().min(1),
    language: z.string().min(2).max(35),
    models: z
      .object({
        text: modelNameSchema,
        image: modelNameSchema,
        tts: modelNameSchema
      })
      .strict(),
    planHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

export interface CreateProjectInput {
  topic: string;
  language: string;
  textModel: string;
  imageModel: string;
  ttsModel: string;
}

export interface ProjectPaths {
  root: string;
  state: string;
  plan: string;
}

export type ProjectState = z.infer<typeof projectStateSchema>;

function slugifyTopic(topic: string): string {
  const slug = topic
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");

  if (slug.length > 0) return slug;
  return `shorts-${createHash("sha256").update(topic).digest("hex").slice(0, 12)}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
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

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export class ProjectStore {
  private readonly projectPaths: ProjectPaths;

  constructor(root: string) {
    const resolvedRoot = resolve(root);
    this.projectPaths = {
      root: resolvedRoot,
      state: join(resolvedRoot, "project.json"),
      plan: join(resolvedRoot, "creative-plan.json")
    };
  }

  paths(): ProjectPaths {
    return { ...this.projectPaths };
  }

  async create(input: CreateProjectInput): Promise<ProjectState> {
    const parsedInput = createProjectInputSchema.parse(input);
    const topic = parseTopic(parsedInput.topic);
    await mkdir(this.projectPaths.root, { recursive: true, mode: 0o700 });
    if (await pathExists(this.projectPaths.state)) {
      throw new Error(`Shorts project already exists at ${this.projectPaths.state}`);
    }

    const timestamp = new Date().toISOString();
    const state = projectStateSchema.parse({
      schemaVersion: 1,
      projectId: slugifyTopic(topic),
      stage: "CREATED",
      topic,
      language: parsedInput.language,
      models: {
        text: parsedInput.textModel,
        image: parsedInput.imageModel,
        tts: parsedInput.ttsModel
      },
      createdAt: timestamp,
      updatedAt: timestamp
    });

    await atomicWrite(this.projectPaths.state, serializeJson(state));
    return state;
  }

  async savePlan(value: unknown): Promise<ProjectState> {
    const plan = parseCreativePlan(value);
    const current = await this.load();
    if (current.stage !== "CREATED" && current.stage !== "PLANNED") {
      throw new Error(`Cannot save a creative plan while project is ${current.stage}`);
    }
    if (plan.topic !== current.topic) {
      throw new Error("Creative plan topic does not match the project topic");
    }
    if (plan.language !== current.language) {
      throw new Error("Creative plan language does not match the project language");
    }

    const serializedPlan = serializeJson(plan);
    const planHash = createHash("sha256").update(serializedPlan).digest("hex");
    await atomicWrite(this.projectPaths.plan, serializedPlan);

    const next = projectStateSchema.parse({
      ...current,
      stage: "PLANNED",
      planHash,
      updatedAt: new Date().toISOString()
    });
    await atomicWrite(this.projectPaths.state, serializeJson(next));
    return next;
  }

  async load(): Promise<ProjectState> {
    const text = await readFile(this.projectPaths.state, "utf8");
    return projectStateSchema.parse(JSON.parse(text) as unknown);
  }
}

export type { CreativePlan };
