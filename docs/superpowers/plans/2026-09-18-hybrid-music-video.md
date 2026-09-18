# Hybrid Music Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a resumable `gflow music-video run` workflow that turns one topic into a Vietnamese vocal song and a finished three-minute 16:9 hybrid music video.

**Architecture:** Keep the fixed shorts domain unchanged and add a sibling `src/music-video` domain with strict schemas, small provider interfaces, durable checkpoints, and one orchestrator. Reuse the existing Gemini HTTP transport, Flow automation boundary, and FFmpeg probe/render work only through explicit interfaces; Lyria audio remains the authoritative timeline and generated visuals are trimmed to it.

**Tech Stack:** Node.js 20+, TypeScript/ESM, Commander, Zod, native `fetch`, Google Gemini Interactions API (`lyria-3.5`), Google Flow automation, FFmpeg/FFprobe, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-18-hybrid-music-video-design.md`

## Global Constraints

- Preserve every pre-existing uncommitted file and edit, especially `src/shorts/renderer.ts`, `tests/shorts.renderer.test.ts`, and Flow compatibility changes.
- Keep the existing 10-episode, 10-scene shorts schemas and commands behaviorally unchanged.
- Default output is H.264/AAC MP4, 1920x1080, square pixels, 30 fps, with duration matching the probed song within 0.25 seconds.
- Default creative configuration is Vietnamese, `lyria-3.5`, approximately eight Flow clips, and animated Gemini images for remaining timeline entries.
- Use `GEMINI_API_KEY` from the environment only. Never place credentials in command arguments, manifests, fixtures, logs, or error messages.
- Treat model output as untrusted: strict Zod validation, bounded response/media sizes, application-owned paths, and no shell interpolation.
- Invoke FFmpeg/FFprobe through `spawn` argument arrays with `shell: false`.
- Provider safety, authentication, CAPTCHA, rate-limit, and quota controls are never bypassed.
- Do not add a Google SDK dependency; use the existing injectable `FetchLike` pattern and the documented REST endpoint.
- Live API/Flow calls occur only in the final explicitly approved smoke test; all automated tests use fakes or local synthetic media.

## File Structure

### New production files

- `src/music-video/schema.ts` — strict song-plan, storyboard, artifact-journal, project-state, and parser schemas.
- `src/music-video/song-planner.ts` — structured Gemini request for original Vietnamese lyrics and music direction.
- `src/music-video/lyria-transport.ts` — bounded Gemini Interactions API client and Lyria response parser.
- `src/music-video/storyboard-planner.ts` — fixed timeline-window creation, structured visual planning, and deterministic eight-clip selection.
- `src/music-video/project-store.ts` — application-owned paths and atomic JSON/state/artifact checkpoint writes.
- `src/music-video/flow-generator.ts` — 16:9 Flow adapter for storyboard entries.
- `src/music-video/captions.ts` — lyric reconciliation and safe ASS generation.
- `src/music-video/renderer.ts` — hybrid still/video FFmpeg render and final media validation.
- `src/music-video/orchestrator.ts` — stage machine, resume reconciliation, provider ordering, and pause handling.
- `src/music-video/commands.ts` — Commander registration and dependency injection.

### Existing files to modify

- `src/shorts/gemini-transport.ts` — accept both `9:16` and `16:9` image ratios and export the bounded base64 helper needed by Lyria only if sharing keeps both adapters smaller.
- `src/shorts/renderer.ts` — leave unchanged by default; extract an existing process/probe primitive only if its currently uncommitted implementation can be preserved byte-for-byte in behavior.
- `src/cli.ts` — register `music-video` and extend injected dependencies.
- `src/index.ts` — no behavior change beyond using the updated CLI registration.
- `src/errors.ts` — add stable music-generation/render error types only where existing types do not fit.
- `README.md` and `docs/shorts-run-guide.md` — setup, usage, limits, and verified status.
- Workspace-level `../../TOOLS.md` — update outside the nested tool repository; do not try to include it in a child-repository commit.

### New tests and fixtures

- `tests/fixtures/music-video.ts`
- `tests/music-video.schema.test.ts`
- `tests/music-video.song-planner.test.ts`
- `tests/music-video.lyria-transport.test.ts`
- `tests/music-video.storyboard-planner.test.ts`
- `tests/music-video.project-store.test.ts`
- `tests/music-video.flow-generator.test.ts`
- `tests/music-video.captions.test.ts`
- `tests/music-video.renderer.test.ts`
- `tests/music-video.orchestrator.test.ts`
- `tests/music-video.cli.test.ts`

---

### Task 1: Establish a clean verified baseline around current user changes

**Files:**
- Inspect only: `src/shorts/renderer.ts`, `tests/shorts.renderer.test.ts`, and all paths reported by `git status --short`
- Modify only if an existing test exposes a defect required by later tasks

**Interfaces:**
- Consumes: current working tree exactly as supplied by the user
- Produces: recorded baseline test/build/lint results and a known-good renderer boundary

- [ ] **Step 1: Record the current diff without changing it**

Run:

```bash
git status --short
git diff -- src/cli.ts src/errors.ts src/flow/download.ts src/flow/page.ts src/index.ts src/shorts/commands.ts src/shorts/generation-service.ts tests/flow.fixture.test.ts tests/shorts.cli.test.ts tests/shorts.generation-service.test.ts
```

Expected: the listed user edits remain visible, plus untracked `src/shorts/renderer.ts`, `tests/shorts.renderer.test.ts`, and generated `shorts-output/`.

- [ ] **Step 2: Run the focused existing tests**

Run:

```bash
npx vitest run tests/shorts.renderer.test.ts tests/shorts.cli.test.ts tests/shorts.generation-service.test.ts tests/flow.fixture.test.ts
```

Expected: all focused tests pass. If a test fails, stop feature work and use `superpowers:systematic-debugging` before modifying implementation.

- [ ] **Step 3: Run the repository baseline checks**

Run:

```bash
npm test
npm run build
npm run lint
```

Expected: all commands exit zero. Record pre-existing failures verbatim before continuing.

- [ ] **Step 4: Preserve the baseline boundary**

Do not create a commit in this task. Do not add `shorts-output/` or any pre-existing uncommitted path to the index.

---

### Task 2: Define and validate the music-video domain contracts

**Files:**
- Create: `src/music-video/schema.ts`
- Create: `tests/fixtures/music-video.ts`
- Create: `tests/music-video.schema.test.ts`

**Interfaces:**
- Consumes: Zod and the topic constraints used by `src/shorts/schema.ts`
- Produces: `SongPlan`, `Storyboard`, `StoryboardEntry`, `MusicVideoProjectState`, `MusicVideoJournal`, `parseSongPlan()`, `parseStoryboard()`, `parseProjectState()`, and `parseJournal()`

- [ ] **Step 1: Write failing schema tests and a valid fixture**

Create a fixture with three short sections and four visual entries so tests stay readable. Include assertions equivalent to:

```ts
const plan = validSongPlan();
expect(parseSongPlan(plan)).toEqual(plan);
expect(() => parseSongPlan({ ...plan, language: "" })).toThrow();
expect(() => parseSongPlan({
  ...plan,
  sections: [
    { ...plan.sections[0], startSeconds: 0, endSeconds: 20 },
    { ...plan.sections[1], startSeconds: 19, endSeconds: 40 }
  ]
})).toThrow(/overlap|monotonic/i);

