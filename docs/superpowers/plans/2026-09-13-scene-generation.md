# Scene Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add resumable `gflow shorts generate` that creates a Gemini opening image and narration segment for every planned scene, then drives Google Flow to produce all 100 eight-second vertical clips.

**Architecture:** A durable generation journal records each scene artifact and checksum independently from the creative manifest. Gemini media and Flow are narrow injected adapters; the orchestrator validates every provider result before checkpointing and turns login, CAPTCHA, quota, rate-limit, or UI-contract failures into a durable pause. The CLI composes real adapters while tests use filesystem-backed state and deterministic provider fakes.

**Tech Stack:** Node.js 20+, TypeScript ESM, native `fetch`, Playwright/Google Flow adapter, Zod 3, Vitest 1

**Spec:** `docs/superpowers/specs/2026-09-13-flow-shorts-factory-design.md`

## Global Constraints

- Work and commit directly on `main`, as explicitly requested by the repository owner.
- A project has exactly 100 scenes: ten episodes with ten 8-second scenes each.
- Images are JPEG or PNG, at most 20 MiB, and must have a valid signature.
- Narration is generated per scene as 24 kHz, mono, signed 16-bit PCM and stored as WAV.
- Each Flow job uses ratio `9:16`, duration `8`, outputs `1`, the scene image as `startFrame`, and a deterministic ID `ep-NN-scene-NN`.
- Default concurrency is two Gemini images, one Gemini TTS request, and one Flow job; Flow jobs never run concurrently.
- API keys, cookies, authorization headers, provider response bodies, and upload URLs never enter state or errors.
- Provider binary bodies are capped before allocation: 20 MiB image, 8 MiB PCM audio, 200 MiB video.
- Login, CAPTCHA, manual action, credit, rate-limit, and Flow UI contract errors stop the run as `PAUSED`; no automatic account cycling or limit bypass is allowed.
- Resume trusts an artifact only when its size and SHA-256 match the journal and its format validation still passes.

---

### Task 1: Durable generation journal

**Files:**
- Create: `src/shorts/generation-journal.ts`
- Create: `tests/shorts.generation-journal.test.ts`
- Modify: `src/shorts/project-store.ts`

**Interfaces:**
- Consumes: `CreativePlan`, `ProjectStore.paths()`, and fixed 10×10 constants.
- Produces: `GenerationJournal`, `SceneGenerationRecord`, `ArtifactRecord`, `GenerationJournalStore.create(planHash)`, `.load()`, `.save(journal)`, and `.pathsFor(episodeIndex, sceneIndex)`.

- [ ] **Step 1: Write failing filesystem tests**

```ts
it("creates exactly 100 pending scene records", async () => {
  const journal = await new GenerationJournalStore(root).create("a".repeat(64));
  expect(journal.status).toBe("GENERATING");
  expect(journal.scenes).toHaveLength(100);
  expect(journal.scenes[0]).toMatchObject({ id: "ep-01-scene-01", status: "PENDING" });
  expect(journal.scenes[99]).toMatchObject({ id: "ep-10-scene-10", status: "PENDING" });
});

it("rejects traversal-like indexes and unknown persisted fields", async () => {
  const store = new GenerationJournalStore(root);
  expect(() => store.pathsFor(0, 1)).toThrow(/index/i);
  expect(() => store.pathsFor(1, 11)).toThrow(/index/i);
  await writeFile(join(root, "generation.json"), JSON.stringify({ ...validJournal(), injected: true }));
  await expect(store.load()).rejects.toThrow();
});

it("atomically checkpoints one completed image without changing other scenes", async () => {
  const store = new GenerationJournalStore(root);
  const journal = await store.create("a".repeat(64));
  journal.scenes[0].image = { path: "episodes/01/scenes/01/start.jpg", bytes: 4, sha256: "b".repeat(64), mimeType: "image/jpeg" };
  await store.save(journal);
  expect((await store.load()).scenes.filter((scene) => scene.image)).toHaveLength(1);
});
```

- [ ] **Step 2: Run `npm test -- tests/shorts.generation-journal.test.ts` and verify RED because the module is absent.**

- [ ] **Step 3: Implement strict Zod schemas, fixed paths, and atomic JSON writes**

```ts
export interface ScenePaths {
  directory: string;
  imageJpeg: string;
  imagePng: string;
  narration: string;
  video: string;
  metadata: string;
}

export class GenerationJournalStore {
  constructor(private readonly root: string) {}
  create(planHash: string): Promise<GenerationJournal>;
  load(): Promise<GenerationJournal>;
  save(journal: GenerationJournal): Promise<void>;
  pathsFor(episodeIndex: number, sceneIndex: number): ScenePaths;
}
```

