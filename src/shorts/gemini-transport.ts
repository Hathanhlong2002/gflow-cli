import { Buffer } from "node:buffer";
import { z } from "zod";

const DEFAULT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_RESPONSE_BYTES = 28_500_000;
const MAX_AUDIO_RESPONSE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const RETRY_DELAYS_MS = [15_000, 30_000, 60_000] as const;

const geminiEnvelopeSchema = z
  .object({
    candidates: z.array(
      z.object({
        content: z.object({
          parts: z.array(
            z
              .object({
                text: z.string().optional(),
                inlineData: z
                  .object({
                    mimeType: z.string(),
                    data: z.string()
                  })
                  .strict()
                  .optional()
              })
              .passthrough()
          )
        }).passthrough()
      }).passthrough()
    )
  })
  .passthrough();

export interface GeminiJsonRequest {
  model: string;
  systemInstruction: string;
  prompt: string;
  responseSchema: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface GeminiTransport {
  generateJson(input: GeminiJsonRequest): Promise<unknown>;
}

export interface BinaryMedia {
  mimeType: "image/jpeg" | "image/png";
  bytes: Uint8Array;
}

export interface PcmAudio {
  sampleRate: 24000;
  channels: 1;
  bitsPerSample: 16;
  pcm: Uint8Array;
}

export interface GeminiMediaTransport {
  generateImage(input: { model: string; prompt: string; aspectRatio: "9:16" | "16:9"; signal?: AbortSignal }): Promise<BinaryMedia>;
  generateSpeech(input: { model: string; text: string; voice: string; signal?: AbortSignal }): Promise<PcmAudio>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class GeminiTransportError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number
  ) {
    super(message);
    this.name = "GeminiTransportError";
  }
}

export interface GoogleGeminiTransportOptions {
  apiKey: string;
  endpointBase?: string;
  fetcher?: FetchLike;
  timeoutMs?: number;
}