const storyboard = validStoryboard();
expect(parseStoryboard(storyboard, storyboard.durationSeconds)).toEqual(storyboard);
expect(() => parseStoryboard({
  ...storyboard,
  entries: storyboard.entries.slice(1)
}, storyboard.durationSeconds)).toThrow(/start|coverage/i);
```

Test that IDs are ordered (`section-01`, `visual-001`), timestamps are finite/non-negative, the first entry starts at zero, adjacent entries meet within 0.01 seconds, the final entry ends at the declared duration, exactly `min(8, entries.length)` entries have `mode: "flow-video"`, and artifact paths match `assets/<id>/start.(jpg|png)` or `assets/<id>/clip.mp4`.

- [ ] **Step 2: Run the schema tests to verify RED**

Run: `npx vitest run tests/music-video.schema.test.ts`

Expected: FAIL because `src/music-video/schema.ts` does not exist.

- [ ] **Step 3: Implement strict schemas**

Use these public shapes:

```ts
export type SongSectionKind = "intro" | "verse" | "pre-chorus" | "chorus" | "bridge" | "climax" | "outro" | "instrumental";

export interface SongSection {
  id: string;
  kind: SongSectionKind;
  startSeconds: number;
  endSeconds: number;
  lyrics: string[];
  energy: number; // integer 1..5
}

