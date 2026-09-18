import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep, join } from "node:path";
import {
  CreditLimitError,
  GenerationBlockedError,
  LoginRequiredError,
  ManualActionRequiredError,
  RateLimitedError,
  UiContractError
} from "../errors.js";
import { artifactRecordSchema, type ArtifactRecord, type GenerationJournal, type SceneGenerationRecord, type GenerationJournalStore } from "./generation-journal.js";
import type { GeminiMediaTransport } from "./gemini-transport.js";
import { writeNarration } from "./media-artifacts.js";
import type { ProjectState } from "./project-store.js";
import { SHORTS_EPISODE_COUNT, SHORTS_SCENE_COUNT, type CreativePlan } from "./schema.js";
import type { SceneGenerator } from "./flow-generator.js";

const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
const ACTION_REQUIRED = "action-required.json";

export interface GenerateShortsInput {
  root: string;
  project: ProjectState;
  plan: CreativePlan;
  journalStore: GenerationJournalStore;
  gemini: GeminiMediaTransport;
  sceneGenerator: SceneGenerator;
  resume: boolean;
}

interface PauseReason {
  code: string;
  userAction: string;
}

function hashPlan(plan: CreativePlan): string {
  return createHash("sha256").update(`${JSON.stringify(plan, null, 2)}\n`).digest("hex");
}

function pauseReason(error: unknown): PauseReason | undefined {
  if (error instanceof LoginRequiredError) return { code: "LOGIN_REQUIRED", userAction: "Sign in to Flow manually, then resume this project." };
  if (error instanceof ManualActionRequiredError) return { code: "MANUAL_ACTION_REQUIRED", userAction: "Complete the requested action in the Flow browser, then resume this project." };
  if (error instanceof CreditLimitError) return { code: "CREDIT_LIMIT", userAction: "Resolve the Flow quota issue manually, then resume this project." };
  if (error instanceof RateLimitedError) return { code: "RATE_LIMITED", userAction: "Wait for Flow's rate limit to reset, then resume this project." };
  if (error instanceof UiContractError) return { code: "UI_CONTRACT_CHANGED", userAction: "Review the Flow UI change before resuming this project." };
  if (error instanceof GenerationBlockedError) return { code: "GENERATION_BLOCKED", userAction: "Review Flow's block notice and resolve it manually before resuming." };
  return undefined;
}

function sceneAt(journal: GenerationJournal, episodeIndex: number, sceneIndex: number): SceneGenerationRecord {
  return journal.scenes[(episodeIndex - 1) * SHORTS_SCENE_COUNT + sceneIndex - 1];
}

function relativePath(root: string, path: string): string {
  const rel = relative(resolve(root), resolve(path));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Artifact path escaped the project directory");
  return rel.split(sep).join("/");
}

function hasImageSignature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return mimeType === "image/png" && bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
}

function validWav(bytes: Uint8Array): boolean {
  if (bytes.length < 46) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
    view.getUint32(4, true) === bytes.length - 8 &&
    new TextDecoder().decode(bytes.slice(8, 12)) === "WAVE" &&
    new TextDecoder().decode(bytes.slice(12, 16)) === "fmt " &&
    view.getUint32(16, true) === 16 && view.getUint16(20, true) === 1 &&
    view.getUint16(22, true) === 1 && view.getUint32(24, true) === 24000 &&
    view.getUint32(28, true) === 48000 && view.getUint16(32, true) === 2 &&
    view.getUint16(34, true) === 16 && new TextDecoder().decode(bytes.slice(36, 40)) === "data" &&
    view.getUint32(40, true) === bytes.length - 44 && (bytes.length - 44) % 2 === 0;
}

function validMp4(bytes: Uint8Array): boolean {
  if (bytes.length < 16 || new TextDecoder().decode(bytes.slice(4, 8)) !== "ftyp") return false;
  const boxSize = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  return boxSize >= 16 && boxSize <= bytes.length;
}