Use 1-based integer indexes limited to 1–10 and construct paths only with formatted numeric segments. `imageJpeg` ends in `start.jpg`; `imagePng` ends in `start.png`, and the validated provider MIME chooses one. Journal status is `GENERATING | PAUSED | GENERATED`; each scene status is `PENDING | MEDIA_READY | COMPLETED | FAILED`. Artifact records contain only relative path, byte count, SHA-256, and validated MIME type. Write with the same random-sibling, `0600`, fsync, rename approach as `ProjectStore`.

- [ ] **Step 4: Run focused tests, then `npm test`, `npm run lint`, and `npm run build`; all must pass.**

- [ ] **Step 5: Commit**

```bash
git add src/shorts/generation-journal.ts src/shorts/project-store.ts tests/shorts.generation-journal.test.ts
git commit -m "feat: checkpoint shorts scene generation"
```

### Task 2: Bounded Gemini media transport

**Files:**
- Modify: `src/shorts/gemini-transport.ts`
- Create: `tests/shorts.gemini-media-transport.test.ts`

**Interfaces:**
- Consumes: existing HTTPS endpoint, timeout, redacted error model, and `FetchLike`.
- Produces: `GeminiMediaTransport.generateImage(input): Promise<BinaryMedia>` and `.generateSpeech(input): Promise<PcmAudio>` implemented by `GoogleGeminiTransport`.

- [ ] **Step 1: Write failing request/response boundary tests**

```ts
it("requests a 9:16 image and returns validated inline bytes", async () => {
  const transport = transportFor(geminiInlineResponse("image/jpeg", JPEG_BYTES));
  await expect(transport.generateImage({ model: "gemini-image", prompt: "scene", aspectRatio: "9:16" }))
    .resolves.toEqual({ mimeType: "image/jpeg", bytes: JPEG_BYTES });
  expect(sentBody().generationConfig).toMatchObject({ responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "9:16" } });
});

it("requests single-speaker audio and decodes bounded PCM", async () => {
  const transport = transportFor(geminiInlineResponse("audio/L16;codec=pcm;rate=24000", PCM_BYTES));
  await expect(transport.generateSpeech({ model: "gemini-tts", text: "Lời kể", voice: "Kore" }))
    .resolves.toEqual({ sampleRate: 24000, channels: 1, bitsPerSample: 16, pcm: PCM_BYTES });
});

it.each(["text/html", "image/svg+xml"])("rejects unsafe image MIME %s", async (mimeType) => {
  await expect(transportFor(geminiInlineResponse(mimeType, JPEG_BYTES)).generateImage(imageInput)).rejects.toThrow(/MIME/i);
});
```

Add tests for invalid base64, missing inline data, even-byte PCM requirement, decoded size limits, invalid model names, HTTP failures, and secret redaction.

- [ ] **Step 2: Run `npm test -- tests/shorts.gemini-media-transport.test.ts` and verify RED because media methods do not exist.**

- [ ] **Step 3: Implement media methods using the existing request helper**

```ts
export interface BinaryMedia { mimeType: "image/jpeg" | "image/png"; bytes: Uint8Array; }
export interface PcmAudio { sampleRate: 24000; channels: 1; bitsPerSample: 16; pcm: Uint8Array; }
export interface GeminiMediaTransport {
  generateImage(input: { model: string; prompt: string; aspectRatio: "9:16" }): Promise<BinaryMedia>;
  generateSpeech(input: { model: string; text: string; voice: string }): Promise<PcmAudio>;
}
```

Refactor only the shared authenticated POST/envelope parsing into a private helper. Decode `inlineData.data` with strict base64 round-trip validation and enforce decoded caps. Accept only JPEG/PNG for images and the exact 24 kHz L16 PCM contract for speech.

- [ ] **Step 4: Run focused tests, full tests, lint, and build; all must pass.**

- [ ] **Step 5: Commit**

```bash
git add src/shorts/gemini-transport.ts tests/shorts.gemini-media-transport.test.ts
git commit -m "feat: generate bounded Gemini scene media"
```

### Task 3: Scene image and narration artifact writers

**Files:**
- Create: `src/shorts/media-artifacts.ts`
- Create: `tests/shorts.media-artifacts.test.ts`

**Interfaces:**
- Consumes: `BinaryMedia`, `PcmAudio`, and fixed `ScenePaths`.
- Produces: `writeSceneImage(input): Promise<ArtifactRecord>`, `pcmToWav(audio): Uint8Array`, and `writeNarration(input): Promise<ArtifactRecord>`.

- [ ] **Step 1: Write failing real-file tests**