export interface StoryboardEntry {
  id: string;
  startSeconds: number;
  endSeconds: number;
  mode: "flow-video" | "animated-image";
  sectionId: string;
  visual: string;
  motionPrompt: string;
  importance: number; // integer 1..5
}
```

`SongPlan` also includes `schemaVersion: 1`, exact `topic`, `language`, `title`, `genre`, `mood`, `bpm`, optional `key`, `vocalDirection`, `targetDurationSeconds`, continuity fields, and ordered sections. Project state uses the stages from the spec and model keys `{ text, image, music }`. Journal records one image per entry and an optional video only for Flow entries, with SHA-256, positive byte count, and an allowlisted MIME type.

- [ ] **Step 4: Run schema tests and typecheck**

Run:

```bash
npx vitest run tests/music-video.schema.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit the domain contracts**

```bash
git add src/music-video/schema.ts tests/fixtures/music-video.ts tests/music-video.schema.test.ts
git commit -m "feat: define music video domain schemas"
```

---

### Task 3: Plan original Vietnamese songs with structured Gemini output

**Files:**
- Create: `src/music-video/song-planner.ts`
- Create: `tests/music-video.song-planner.test.ts`

**Interfaces:**
- Consumes: `GeminiTransport.generateJson()` and `parseSongPlan()`
- Produces: `SongPlanner.plan(input: { topic: string; language: string; model: string; targetDurationSeconds: number }): Promise<SongPlan>` and `GeminiSongPlanner`

- [ ] **Step 1: Write failing planner tests**

Use an injected fake transport and assert the request contains the exact topic as JSON-quoted data, `vi-VN`, a 180-second target, original-lyrics wording, timestamped sections, and the instruction not to imitate named artists. Also verify at most three attempts and a concise Zod-path error after three invalid candidates:

```ts
const planner = new GeminiSongPlanner({ generateJson });
await expect(planner.plan({
  topic: "Tình yêu",
  language: "vi-VN",
  model: "gemini-text",
  targetDurationSeconds: 180
})).resolves.toEqual(validSongPlan());
expect(generateJson).toHaveBeenCalledTimes(1);
expect(generateJson.mock.calls[0]![0].systemInstruction).toMatch(/topic as data/i);
```

- [ ] **Step 2: Run the planner tests to verify RED**

Run: `npx vitest run tests/music-video.song-planner.test.ts`

Expected: FAIL because the planner module does not exist.

- [ ] **Step 3: Implement the planner and exported JSON schema**

Mirror the repair-loop pattern in `src/shorts/planner.ts`, but use `MUSIC_PLAN_RESPONSE_SCHEMA`. Validate topic, language, model, and `targetDurationSeconds` before contacting Gemini. On each repair attempt, send only validation paths/messages, never the complete rejected payload.

The system instruction must say that the model is a music-video planner, the topic is untrusted data, output must match the schema, lyrics must be original, and vocal direction must describe qualities without naming or imitating an artist.

- [ ] **Step 4: Run focused and regression tests**

Run:

```bash
npx vitest run tests/music-video.song-planner.test.ts tests/shorts.planner.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit the song planner**

```bash
git add src/music-video/song-planner.ts tests/music-video.song-planner.test.ts
git commit -m "feat: plan original Vietnamese songs"
```

---

### Task 4: Add a bounded Lyria 3.5 Interactions API transport

**Files:**
- Create: `src/music-video/lyria-transport.ts`
- Create: `tests/music-video.lyria-transport.test.ts`
- Modify if sharing helpers is justified: `src/shorts/gemini-transport.ts`

**Interfaces:**
- Consumes: `FetchLike`, validated `SongPlan`, and `GEMINI_API_KEY`
- Produces: `MusicGenerator.generate(input: { model: string; plan: SongPlan }): Promise<GeneratedSong>` where `GeneratedSong` is `{ mimeType: "audio/mpeg"; bytes: Uint8Array; outputText: string; structureText?: string }`

- [ ] **Step 1: Write failing transport tests**

Build REST fixtures with `steps: [{ type: "model_output", content: [{ type: "text", text: "..." }, { type: "audio", mime_type: "audio/mpeg", data: "..." }] }]`. Assert:

```ts
expect(fetcher).toHaveBeenCalledWith(
  new URL("https://generativelanguage.googleapis.com/v1beta/interactions"),
  expect.objectContaining({
    method: "POST",
    headers: expect.objectContaining({ "x-goog-api-key": "secret" })
  })
);
expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({
  model: "lyria-3.5",
  response_format: { type: "audio" }
});
```

Add cases for retry-after zero on HTTP 429, missing audio, unsupported MIME, malformed base64, decoded audio over 64 MiB, response body over 96 MiB, invalid model names, abort timeout, and an HTTP error whose response contains `secret` but whose thrown message does not.

- [ ] **Step 2: Run the transport tests to verify RED**

Run: `npx vitest run tests/music-video.lyria-transport.test.ts`

Expected: FAIL because the transport module does not exist.

- [ ] **Step 3: Implement `GoogleLyriaTransport`**

Use `POST https://generativelanguage.googleapis.com/v1beta/interactions` with headers `content-type: application/json` and `x-goog-api-key`. Build a prompt containing genre, mood, BPM, vocal direction, requested 180-second structure, section timestamps, and lyrics separated under a `Lyrics:` marker.

