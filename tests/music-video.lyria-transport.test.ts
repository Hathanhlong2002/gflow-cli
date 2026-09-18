import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import type { FetchLike } from "../src/shorts/gemini-transport.js";
import { GoogleLyriaTransport, LyriaTransportError } from "../src/music-video/lyria-transport.js";
import { validSongPlan } from "./fixtures/music-video.js";

const MP3_BYTES = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);

function lyriaResponse(options: { mimeType?: string; data?: string; outputText?: string } = {}): Response {
  return new Response(JSON.stringify({
    id: "interaction-1",
    status: "completed",
    steps: [
      {
        type: "model_output",
        content: [
          { type: "text", text: options.outputText ?? "[Intro]\nMưa rơi bên hiên vắng" },
          {
            type: "audio",
            mime_type: options.mimeType ?? "audio/mpeg",
            data: options.data ?? Buffer.from(MP3_BYTES).toString("base64")
          }
        ]
      }
    ]
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("Google Lyria transport", () => {
  it("sends a bounded Interactions request and extracts MP3 plus lyrics", async () => {
    const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
    const fetcher: FetchLike = async (input, init) => {
      calls.push({ input, init });
      return lyriaResponse();
    };
    const transport = new GoogleLyriaTransport({ apiKey: "secret", fetcher });

    await expect(transport.generate({ model: "lyria-3.5", plan: validSongPlan() })).resolves.toEqual({
      mimeType: "audio/mpeg",
      bytes: MP3_BYTES,
      outputText: "[Intro]\nMưa rơi bên hiên vắng"
    });

    expect(String(calls[0].input)).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.headers).toMatchObject({
      "content-type": "application/json",
      "x-goog-api-key": "secret"
    });
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body.model).toBe("lyria-3.5");
    expect(body.response_format).toEqual({ type: "audio" });
    expect(body.input).toMatch(/Tình yêu/);
    expect(body.input).toMatch(/\[0:00 - 0:20\]/);
    expect(body.input).toMatch(/Lyrics:/);
  });

  it("retries a rate limit using Retry-After without exposing response bodies", async () => {
    let attempts = 0;
    const fetcher: FetchLike = async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response("secret provider detail", { status: 429, headers: { "retry-after": "0" } });
      }
      return lyriaResponse();
    };
    const transport = new GoogleLyriaTransport({ apiKey: "secret", fetcher });

    await expect(transport.generate({ model: "lyria-3.5", plan: validSongPlan() })).resolves.toBeDefined();
    expect(attempts).toBe(2);
  });

  it("retries a transient network failure with bounded backoff", async () => {
    let attempts = 0;
    const transport = new GoogleLyriaTransport({
      apiKey: "secret",
      retryDelaysMs: [0],
      fetcher: async () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError("connection reset");
        return lyriaResponse();
      }
    });

    await expect(transport.generate({ model: "lyria-3.5", plan: validSongPlan() })).resolves.toBeDefined();
    expect(attempts).toBe(2);
  });

  it.each([
    ["unsupported MIME", lyriaResponse({ mimeType: "audio/wav" }), /MIME/i],
    ["malformed base64", lyriaResponse({ data: "!!!!" }), /base64/i],
    ["invalid MP3 signature", lyriaResponse({ data: Buffer.from([1, 2, 3, 4]).toString("base64") }), /MP3/i],
    ["missing lyrics", lyriaResponse({ outputText: "" }), /text|lyrics/i]
  ])("rejects %s", async (_name, response, expected) => {
    const transport = new GoogleLyriaTransport({ apiKey: "secret", fetcher: async () => response.clone() });
    await expect(transport.generate({ model: "lyria-3.5", plan: validSongPlan() })).rejects.toThrow(expected as RegExp);
  });

  it("rejects an oversized response before reading its body", async () => {
    const response = new Response("x", {
      status: 200,
      headers: { "content-length": String(97 * 1024 * 1024) }
    });
    const transport = new GoogleLyriaTransport({ apiKey: "secret", fetcher: async () => response });
    await expect(transport.generate({ model: "lyria-3.5", plan: validSongPlan() })).rejects.toThrow(/too large/i);
  });

  it("validates model names before sending and redacts HTTP failure details", async () => {
    let calls = 0;
    const fetcher: FetchLike = async () => {
      calls += 1;
      return new Response("secret provider body", { status: 400 });
    };
    const transport = new GoogleLyriaTransport({ apiKey: "secret", fetcher });

    await expect(transport.generate({ model: "../../unsafe", plan: validSongPlan() })).rejects.toThrow(/model/i);
    expect(calls).toBe(0);

    const failure = transport.generate({ model: "lyria-3.5", plan: validSongPlan() });
    await expect(failure).rejects.toBeInstanceOf(LyriaTransportError);
    await expect(failure).rejects.not.toThrow(/secret provider body/);
  });

  it("normalizes audio/mp3 to audio/mpeg", async () => {
    const transport = new GoogleLyriaTransport({ apiKey: "secret", fetcher: async () => lyriaResponse({ mimeType: "audio/mp3" }) });
    await expect(transport.generate({ model: "lyria-3.5", plan: validSongPlan() }))
      .resolves.toMatchObject({ mimeType: "audio/mpeg" });
  });
});