function validFormat(bytes: Uint8Array, mimeType: ArtifactRecord["mimeType"]): boolean {
  if (mimeType === "image/jpeg" || mimeType === "image/png") return hasImageSignature(bytes, mimeType);
  if (mimeType === "audio/wav") return validWav(bytes);
  return validMp4(bytes);
}

async function readSafeFile(root: string, path: string, maximumBytes: number): Promise<Uint8Array> {
  const canonicalRoot = await realpath(root);
  const canonicalPath = await realpath(path);
  const relativePath = relative(canonicalRoot, canonicalPath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("Artifact path is outside its allowed directory");
  }
  const handle = await open(canonicalPath, "r");
  try {
    const fileInfo = await handle.stat();
    if (!fileInfo.isFile() || fileInfo.size <= 0 || fileInfo.size > maximumBytes) {
      throw new Error("Artifact size or file type is invalid");
    }
    const bytes = new Uint8Array(fileInfo.size);
    let offset = 0;
    while (offset < fileInfo.size) {
      const { bytesRead } = await handle.read(bytes, offset, fileInfo.size - offset, offset);
      if (bytesRead === 0) throw new Error("Artifact changed while being read");
      offset += bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function verifyArtifact(root: string, record: ArtifactRecord, expectedPath: string): Promise<void> {
  if (record.path !== relativePath(root, expectedPath)) throw new Error("Journal artifact path does not match its fixed scene path");
  const maximumBytes = record.mimeType.startsWith("image/") ? 20 * 1024 * 1024 :
    record.mimeType === "audio/wav" ? 8 * 1024 * 1024 + 44 : MAX_VIDEO_BYTES;
  const bytes = await readSafeFile(root, expectedPath, maximumBytes);
  if (bytes.byteLength !== record.bytes || createHash("sha256").update(bytes).digest("hex") !== record.sha256) {
    throw new Error(`Artifact checksum mismatch at ${record.path}`);
  }
  if (!validFormat(bytes, record.mimeType)) throw new Error(`Artifact format validation failed at ${record.path}`);
}

async function readGeneratedVideo(root: string, outDir: string, artifactPath: string): Promise<Uint8Array> {
  const bytes = await readSafeFile(outDir, artifactPath, MAX_VIDEO_BYTES);
  if (!validMp4(bytes)) throw new Error("Flow artifact is not a valid MP4 file");
  // Ensure the provider output is also located inside the project, not merely inside an
  // arbitrary directory supplied by the adapter.
  relativePath(root, artifactPath);
  return bytes;
}

async function atomicWriteBytes(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(bytes);
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

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteBytes(path, new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function generateShortsProject(input: GenerateShortsInput): Promise<GenerationJournal> {
  const root = resolve(input.root);
  if (input.project.stage !== "PLANNED" || !input.project.planHash) throw new Error("Shorts project must be PLANNED before generation");
  const planHash = hashPlan(input.plan);
  if (input.plan.topic !== input.project.topic || planHash !== input.project.planHash) throw new Error("Creative plan hash does not match project state");
  const journalPath = join(root, "generation.json");
  const alreadyExists = await exists(journalPath);
  if (alreadyExists && !input.resume) throw new Error("A generation journal already exists; pass --resume to continue it");

  const journal = alreadyExists ? await input.journalStore.load() : await input.journalStore.create(planHash);
  if (journal.planHash !== planHash) throw new Error("Generation journal plan hash does not match the creative plan");
  if (journal.status === "GENERATED") {
    await verifyRecordedArtifacts(input, journal);
    return journal;
  }
  journal.status = "GENERATING";

  let checkpointTail = Promise.resolve();
  const checkpoint = (): Promise<void> => {
    checkpointTail = checkpointTail.then(() => input.journalStore.save(journal));
    return checkpointTail;
  };
  let activeScene: SceneGenerationRecord | undefined;
  const flowOutDir = join(root, "flow-output");

  try {
    await checkpoint();
    for (let episodeIndex = 1; episodeIndex <= SHORTS_EPISODE_COUNT; episodeIndex += 1) {
      for (let sceneIndex = 1; sceneIndex <= SHORTS_SCENE_COUNT; sceneIndex += 1) {
        const record = sceneAt(journal, episodeIndex, sceneIndex);
        const paths = input.journalStore.pathsFor(episodeIndex, sceneIndex);
        if (record.image) await verifyArtifact(root, record.image, record.image.mimeType === "image/jpeg" ? paths.imageJpeg : paths.imagePng);
        if (record.narration) await verifyArtifact(root, record.narration, paths.narration);
        if (record.video) await verifyArtifact(root, record.video, paths.video);
      }
    }

    for (let episodeIndex = 1; episodeIndex <= SHORTS_EPISODE_COUNT; episodeIndex += 1) {
      for (let sceneIndex = 1; sceneIndex <= SHORTS_SCENE_COUNT; sceneIndex += 1) {
        const record = sceneAt(journal, episodeIndex, sceneIndex);
        if (record.video) {
          record.status = record.narration ? "COMPLETED" : "MEDIA_READY";
          continue;
        }
        activeScene = record;
        const paths = input.journalStore.pathsFor(episodeIndex, sceneIndex);
        const planScene = input.plan.episodes[episodeIndex - 1].scenes[sceneIndex - 1];
        const generated = await input.sceneGenerator.generate({
          episodeIndex,
          sceneIndex,
          scene: planScene,
          outDir: flowOutDir
        });
        const bytes = await readGeneratedVideo(root, flowOutDir, generated.path);
        await atomicWriteBytes(paths.video, bytes);
        record.video = artifactRecordSchema.parse({
          path: relativePath(root, paths.video),
          bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          mimeType: "video/mp4"
        });
        record.status = record.narration ? "COMPLETED" : "MEDIA_READY";
        record.error = undefined;
        await checkpoint();
      }
    }

    for (let episodeIndex = 1; episodeIndex <= SHORTS_EPISODE_COUNT; episodeIndex += 1) {
      for (let sceneIndex = 1; sceneIndex <= SHORTS_SCENE_COUNT; sceneIndex += 1) {
        const record = sceneAt(journal, episodeIndex, sceneIndex);
        if (record.narration) {
          record.status = record.video ? "COMPLETED" : "MEDIA_READY";
          continue;
        }
        activeScene = record;
        const paths = input.journalStore.pathsFor(episodeIndex, sceneIndex);
        const planScene = input.plan.episodes[episodeIndex - 1].scenes[sceneIndex - 1];
        const audio = await input.gemini.generateSpeech({ model: input.project.models.tts, text: planScene.narration, voice: "Kore" });
        record.narration = await writeNarration({ root, path: paths.narration, audio });
        record.status = record.video ? "COMPLETED" : "MEDIA_READY";
        record.error = undefined;
        await checkpoint();
      }
    }

    journal.status = "GENERATED";
    await checkpoint();
    await unlink(join(root, ACTION_REQUIRED)).catch(() => undefined);
    return journal;
  } catch (error) {
    const pause = pauseReason(error);
    if (activeScene) {
      activeScene.status = "FAILED";
      activeScene.error = {
        code: pause?.code ?? "GENERATION_FAILED",
        message: pause ? "Generation paused for required manual action." : "Generation failed; resolve the issue before resuming."
      };
    }
    if (pause) {
      journal.status = "PAUSED";
      await atomicWriteJson(join(root, ACTION_REQUIRED), pause);
    }
    await checkpoint();
    throw error;
  }
}

async function verifyRecordedArtifacts(input: GenerateShortsInput, journal: GenerationJournal): Promise<void> {
  for (const scene of journal.scenes) {
    const paths = input.journalStore.pathsFor(scene.episodeIndex, scene.sceneIndex);
    if (scene.status !== "COMPLETED" || !scene.narration || !scene.video) {
      throw new Error(`Generated scene ${scene.id} has missing artifacts or an incomplete status`);
    }
    if (scene.image) await verifyArtifact(input.root, scene.image, scene.image.mimeType === "image/jpeg" ? paths.imageJpeg : paths.imagePng);
    await verifyArtifact(input.root, scene.narration, paths.narration);
    await verifyArtifact(input.root, scene.video, paths.video);
  }
}