```ts
it("writes a JPEG only when MIME and magic bytes agree", async () => {
  await expect(writeSceneImage({ path: imagePath, media: { mimeType: "image/jpeg", bytes: JPEG_BYTES } }))
    .resolves.toMatchObject({ mimeType: "image/jpeg", bytes: JPEG_BYTES.length });
  await expect(writeSceneImage({ path: imagePath, media: { mimeType: "image/png", bytes: JPEG_BYTES } }))
    .rejects.toThrow(/signature/i);
});

it("wraps PCM in a canonical mono 24 kHz 16-bit WAV", () => {
  const wav = pcmToWav({ sampleRate: 24000, channels: 1, bitsPerSample: 16, pcm: new Uint8Array([0, 0, 1, 0]) });
  expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
  expect(new DataView(wav.buffer).getUint32(24, true)).toBe(24000);
  expect(new TextDecoder().decode(wav.slice(36, 40))).toBe("data");
});
```

Add tests for PNG signature, oversized/empty files, odd PCM length, atomic output, and SHA-256 over exact file bytes.

- [ ] **Step 2: Run `npm test -- tests/shorts.media-artifacts.test.ts` and verify RED.**

- [ ] **Step 3: Implement signature validation, WAV encoding, atomic binary writes, and digest records.**

Use `DataView` little-endian fields for the 44-byte WAV header. Never derive extensions from provider strings; the journal path decides `.jpg` or `.png` only after validated MIME selection.

- [ ] **Step 4: Run focused tests, full tests, lint, and build; all must pass.**

- [ ] **Step 5: Commit**

```bash
git add src/shorts/media-artifacts.ts tests/shorts.media-artifacts.test.ts
git commit -m "feat: persist validated scene media"
```

### Task 4: Google Flow scene adapter

**Files:**
- Create: `src/shorts/flow-generator.ts`
- Create: `tests/shorts.flow-generator.test.ts`

**Interfaces:**
- Consumes: existing `FlowAutomation.runJob`, planned scene, and validated image path.
- Produces: `SceneGenerator.generate(input): Promise<FlowArtifact>` implemented by `GoogleFlowSceneGenerator`.

- [ ] **Step 1: Write a failing contract test against a fake `FlowAutomation`**

```ts
it("maps a planned scene to one 8-second 9:16 Flow job", async () => {
  const automation: FlowAutomation = { runJob: vi.fn(async () => flowResult) };
  const generator = new GoogleFlowSceneGenerator(automation);
  await generator.generate({ episodeIndex: 2, sceneIndex: 3, scene, imagePath, outDir });
  expect(automation.runJob).toHaveBeenCalledWith({
    job: expect.objectContaining({ id: "ep-02-scene-03", type: "video", ratio: "9:16", duration: 8, outputs: 1, startFrame: imagePath }),
    outDir
  });
});
```

Add tests that zero or multiple artifacts fail, scene text cannot set paths/options, and hard-stop Flow errors retain their typed class for the orchestrator.

- [ ] **Step 2: Run `npm test -- tests/shorts.flow-generator.test.ts` and verify RED.**

- [ ] **Step 3: Implement deterministic translation and single-artifact enforcement.**

```ts
export interface SceneGenerator {
  generate(input: GenerateSceneInput): Promise<FlowArtifact>;
}
export class GoogleFlowSceneGenerator implements SceneGenerator {
  constructor(private readonly automation: FlowAutomation) {}
  generate(input: GenerateSceneInput): Promise<FlowArtifact>;
}
```

- [ ] **Step 4: Run focused tests, full tests, lint, and build; all must pass.**

- [ ] **Step 5: Commit**

```bash
git add src/shorts/flow-generator.ts tests/shorts.flow-generator.test.ts
git commit -m "feat: generate shorts scenes through Flow"
```

### Task 5: Resumable generation orchestrator

**Files:**
- Create: `src/shorts/generation-service.ts`
- Create: `tests/shorts.generation-service.test.ts`

**Interfaces:**
- Consumes: creative plan, project state/hash, journal store, Gemini media transport, artifact writers, and `SceneGenerator`.
- Produces: `generateShortsProject(input): Promise<GenerationJournal>`.

- [ ] **Step 1: Write failing end-to-end service tests with real temp files and deterministic provider fakes**

