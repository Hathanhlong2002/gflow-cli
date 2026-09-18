import { Buffer } from "node:buffer";
import { z } from "zod";
import type { FetchLike } from "../shorts/gemini-transport.js";
import type { SongPlan, SongSection } from "./schema.js";

const INTERACTIONS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions";
const DEFAULT_TIMEOUT_MS = 600_000;
const MAX_RESPONSE_BYTES = 96 * 1024 * 1024;
const MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const RETRY_DELAYS_MS = [15_000, 30_000, 60_000] as const;

const contentBlockSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
    data: z.string().optional(),
    mime_type: z.string().optional(),
    mimeType: z.string().optional()
  })
  .passthrough();

const interactionSchema = z
  .object({
    steps: z.array(
      z.object({
        type: z.string(),
        content: z.array(contentBlockSchema).optional()
      }).passthrough()
    )
  })
  .passthrough();

export interface GeneratedSong {
  mimeType: "audio/mpeg";
  bytes: Uint8Array;
  outputText: string;
  structureText?: string;
}

export interface MusicGenerator {
  generate(input: { model: string; plan: SongPlan; signal?: AbortSignal }): Promise<GeneratedSong>;
}

export interface GoogleLyriaTransportOptions {
  apiKey: string;
  fetcher?: FetchLike;
  timeoutMs?: number;
  retryDelaysMs?: readonly number[];
}

export class LyriaTransportError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "LyriaTransportError";
  }
}