Parse only `model_output` text/audio blocks. Accept `audio/mpeg` and normalize `audio/mp3` to `audio/mpeg`. Require non-empty output text and MP3 bytes beginning with either `ID3` or an MPEG frame sync. Use the existing capped retry policy semantics for 429/500/502/503/504 and `AbortSignal.timeout()`.

- [ ] **Step 4: Run transport and Gemini regression tests**

Run:

```bash
npx vitest run tests/music-video.lyria-transport.test.ts tests/shorts.gemini-transport.test.ts tests/shorts.gemini-media-transport.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit the Lyria adapter**

```bash
git add src/music-video/lyria-transport.ts tests/music-video.lyria-transport.test.ts src/shorts/gemini-transport.ts
git commit -m "feat: generate full songs with Lyria"
```

Omit `src/shorts/gemini-transport.ts` from `git add` when it was not modified.

---

### Task 5: Build a gap-free duration-aware visual storyboard

**Files:**
- Create: `src/music-video/storyboard-planner.ts`
- Create: `tests/music-video.storyboard-planner.test.ts`

**Interfaces:**
- Consumes: `GeminiTransport`, `SongPlan`, and probed song duration
- Produces: `StoryboardPlanner.plan(input: { plan: SongPlan; durationSeconds: number; model: string }): Promise<Storyboard>` and `buildTimelineWindows(durationSeconds, 8)`

- [ ] **Step 1: Write failing deterministic timeline tests**

Assert a 178.4-second song produces 23 windows, starts at 0, ends at 178.4, contains no gaps/overlaps, and has a final partial window. Feed Gemini visual metadata for all 23 IDs, then assert exactly eight modes become `flow-video`, including at least one opening entry, chorus entry, climax/bridge entry when present, and final entry.

```ts
const windows = buildTimelineWindows(178.4, 8);
expect(windows).toHaveLength(23);
expect(windows[0]).toEqual({ id: "visual-001", startSeconds: 0, endSeconds: 8 });
expect(windows.at(-1)?.endSeconds).toBe(178.4);
expect(storyboard.entries.filter((entry) => entry.mode === "flow-video")).toHaveLength(8);
```

Add invalid cases for non-finite duration, duration outside 30..240 seconds, missing visual IDs, duplicate IDs, and unsafe extra fields.

- [ ] **Step 2: Run storyboard tests to verify RED**

Run: `npx vitest run tests/music-video.storyboard-planner.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement fixed windows and structured visual planning**

Create exact windows in code; ask Gemini only for `{ id, sectionId, visual, motionPrompt, importance, suggestedMode }` per supplied ID. Join model metadata onto application-owned timestamps. Select up to eight Flow entries deterministically by required structural coverage, descending importance, then ascending timeline index. Validate the final joined object with `parseStoryboard()`.

- [ ] **Step 4: Run focused tests and typecheck**

Run:

```bash
npx vitest run tests/music-video.storyboard-planner.test.ts tests/music-video.schema.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit the storyboard planner**

```bash
git add src/music-video/storyboard-planner.ts tests/music-video.storyboard-planner.test.ts
git commit -m "feat: plan hybrid music video storyboards"
```

---

### Task 6: Persist project state and validated media artifacts atomically

**Files:**
- Create: `src/music-video/project-store.ts`
- Create: `tests/music-video.project-store.test.ts`
- Modify: `src/shorts/gemini-transport.ts`

**Interfaces:**
- Consumes: schemas from Task 2 and generated bytes from Tasks 4/8
- Produces: `MusicVideoProjectStore`, `MusicVideoPaths`, `writeSong()`, `writeImage()`, `recordArtifact()`, `artifactMatchesDisk()`, and `appendEvent()` for redacted JSONL events

- [ ] **Step 1: Write failing store and image-ratio tests**

Test that the store creates mode `0600` JSON files beneath its root, refuses an existing project with different topic/config, writes via temporary sibling and rename, rejects paths outside the root, rejects mismatched JPEG/PNG signatures, records hashes, and detects a modified file during resume.

Extend the existing Gemini media test with:

```ts
await transport.generateImage({
  model: "gemini-image",
  prompt: "cinematic love story",
  aspectRatio: "16:9"
});
expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: "16:9" });
```

- [ ] **Step 2: Run store/media tests to verify RED**

Run:

```bash
npx vitest run tests/music-video.project-store.test.ts tests/shorts.gemini-media-transport.test.ts
```

Expected: new store tests fail and the `16:9` TypeScript call fails until the ratio union is expanded.

- [ ] **Step 3: Implement the store and 16:9 image support**

Expose paths exactly matching the spec, including `logs/events.jsonl`. Use `open(path, "wx", 0o600)`, `sync()`, close, and atomic `rename()` for JSON and byte artifacts. Append only schema-validated, redacted event objects to the JSONL log. Validate MP3 signature/size before `audio/song.mp3`; image signature/size before `assets/<id>/start.jpg|png`; and copied Flow MP4 with the existing ISO-BMFF signature check plus FFprobe before journal completion.

Change `GeminiMediaTransport.generateImage()` and `GoogleGeminiTransport.generateImage()` to accept `aspectRatio: "9:16" | "16:9"`, preserving all current call sites.

- [ ] **Step 4: Run store, media, and shorts generation regressions**

Run:

```bash
npx vitest run tests/music-video.project-store.test.ts tests/shorts.gemini-media-transport.test.ts tests/shorts.generation-service.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit persistence support**

```bash
git add src/music-video/project-store.ts tests/music-video.project-store.test.ts src/shorts/gemini-transport.ts tests/shorts.gemini-media-transport.test.ts
git commit -m "feat: persist music video artifacts safely"
```

---

### Task 7: Generate 16:9 storyboard assets through Gemini and Flow

**Files:**
- Create: `src/music-video/flow-generator.ts`
- Create: `tests/music-video.flow-generator.test.ts`

**Interfaces:**
- Consumes: `FlowAutomation`, `StoryboardEntry`, application-owned output directory, and optional start-frame path
- Produces: `MusicVideoFlowGenerator.generate(input: GenerateVisualClipInput): Promise<FlowArtifact>`

- [ ] **Step 1: Write failing Flow adapter tests**

Inject a fake `FlowAutomation` and assert the exact parsed job:

```ts
expect(runJob).toHaveBeenCalledWith({
  job: expect.objectContaining({
    id: "music-visual-001",
    type: "video",
    ratio: "16:9",
    duration: 8,
    outputs: 1,
    startFrame: "/project/assets/visual-001/start.jpg"
  }),
  outDir: "/project/assets/visual-001"
});
```

Assert animated-image entries are rejected, IDs cannot escape their directory, and zero/multiple returned artifacts fail.

- [ ] **Step 2: Run Flow adapter tests to verify RED**

Run: `npx vitest run tests/music-video.flow-generator.test.ts`

Expected: FAIL because the adapter module does not exist.

- [ ] **Step 3: Implement the adapter**

Construct jobs through `parseVideoJob()` with application-generated `music-<entry.id>` IDs. Combine `visual` and `motionPrompt` as prompt text, use 16:9, one output, eight seconds, and the validated local start frame. Keep provider-specific details out of the orchestrator.

- [ ] **Step 4: Run Flow adapter and shorts adapter tests**

Run:

```bash
npx vitest run tests/music-video.flow-generator.test.ts tests/shorts.flow-generator.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit the Flow adapter**

```bash
git add src/music-video/flow-generator.ts tests/music-video.flow-generator.test.ts
git commit -m "feat: generate widescreen music video clips"
```

---

### Task 8: Produce safe karaoke-style ASS captions

**Files:**
- Create: `src/music-video/captions.ts`
- Create: `tests/music-video.captions.test.ts`

**Interfaces:**
- Consumes: validated `SongPlan`, Lyria `outputText`, and real song duration
- Produces: `reconcileLyrics()`, `buildCaptionCues()`, `renderAss()`, and `CaptionBuildResult` with `timing: "provider" | "approximate"`

- [ ] **Step 1: Write failing reconciliation and escaping tests**

Cover exact returned lyrics, returned section headings, at least 60% normalized planned-line agreement, rejection below that threshold, proportional line distribution inside each section, final cue clamping, and ASS escaping for `\`, `{`, `}`, line breaks, commas, quotes, and Unicode Vietnamese.

```ts
const result = buildCaptionCues(validSongPlan(), 178.4);
expect(result.cues[0].startSeconds).toBeGreaterThanOrEqual(0);
expect(result.cues.at(-1)!.endSeconds).toBeLessThanOrEqual(178.4);
expect(result.timing).toBe("approximate");
expect(renderAss(result.cues)).toContain("PlayResX: 1920");
expect(renderAss(result.cues)).toContain("PlayResY: 1080");
```

- [ ] **Step 2: Run caption tests to verify RED**

Run: `npx vitest run tests/music-video.captions.test.ts`

Expected: FAIL because the caption module does not exist.

- [ ] **Step 3: Implement line captions and accessible styling**

Use ASS timestamps with centisecond precision. Use a bottom-safe centered style, minimum 48 px text at 1080p, white active text, dark outline/backing, two visible lines maximum, and escaped plain lyric content. Distribute lines by grapheme count within the section when no valid provider line timestamps exist. Do not claim word-level alignment.

- [ ] **Step 4: Run caption tests and typecheck**

Run:

```bash
npx vitest run tests/music-video.captions.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit captions**