```ts
it("checkpoints image, narration, and video for every scene", async () => {
  const result = await generateShortsProject(harness());
  expect(result.status).toBe("GENERATED");
  expect(result.scenes.every((scene) => scene.status === "COMPLETED")).toBe(true);
  expect(fakeImage.calls).toBe(100);
  expect(fakeSpeech.calls).toBe(100);
  expect(fakeFlow.calls).toBe(100);
});

it("resumes at the first missing artifact without repeating valid work", async () => {
  await seedCompletedScenes(37);
  await generateShortsProject(harness());
  expect(fakeImage.calls).toBe(63);
  expect(fakeFlow.calls).toBe(63);
});

it.each([LoginRequiredError, ManualActionRequiredError, CreditLimitError, RateLimitedError, UiContractError])(
  "durably pauses on %p",
  async (ErrorType) => {
    fakeFlow.failAt(4, new ErrorType("manual action"));
    await expect(generateShortsProject(harness())).rejects.toBeInstanceOf(ErrorType);
    expect((await journalStore.load()).status).toBe("PAUSED");
  }
);
```

Add checksum-tampering, plan-hash mismatch, invalid provider artifact, narration/image partial resume, failure checkpoint, and no-concurrent-Flow tests.

- [ ] **Step 2: Run `npm test -- tests/shorts.generation-service.test.ts` and verify RED.**

- [ ] **Step 3: Implement ordered stages with bounded queues and checkpoint after each artifact.**

```ts
export interface GenerateShortsInput {
  project: ProjectState;
  plan: CreativePlan;
  journalStore: GenerationJournalStore;
  gemini: GeminiMediaTransport;
  sceneGenerator: SceneGenerator;
  resume: boolean;
}
export async function generateShortsProject(input: GenerateShortsInput): Promise<GenerationJournal>;
```

Generate media per scene, then run Flow sequentially. Before skipping, read the artifact and verify bytes/hash/signature. On a hard-stop error set journal status `PAUSED`, write `action-required.json` with only stable code and user action, save the journal, then rethrow. No retry in this service; provider-specific bounded retry is a later observability/retry layer.

- [ ] **Step 4: Run focused tests, full tests, lint, and build; all must pass.**

- [ ] **Step 5: Commit**

```bash
git add src/shorts/generation-service.ts tests/shorts.generation-service.test.ts
git commit -m "feat: resume shorts scene generation"
```

### Task 6: `gflow shorts generate` CLI

**Files:**
- Modify: `src/shorts/commands.ts`
- Modify: `src/cli.ts`
- Create: `tests/shorts.generate-cli.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `generateShortsProject`, real Gemini/Flow adapters, `ProjectStore`, and persistent browser session behavior.
- Produces: `gflow shorts generate <project.json> [--resume] [--profile <name>] [--browser chrome|chromium] [--headed|--no-headed]`.

- [ ] **Step 1: Write failing CLI tests with injected Gemini and Flow adapters**

```ts
it("loads a planned project and runs generation in resume mode", async () => {
  const program = createProgram({ shortsMedia: fakeGemini, shortsSceneGenerator: fakeFlow });
  await program.parseAsync(["node", "gflow", "shorts", "generate", projectJson, "--resume"]);
  expect(JSON.parse(await readFile(generationJson, "utf8"))).toMatchObject({ status: "GENERATED" });
});

it("requires a Gemini key only when no media adapter is injected", async () => {
  const program = createProgram({ environment: {} });
  await expect(program.parseAsync(["node", "gflow", "shorts", "generate", projectJson])).rejects.toThrow(/GEMINI_API_KEY/);
});
```

Add tests for rejecting non-`PLANNED` projects, incorrect manifest path, missing `--resume` on an existing journal, and preserving all existing commands.

- [ ] **Step 2: Run `npm test -- tests/shorts.generate-cli.test.ts` and verify RED.**

- [ ] **Step 3: Register the command and lazily open one browser session for the whole run.**

Refactor the existing real Flow session constructor into an injectable factory without altering legacy command behavior. Close the session in `finally`. Print counts and a manual-action message, never prompts, cookies, provider bodies, or secrets.

- [ ] **Step 4: Update README with login, generate, pause, and resume commands.**

```bash
npm run dev -- auth login --profile shorts
npm run dev -- shorts generate ./shorts-output/ocean/project.json --profile shorts --resume
```

- [ ] **Step 5: Run `npm test`, `npm run lint`, `npm run build`, and `npm audit --omit=dev`; all must pass with zero production advisories.**

- [ ] **Step 6: Commit**

```bash
git add src/shorts/commands.ts src/cli.ts tests/shorts.generate-cli.test.ts README.md
git commit -m "feat: add resumable shorts generation command"
```

## Milestone verification

- [ ] `npm test` passes with all new and legacy tests.
- [ ] `npm run lint` reports zero errors.
- [ ] `npm run build` exits 0.
- [ ] `npm audit --omit=dev` reports zero production vulnerabilities.
- [ ] `git diff --check HEAD~6 HEAD` reports no whitespace errors.
- [ ] A fake-adapter CLI run creates 100 complete journal records without a network call.
- [ ] No real Google account, Flow credits, Gemini credits, or social account is used by automated verification.
