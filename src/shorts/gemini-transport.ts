import { z } from "zod";

const DEFAULT_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const geminiEnvelopeSchema = z
  .object({
    candidates: z.array(
      z.object({
        content: z.object({
          parts: z.array(z.object({ text: z.string().optional() }).passthrough())
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
}

export interface GeminiTransport {
  generateJson(input: GeminiJsonRequest): Promise<unknown>;
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

async function readLimitedBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_RESPONSE_BYTES) {
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
    if (totalBytes > MAX_RESPONSE_BYTES) {
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

export class GoogleGeminiTransport implements GeminiTransport {
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

  async generateJson(input: GeminiJsonRequest): Promise<unknown> {
    if (!/^[a-zA-Z0-9._-]+$/.test(input.model)) {
      throw new GeminiTransportError("Invalid Gemini model name", "INVALID_MODEL");
    }
    const endpoint = new URL(`models/${input.model}:generateContent`, this.endpointBase);

    let response: Response;
    try {
      response = await this.fetcher(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": this.apiKey
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: input.systemInstruction }] },
          contents: [{ role: "user", parts: [{ text: input.prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseJsonSchema: input.responseSchema
          }
        }),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch {
      throw new GeminiTransportError("Gemini request failed", "REQUEST_FAILED");
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new GeminiTransportError(`Gemini request failed with HTTP ${response.status}`, "HTTP_ERROR", response.status);
    }

    const responseText = await readLimitedBody(response);
    let envelope: z.infer<typeof geminiEnvelopeSchema>;
    try {
      envelope = geminiEnvelopeSchema.parse(JSON.parse(responseText) as unknown);
    } catch {
      throw new GeminiTransportError("Gemini returned an invalid response envelope", "INVALID_RESPONSE");
    }

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
}