function formatTimestamp(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function sectionPrompt(section: SongSection): string {
  const header = `[${formatTimestamp(section.startSeconds)} - ${formatTimestamp(section.endSeconds)}] ${section.kind}`;
  if (section.lyrics.length === 0) return `${header}: Instrumental section, energy ${section.energy}/5.`;
  return `${header}: Energy ${section.energy}/5.\n${section.lyrics.join("\n")}`;
}

export function buildLyriaPrompt(plan: SongPlan): string {
  return [
    `Create an original full-length ${plan.language} vocal song about ${JSON.stringify(plan.topic)}.`,
    `Title: ${plan.title}`,
    `Genre: ${plan.genre}`,
    `Mood: ${plan.mood}`,
    `Tempo: ${plan.bpm} BPM${plan.key ? `, key ${plan.key}` : ""}`,
    `Vocal direction: ${plan.vocalDirection}`,
    `Target duration: ${plan.targetDurationSeconds} seconds. Follow the timestamps and lyrics exactly.`,
    "Do not imitate a named artist and do not quote existing copyrighted lyrics.",
    "Lyrics:",
    ...plan.sections.map(sectionPrompt)
  ].join("\n");
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function retryDelayMs(response: Response, retryIndex: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return RETRY_DELAYS_MS[retryIndex] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
}

async function wait(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function readLimitedBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new LyriaTransportError("Lyria response is too large", "RESPONSE_TOO_LARGE", response.status);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    totalBytes += result.value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new LyriaTransportError("Lyria response is too large", "RESPONSE_TOO_LARGE", response.status);
    }
    chunks.push(result.value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function decodeBase64Mp3(data: string): Uint8Array {
  if (data.length === 0 || data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw new LyriaTransportError("Lyria returned invalid base64 audio", "INVALID_BASE64");
  }
  const decoded = Buffer.from(data, "base64");
  if (decoded.toString("base64") !== data) {
    throw new LyriaTransportError("Lyria returned invalid base64 audio", "INVALID_BASE64");
  }
  if (decoded.byteLength === 0 || decoded.byteLength > MAX_AUDIO_BYTES) {
    throw new LyriaTransportError("Lyria decoded audio is too large or empty", "INVALID_AUDIO_SIZE");
  }
  const isId3 = decoded.byteLength >= 3 && decoded[0] === 0x49 && decoded[1] === 0x44 && decoded[2] === 0x33;
  const isFrame = decoded.byteLength >= 2 && decoded[0] === 0xff && (decoded[1] & 0xe0) === 0xe0;
  if (!isId3 && !isFrame) throw new LyriaTransportError("Lyria returned an invalid MP3 signature", "INVALID_MP3");
  return new Uint8Array(decoded);
}

function parseInteraction(value: unknown): GeneratedSong {
  let interaction: z.infer<typeof interactionSchema>;
  try {
    interaction = interactionSchema.parse(value);
  } catch {
    throw new LyriaTransportError("Lyria returned an invalid response envelope", "INVALID_RESPONSE");
  }

  const blocks = interaction.steps
    .filter((step) => step.type === "model_output")
    .flatMap((step) => step.content ?? []);
  const textBlocks = blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text!.trim())
    .filter((text) => text.length > 0);
  if (textBlocks.length === 0) {
    throw new LyriaTransportError("Lyria response did not contain generated lyrics or structure text", "MISSING_TEXT");
  }

  const audio = blocks.find((block) => block.type === "audio" && typeof block.data === "string");
  if (!audio?.data) throw new LyriaTransportError("Lyria response did not contain generated audio", "MISSING_AUDIO");
  const mimeType = audio.mime_type ?? audio.mimeType;
  if (mimeType !== "audio/mpeg" && mimeType !== "audio/mp3") {
    throw new LyriaTransportError("Lyria returned an unsupported audio MIME type", "INVALID_MIME");
  }

  const structureText = textBlocks.find((text) => text.startsWith("{") && text.endsWith("}"));
  return {
    mimeType: "audio/mpeg",
    bytes: decodeBase64Mp3(audio.data),
    outputText: textBlocks.join("\n"),
    ...(structureText ? { structureText } : {})
  };
}

export class GoogleLyriaTransport implements MusicGenerator {
  private readonly apiKey: string;
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: readonly number[];

  constructor(options: GoogleLyriaTransportOptions) {
    if (options.apiKey.length === 0) throw new Error("GEMINI_API_KEY is required");
    this.apiKey = options.apiKey;
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryDelaysMs = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  }

  async generate(input: { model: string; plan: SongPlan; signal?: AbortSignal }): Promise<GeneratedSong> {
    const model = z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9._-]+$/, "invalid model name").parse(input.model);
    const requestBody = {
      model,
      input: buildLyriaPrompt(input.plan),
      response_format: { type: "audio" }
    };

    let response: Response | undefined;
    for (let attempt = 0; attempt <= this.retryDelaysMs.length; attempt += 1) {
      try {
        response = await this.fetcher(new URL(INTERACTIONS_ENDPOINT), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": this.apiKey
          },
          body: JSON.stringify(requestBody),
          signal: input.signal
            ? AbortSignal.any([input.signal, AbortSignal.timeout(this.timeoutMs)])
            : AbortSignal.timeout(this.timeoutMs)
        });
      } catch (error) {
        if (input.signal?.aborted) throw input.signal.reason;
        if (attempt === this.retryDelaysMs.length || (error instanceof Error && error.name === "AbortError")) {
          throw new LyriaTransportError("Lyria request failed", "REQUEST_FAILED");
        }
        await wait(this.retryDelaysMs[attempt] ?? 0);
        continue;
      }

      if (response.ok) break;
      const status = response.status;
      const delay = response.headers.has("retry-after")
        ? retryDelayMs(response, attempt)
        : (this.retryDelaysMs[attempt] ?? 0);
      await response.body?.cancel().catch(() => undefined);
      if (!isRetryableStatus(status) || attempt === this.retryDelaysMs.length) {
        throw new LyriaTransportError(`Lyria request failed with HTTP ${status}`, "HTTP_ERROR", status);
      }
      await wait(delay);
    }

    if (!response?.ok) throw new LyriaTransportError("Lyria request failed", "REQUEST_FAILED");
    const responseText = await readLimitedBody(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(responseText) as unknown;
    } catch {
      throw new LyriaTransportError("Lyria returned invalid JSON", "INVALID_JSON");
    }
    return parseInteraction(parsed);
  }
}