```bash
git add src/music-video/captions.ts tests/music-video.captions.test.ts
git commit -m "feat: add karaoke style lyric captions"
```

---

### Task 9: Render and validate the hybrid timeline

**Files:**
- Create: `src/music-video/renderer.ts`
- Create: `tests/music-video.renderer.test.ts`
- Preserve unchanged: `src/shorts/renderer.ts`, which is pre-existing uncommitted work

**Interfaces:**
- Consumes: `Storyboard`, image/Flow artifact paths, `song.mp3`, and `lyrics.ass`
- Produces: `renderMusicVideo(input: RenderMusicVideoInput): Promise<MusicVideoRenderResult>` and a music-domain-local `probeMusicMedia()`

- [ ] **Step 1: Write failing synthetic-media integration tests**

Generate tiny local fixtures with FFmpeg: two JPEG/PNG stills, one two-second 16:9 clip, a five-second stereo audio file, and an ASS file. Assert the renderer creates one 1920x1080 H.264 video stream and one AAC stereo stream, duration 5.0 ± 0.25 seconds, SHA-256, and `media-report.json`.

Add cases for missing assets, corrupt image/video, output path containing spaces and apostrophes, caption path containing a colon, FFmpeg timeout, nonzero exit cleanup, and a storyboard whose visuals do not cover the song.

- [ ] **Step 2: Run renderer tests to verify RED**

Run: `npx vitest run tests/music-video.renderer.test.ts`

Expected: FAIL because the renderer module does not exist.

- [ ] **Step 3: Implement the minimal safe filter graph**

For `animated-image`, loop the image and use scale/crop plus a bounded `zoompan` expression for the exact entry duration. For `flow-video`, normalize, trim, and pad to the entry duration. Apply short fade-in/fade-out transitions inside each entry without changing timeline length, concatenate video-only streams, burn the ASS file, map the original song as the only audio source, add `-shortest`, and encode H.264/AAC with faststart.

Keep every path in a separate spawn argument. Escape ASS filter filenames specifically for FFmpeg filter syntax and verify this with the special-character tests. Use random temporary sibling outputs and atomic rename. Keep the process/probe helpers local to this new module so the pre-existing uncommitted shorts renderer is not modified or staged.

- [ ] **Step 4: Run renderer regressions**

Run:

```bash
npx vitest run tests/music-video.renderer.test.ts tests/shorts.renderer.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit the hybrid renderer**

```bash
git add src/music-video/renderer.ts tests/music-video.renderer.test.ts
git commit -m "feat: render hybrid music videos"
```

---

### Task 10: Orchestrate checkpoints, resume, and pause behavior

**Files:**
- Create: `src/music-video/orchestrator.ts`
- Create: `tests/music-video.orchestrator.test.ts`

**Interfaces:**
- Consumes: `SongPlanner`, `MusicGenerator`, `StoryboardPlanner`, `GeminiMediaTransport`, `MusicVideoFlowGenerator`, `MusicVideoProjectStore`, probe function, caption builder, and renderer
- Produces: `runMusicVideo(input: RunMusicVideoInput): Promise<MusicVideoRunResult>`

- [ ] **Step 1: Write failing mocked end-to-end state tests**

Use injected fakes and assert call order: plan → song → probe → storyboard → all images → Flow-only clips → captions → render. Verify a fully successful run ends `READY`, writes all hashes, and returns `output/final.mp4`.

Add resume cases that skip an artifact only when its hash matches, regenerate a changed artifact and its downstream render, reject mismatched topic/config, reuse a single Flow session, close it on success/error, and write a redacted `action-required.json` plus `PAUSED` for `LoginRequiredError`, `ManualActionRequiredError`, `CreditLimitError`, `RateLimitedError`, `UiContractError`, or `GenerationBlockedError`.

```ts
expect(result.stage).toBe("READY");
expect(songPlanner.plan).toHaveBeenCalledTimes(1);
expect(musicGenerator.generate).toHaveBeenCalledTimes(1);
expect(imageGenerator.generateImage).toHaveBeenCalledTimes(storyboard.entries.length);
expect(flowGenerator.generate).toHaveBeenCalledTimes(8);
```

- [ ] **Step 2: Run orchestrator tests to verify RED**

Run: `npx vitest run tests/music-video.orchestrator.test.ts`

Expected: FAIL because the orchestrator module does not exist.

- [ ] **Step 3: Implement the stage machine**

Implement one transition function that validates legal stage changes. Checkpoint after the song, storyboard, every image, every Flow clip, captions, and final render. Save `song-plan.json`, `storyboard.json`, sanitized `audio/lyria-response.json`, and `audio/lyrics.txt` through the store, and append a redacted stage event after each successful checkpoint. Store only stable error codes and redacted messages. Bounded automatic retries remain inside transports; the orchestrator does not loop on policy/manual failures.

Use sequential Flow generation and at most two concurrent Gemini image requests. On Ctrl-C, stop scheduling new work, await the active atomic write, persist `CANCELLED`, and rethrow an interruption error.

- [ ] **Step 4: Run orchestration and store tests**

Run:

```bash
npx vitest run tests/music-video.orchestrator.test.ts tests/music-video.project-store.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit orchestration**

```bash
git add src/music-video/orchestrator.ts tests/music-video.orchestrator.test.ts
git commit -m "feat: orchestrate resumable music video runs"
```

---

### Task 11: Expose the all-in-one CLI command

**Files:**
- Create: `src/music-video/commands.ts`
- Create: `tests/music-video.cli.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/errors.ts` if stable error classes are needed

**Interfaces:**
- Consumes: `runMusicVideo()` and existing browser factory conventions
- Produces: `registerMusicVideoCommands(program, dependencies)` and the `gflow music-video run` command

- [ ] **Step 1: Write failing CLI tests**

Assert help exposes `music-video run`; defaults are `vi-VN`, 180 seconds, `gemini-3.5-flash`, `gemini-2.5-flash-image`, and `lyria-3.5`; missing `GEMINI_API_KEY` fails before opening Chrome; `--resume` is forwarded; browser/profile validation follows shorts conventions; and success prints the absolute final path and measured duration.

```ts
await program.parseAsync([
  "node", "gflow", "music-video", "run",
  "--topic", "Tình yêu",
  "--out", output,
  "--profile", "music"
]);
expect(run).toHaveBeenCalledWith(expect.objectContaining({
  topic: "Tình yêu",
  language: "vi-VN",
  targetDurationSeconds: 180,
  resume: false
}));
```

- [ ] **Step 2: Run CLI tests to verify RED**

Run: `npx vitest run tests/music-video.cli.test.ts`

Expected: FAIL because the command is not registered.

- [ ] **Step 3: Implement command registration and dependency resolution**

Register:

```text
gflow music-video run --topic <text> --out <dir>
  [--profile <name>] [--browser chrome|chromium]
  [--language <tag>] [--duration <seconds>]
  [--text-model <name>] [--image-model <name>] [--music-model <name>]
  [--resume] [--headed|--no-headed]
```

Resolve the API key before creating the browser. Parse duration as an integer constrained to 120..210 for the CLI while the lower-level schema accepts test durations. Create one Flow session only when a missing Flow asset must be generated. Print manual resume guidance on a pause and never print secrets or raw provider bodies.

- [ ] **Step 4: Run CLI and full automated tests**

Run:

```bash
npx vitest run tests/music-video.cli.test.ts tests/cli.help.test.ts tests/shorts.cli.test.ts
npm test
npm run build
npm run lint
```

Expected: all commands exit zero.

- [ ] **Step 5: Commit the CLI**

```bash
git add src/music-video/commands.ts tests/music-video.cli.test.ts
git add -p src/cli.ts src/errors.ts
git diff --cached --check
git commit -m "feat: add music video run command"
```

Omit `src/errors.ts` when unchanged. Stage only music-video hunks from `src/cli.ts` and `src/errors.ts`; leave every pre-existing unstaged hunk intact.

---

### Task 12: Document operation, limits, and workspace status