async function readLimitedBody(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new GeminiTransportError("Gemini response is too large", "RESPONSE_TOO_LARGE", response.status);
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const result = await reader.read();
    if (result.done) break;
    totalBytes += result.value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      throw new GeminiTransportError("Gemini response is too large", "RESPONSE_TOO_LARGE", response.status);
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

function decodeBase64(data: string, maximumBytes: number): Uint8Array {
  if (data.length === 0 || data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw new GeminiTransportError("Gemini returned invalid base64 media", "INVALID_BASE64");
  }
  const decoded = Buffer.from(data, "base64");
  if (decoded.toString("base64") !== data) {
    throw new GeminiTransportError("Gemini returned invalid base64 media", "INVALID_BASE64");
  }
  if (decoded.byteLength > maximumBytes) {
    throw new GeminiTransportError("Gemini decoded media is too large", "MEDIA_TOO_LARGE");
  }
  return new Uint8Array(decoded);
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

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function wait(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export class GoogleGeminiTransport implements GeminiTransport, GeminiMediaTransport {
  private readonly apiKey: string;
  private readonly endpointBase: URL;
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: GoogleGeminiTransportOptions) {
    if (options.apiKey.length === 0) throw new Error("GEMINI_API_KEY is required");
    const endpointBase = new URL(options.endpointBase ?? DEFAULT_ENDPOINT);
    if (endpointBase.protocol !== "https:") throw new Error("Gemini endpoint must use HTTPS");

    this.apiKey = options.apiKey;
    this.endpointBase = endpointBase;
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async generateContent(model: string, body: Record<string, unknown>, maximumBytes: number, signal?: AbortSignal): Promise<z.infer<typeof geminiEnvelopeSchema>> {
    if (!/^[a-zA-Z0-9._-]+$/.test(model)) {
      throw new GeminiTransportError("Invalid Gemini model name", "INVALID_MODEL");
    }
    const endpoint = new URL(`models/${model}:generateContent`, this.endpointBase);

    let response: Response | undefined;
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        response = await this.fetcher(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": this.apiKey
          },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs)
        });
      } catch {
        throw new GeminiTransportError("Gemini request failed", "REQUEST_FAILED");
      }

      if (response.ok) break;
      const status = response.status;
      const delay = retryDelayMs(response, attempt);
      await response.body?.cancel().catch(() => undefined);
      if (!isRetryableStatus(status) || attempt === RETRY_DELAYS_MS.length) {
        throw new GeminiTransportError(`Gemini request failed with HTTP ${status}`, "HTTP_ERROR", status);
      }
      await wait(delay);
    }

    if (!response?.ok) throw new GeminiTransportError("Gemini request failed", "REQUEST_FAILED");
    const responseText = await readLimitedBody(response, maximumBytes);
    try {
      return geminiEnvelopeSchema.parse(JSON.parse(responseText) as unknown);
    } catch (error) {
      if (error instanceof GeminiTransportError) throw error;
      throw new GeminiTransportError("Gemini returned an invalid response envelope", "INVALID_RESPONSE");
    }
  }

  async generateJson(input: GeminiJsonRequest): Promise<unknown> {
    const envelope = await this.generateContent(
      input.model,
      {
          system_instruction: { parts: [{ text: input.systemInstruction }] },
          contents: [{ role: "user", parts: [{ text: input.prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseJsonSchema: input.responseSchema
          }
      },
      MAX_JSON_RESPONSE_BYTES,
      input.signal
    );

    const generatedText = envelope.candidates
      .flatMap((candidate) => candidate.content.parts)
      .map((part) => part.text)
      .find((text): text is string => typeof text === "string" && text.length > 0);
    if (!generatedText) {
      throw new GeminiTransportError("Gemini response did not contain generated JSON", "MISSING_CONTENT");
    }

    try {
      return JSON.parse(generatedText) as unknown;
    } catch {
      throw new GeminiTransportError("Gemini generated invalid JSON", "INVALID_GENERATED_JSON");
    }
  }

  async generateImage(input: { model: string; prompt: string; aspectRatio: "9:16" | "16:9"; signal?: AbortSignal }): Promise<BinaryMedia> {
    const prompt = z.string().trim().min(1).max(10_000).parse(input.prompt);
    const envelope = await this.generateContent(
      input.model,
      {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: { aspectRatio: input.aspectRatio }
        }
      },
      MAX_IMAGE_RESPONSE_BYTES,
      input.signal
    );
    const inlineData = envelope.candidates.flatMap((candidate) => candidate.content.parts).find((part) => part.inlineData)?.inlineData;
    if (!inlineData) throw new GeminiTransportError("Gemini response did not contain inline image data", "MISSING_CONTENT");
    if (inlineData.mimeType !== "image/jpeg" && inlineData.mimeType !== "image/png") {
      throw new GeminiTransportError("Gemini returned an unsupported image MIME type", "INVALID_MIME");
    }
    return { mimeType: inlineData.mimeType, bytes: decodeBase64(inlineData.data, MAX_IMAGE_BYTES) };
  }

  async generateSpeech(input: { model: string; text: string; voice: string; signal?: AbortSignal }): Promise<PcmAudio> {
    const text = z.string().trim().min(1).max(10_000).parse(input.text);
    const voice = z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9._-]+$/).parse(input.voice);
    const envelope = await this.generateContent(
      input.model,
      {
        contents: [{ role: "user", parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } }
        }
      },
      MAX_AUDIO_RESPONSE_BYTES,
      input.signal
    );
    const inlineData = envelope.candidates.flatMap((candidate) => candidate.content.parts).find((part) => part.inlineData)?.inlineData;
    if (!inlineData) throw new GeminiTransportError("Gemini response did not contain inline audio data", "MISSING_CONTENT");
    if (inlineData.mimeType !== "audio/L16;codec=pcm;rate=24000") {
      throw new GeminiTransportError("Gemini returned an unsupported audio MIME type", "INVALID_MIME");
    }
    const pcm = decodeBase64(inlineData.data, MAX_AUDIO_BYTES);
    if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
      throw new GeminiTransportError("Gemini returned invalid 16-bit PCM audio", "INVALID_PCM");
    }
    return { sampleRate: 24000, channels: 1, bitsPerSample: 16, pcm };
  }
}
