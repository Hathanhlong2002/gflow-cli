import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { artifactRecordSchema, type ArtifactRecord } from "./generation-journal.js";
import type { BinaryMedia, PcmAudio } from "./gemini-transport.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PCM_BYTES = 8 * 1024 * 1024;

function safeRelativePath(root: string, path: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  const child = relative(resolvedRoot, resolvedPath);
  if (child.length === 0 || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Artifact path is outside the project output directory");
  }
  return child.split(sep).join("/");
}

async function atomicWriteBytes(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${dirname(path)}/.${basename(path)}.${randomUUID()}.tmp`;
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

function hasImageSignature(media: BinaryMedia): boolean {
  if (media.mimeType === "image/jpeg") {
    return media.bytes.length >= 3 && media.bytes[0] === 0xff && media.bytes[1] === 0xd8 && media.bytes[2] === 0xff;
  }
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  return media.bytes.length >= png.length && png.every((byte, index) => media.bytes[index] === byte);
}

function artifact(path: string, bytes: Uint8Array, mimeType: ArtifactRecord["mimeType"]): ArtifactRecord {
  return artifactRecordSchema.parse({
    path,
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    mimeType
  });
}

export async function writeSceneImage(input: { root: string; path: string; media: BinaryMedia }): Promise<ArtifactRecord> {
  if (input.media.bytes.byteLength === 0 || input.media.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error("Image byte length is invalid");
  }
  if (!hasImageSignature(input.media)) throw new Error("Image MIME type does not match its signature");
  const relativePath = safeRelativePath(input.root, input.path);
  const expectedSuffix = input.media.mimeType === "image/jpeg" ? "/start.jpg" : "/start.png";
  if (!relativePath.endsWith(expectedSuffix)) throw new Error("Image output extension does not match its MIME type");
  await atomicWriteBytes(input.path, input.media.bytes);
  return artifact(relativePath, input.media.bytes, input.media.mimeType);
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  target.set(new TextEncoder().encode(value), offset);
}

export function pcmToWav(audio: PcmAudio): Uint8Array {
  if (
    audio.sampleRate !== 24000 ||
    audio.channels !== 1 ||
    audio.bitsPerSample !== 16 ||
    audio.pcm.byteLength === 0 ||
    audio.pcm.byteLength % 2 !== 0 ||
    audio.pcm.byteLength > MAX_PCM_BYTES
  ) {
    throw new Error("PCM must be non-empty mono 24 kHz signed 16-bit audio within the size limit");
  }

  const wav = new Uint8Array(44 + audio.pcm.byteLength);
  const view = new DataView(wav.buffer);
  writeAscii(wav, 0, "RIFF");
  view.setUint32(4, 36 + audio.pcm.byteLength, true);
  writeAscii(wav, 8, "WAVE");
  writeAscii(wav, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, audio.channels, true);
  view.setUint32(24, audio.sampleRate, true);
  view.setUint32(28, audio.sampleRate * audio.channels * (audio.bitsPerSample / 8), true);
  view.setUint16(32, audio.channels * (audio.bitsPerSample / 8), true);
  view.setUint16(34, audio.bitsPerSample, true);
  writeAscii(wav, 36, "data");
  view.setUint32(40, audio.pcm.byteLength, true);
  wav.set(audio.pcm, 44);
  return wav;
}

export async function writeNarration(input: { root: string; path: string; audio: PcmAudio }): Promise<ArtifactRecord> {
  const relativePath = safeRelativePath(input.root, input.path);
  if (!relativePath.endsWith("/narration.wav")) throw new Error("Narration output must end in narration.wav");
  const wav = pcmToWav(input.audio);
  await atomicWriteBytes(input.path, wav);
  return artifact(relativePath, wav, "audio/wav");
}
