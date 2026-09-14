import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { GoogleGeminiTransport, type FetchLike } from "../src/shorts/gemini-transport.js";

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const PCM_BYTES = new Uint8Array([0, 0, 1, 0]);

function inlineResponse(mimeType: string, bytes: Uint8Array, data = Buffer.from(bytes).toString("base64")): Response {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ inlineData: { mimeType, data } }] } }]
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("Gemini media transport", () => {
  it("retries a rate-limited request using Retry-After before returning media", async () => {
    let attempts = 0;
    const fetcher: FetchLike = async () => {
      attempts += 1;
      if (attempts === 1) return new Response(null, { status: 429, headers: { "retry-after": "0" } });
      return inlineResponse("audio/L16;codec=pcm;rate=24000", PCM_BYTES);
    };
    const transport = new GoogleGeminiTransport({ apiKey: "secret", fetcher });

    await expect(transport.generateSpeech({ model: "gemini-tts", text: "Lời kể", voice: "Kore" })).resolves.toEqual({
      sampleRate: 24000,
      channels: 1,
      bitsPerSample: 16,
      pcm: PCM_BYTES
    });
    expect(attempts).toBe(2);
  });

  it("requests a 9:16 image and returns decoded inline bytes", async () => {
    const fetcher = vi.fn<Parameters<FetchLike>, ReturnType<FetchLike>>(async () => inlineResponse("image/jpeg", JPEG_BYTES));
    const transport = new GoogleGeminiTransport({ apiKey: "secret", fetcher });

    await expect(transport.generateImage({ model: "gemini-image", prompt: "underwater scene", aspectRatio: "9:16" }))
      .resolves.toEqual({ mimeType: "image/jpeg", bytes: JPEG_BYTES });

    const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(body.generationConfig).toEqual({ responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "9:16" } });
  });

  it("requests single-speaker narration and returns 24 kHz PCM", async () => {
    const fetcher = vi.fn<Parameters<FetchLike>, ReturnType<FetchLike>>(
      async () => inlineResponse("audio/L16;codec=pcm;rate=24000", PCM_BYTES)
    );
    const transport = new GoogleGeminiTransport({ apiKey: "secret", fetcher });

    await expect(transport.generateSpeech({ model: "gemini-tts", text: "Lời kể", voice: "Kore" })).resolves.toEqual({
      sampleRate: 24000,
      channels: 1,
      bitsPerSample: 16,
      pcm: PCM_BYTES
    });

    const body = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(body.generationConfig).toMatchObject({
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } }
    });
  });

  it.each(["text/html", "image/svg+xml"])("rejects unsafe image MIME %s", async (mimeType) => {
    const fetcher: FetchLike = async () => inlineResponse(mimeType, JPEG_BYTES);
    const transport = new GoogleGeminiTransport({ apiKey: "secret", fetcher });

    await expect(transport.generateImage({ model: "gemini-image", prompt: "scene", aspectRatio: "9:16" }))
      .rejects.toThrow(/MIME/i);
  });

  it("rejects invalid base64 instead of decoding partial data", async () => {
    const fetcher: FetchLike = async () => inlineResponse("image/jpeg", JPEG_BYTES, "!!!!");
    const transport = new GoogleGeminiTransport({ apiKey: "secret", fetcher });

    await expect(transport.generateImage({ model: "gemini-image", prompt: "scene", aspectRatio: "9:16" }))
      .rejects.toThrow(/base64/i);
  });

  it("rejects odd-length PCM", async () => {
    const fetcher: FetchLike = async () => inlineResponse("audio/L16;codec=pcm;rate=24000", new Uint8Array([0, 1, 2]));
    const transport = new GoogleGeminiTransport({ apiKey: "secret", fetcher });

    await expect(transport.generateSpeech({ model: "gemini-tts", text: "Lời kể", voice: "Kore" }))
      .rejects.toThrow(/PCM/i);
  });

  it("rejects an oversized media envelope from content-length", async () => {
    const fetcher: FetchLike = async () => new Response("x", {
      status: 200,
      headers: { "content-length": String(28 * 1024 * 1024) }
    });
    const transport = new GoogleGeminiTransport({ apiKey: "secret", fetcher });

    await expect(transport.generateImage({ model: "gemini-image", prompt: "scene", aspectRatio: "9:16" }))
      .rejects.toThrow(/too large/i);
  });
});
