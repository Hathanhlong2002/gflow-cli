import { describe, expect, it, vi } from "vitest";
import { GoogleGeminiTransport, type FetchLike } from "../src/shorts/gemini-transport.js";

const request = {
  model: "gemini-2.5-flash",
  systemInstruction: "Return a plan.",
  prompt: "Topic: ocean",
  responseSchema: { type: "object", required: ["episodes"] }
};

function geminiResponse(value: unknown): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }]
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("GoogleGeminiTransport", () => {
  it("requests structured JSON without putting the API key in the URL", async () => {
    const fetcher = vi.fn<Parameters<FetchLike>, ReturnType<FetchLike>>(async () => geminiResponse({ episodes: [] }));
    const transport = new GoogleGeminiTransport({ apiKey: "secret-key", fetcher });

    await expect(transport.generateJson(request)).resolves.toEqual({ episodes: [] });

    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
    expect(String(url)).not.toContain("secret-key");
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("secret-key");
    const body = JSON.parse(String(init?.body));
    expect(body.generationConfig).toEqual({
      responseMimeType: "application/json",
      responseJsonSchema: request.responseSchema
    });
  });

  it("does not include the API key or provider body in an HTTP error", async () => {
    const secret = "gemini-secret-value";
    const fetcher = vi.fn(async () => new Response(`denied ${secret}`, { status: 403 }));
    const transport = new GoogleGeminiTransport({ apiKey: secret, fetcher });

    let thrown: unknown;
    try {
      await transport.generateJson(request);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain("403");
    expect(String(thrown)).not.toContain(secret);
    expect(String(thrown)).not.toContain("denied");
  });

  it("rejects an oversized provider response before JSON parsing", async () => {
    const fetcher = vi.fn(async () => new Response("x", { status: 200, headers: { "content-length": "2097153" } }));
    const transport = new GoogleGeminiTransport({ apiKey: "secret-key", fetcher });

    await expect(transport.generateJson(request)).rejects.toThrow(/too large/i);
  });

  it("rejects non-HTTPS endpoint overrides", () => {
    expect(() => new GoogleGeminiTransport({
      apiKey: "secret-key",
      endpointBase: "http://localhost:8080",
      fetcher: vi.fn()
    })).toThrow(/HTTPS/i);
  });

  it("rejects responses without generated text", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ candidates: [] }), { status: 200 }));
    const transport = new GoogleGeminiTransport({ apiKey: "secret-key", fetcher });

    await expect(transport.generateJson(request)).rejects.toThrow(/generated JSON/i);
  });
});