**Files:**
- Modify: `README.md`
- Modify: `docs/shorts-run-guide.md`
- Modify: `../../TOOLS.md`

**Interfaces:**
- Consumes: final CLI behavior and output layout
- Produces: reproducible Vietnamese setup/run/resume instructions and an accurate workspace inventory entry

- [ ] **Step 1: Add documentation assertions to the CLI/help test**

Read the README in `tests/music-video.cli.test.ts` and assert it contains `gflow music-video run`, `GEMINI_API_KEY`, `--resume`, `lyria-3.5`, `SynthID`, `1920x1080`, and the approximate-caption limitation.

- [ ] **Step 2: Run the documentation assertion to verify RED**

Run: `npx vitest run tests/music-video.cli.test.ts`

Expected: FAIL because the README does not describe the music-video workflow.

- [ ] **Step 3: Update documentation**

Document environment setup without showing a key value, Flow login, the `Tình yêu` example, resume behavior, output tree, 8-clip hybrid default, quota usage, line-level approximate timing, provider safety blocks, SynthID, and the fact that Flow automation is unofficial. Update `TOOLS.md` capability and status without claiming a live test has passed yet.

- [ ] **Step 4: Run documentation and repository checks**

Run:

```bash
npx vitest run tests/music-video.cli.test.ts
npm run build
npm run lint
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md docs/shorts-run-guide.md tests/music-video.cli.test.ts
git commit -m "docs: explain hybrid music video workflow"
```

Update `../../TOOLS.md` in the workspace after the child-repository commit and leave that workspace-level change outside the nested repository's index.

---

### Task 13: Verify locally, review the implementation, and run the approved live smoke test

**Files:**
- Modify only after observing results: `README.md`, `docs/shorts-run-guide.md`, `../../TOOLS.md`
- Generated and ignored: `music-output/tinh-yeu/`

**Interfaces:**
- Consumes: completed implementation, local `.env`, authenticated Flow profile, FFmpeg/FFprobe
- Produces: verified test evidence and one local `Tình yêu` music video or a precise manual-action report

- [ ] **Step 1: Run the complete offline verification suite**

Run:

```bash
npm test
npm run build
npm run lint
git diff --check
npm audit --omit=dev
```

Expected: tests/build/lint/diff checks pass and there are no unmitigated reachable high/critical production advisories.

- [ ] **Step 2: Request code review before paid generation**

Invoke `superpowers:requesting-code-review`. Address verified defects with `superpowers:receiving-code-review`, rerun affected tests, and keep unrelated user changes untouched.

- [ ] **Step 3: Confirm local prerequisites without exposing secrets**

Run:

```bash
test -n "$GEMINI_API_KEY" || test -f .env
ffmpeg -version
ffprobe -version
npm run dev -- doctor --profile music
```

Expected: a key source exists, FFmpeg/FFprobe execute, and the Flow session reports ready. Do not display `.env` or print the key.

- [ ] **Step 4: Run the approved `Tình yêu` smoke test**

Run:

```bash
npm run dev -- music-video run \
  --topic "Tình yêu" \
  --out ./music-output/tinh-yeu \
  --profile music
```

Expected: either `READY` with `music-output/tinh-yeu/output/final.mp4`, or a nonzero pause with `action-required.json`. If paused, perform no bypass; report the exact manual action and resume only after it is resolved:

```bash
npm run dev -- music-video run \
  --topic "Tình yêu" \
  --out ./music-output/tinh-yeu \
  --profile music \
  --resume
```

- [ ] **Step 5: Probe and inspect the final output**

Run:

```bash
ffprobe -v error -show_entries format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels -of json ./music-output/tinh-yeu/output/final.mp4
```

Expected: H.264 video, AAC stereo audio, 1920x1080, 30 fps, non-empty file, and duration matching `audio/song.mp3` within 0.25 seconds. Inspect a few frames for readable captions and correct aspect ratio without publishing or uploading the file.

- [ ] **Step 6: Record truthful verification status**

Update README/run guide/`TOOLS.md` with the date, automated test counts, live result, any pause, actual duration, and known limitations. Never mark the smoke test successful when it paused or produced a media-contract failure.

- [ ] **Step 7: Run final checks and commit only the verification documentation**

```bash
npm test
npm run build
npm run lint
git diff --check
git add README.md docs/shorts-run-guide.md
git commit -m "docs: record music video verification"
```

Update `../../TOOLS.md` with the same truthful result, but do not pass that parent-workspace path to this repository's `git add`.

Do not add `music-output/`, `.env`, Chrome profiles, provider responses containing secrets, or generated media to Git.
