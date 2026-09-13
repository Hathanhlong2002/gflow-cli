# Flow Shorts Factory Design

**Date:** 2026-09-13

**Status:** Proposed for implementation

**Repository:** `Hathanhlong2002/gflow-cli`, forked from `swissmarley/gflow-cli`

**Target:** Local Node.js 20+ CLI on a desktop with Chrome, FFmpeg, and FFprobe

## 1. Product outcome

Flow Shorts Factory turns one user-supplied topic into a coherent series of ten vertical short-form videos. Each final video targets 80 seconds and contains ten 8-second scenes. Gemini creates the series concept, episode scripts, shot plans, opening images, narration, titles, descriptions, hashtags, and captions. The existing Google Flow browser adapter creates the scene videos from those images and prompts. FFmpeg assembles each episode. Official TikTok and YouTube APIs publish the completed batch publicly after the user gives explicit batch consent.

The primary command is:

```bash
gflow shorts run --topic "Lịch sử bí ẩn của thành Rome" --out ./output/rome
```

By default, this command plans and renders the ten videos but does not publish. Public publishing is a separate, explicit action:

```bash
gflow shorts publish ./output/rome/project.json --visibility public
```

`gflow shorts run` may include `--publish public`, but it must show the resolved TikTok creator, YouTube channel, ten titles, and public visibility, then obtain one confirmation before any upload. `--yes` permits unattended publishing only when the project manifest already records the same target accounts and `publishConsent: true`.

## 2. Fixed MVP decisions

- The interface is a local CLI, extending the existing Commander application. A web dashboard is outside the MVP.
- One project always produces exactly ten episodes.
- Each episode always contains exactly ten planned scenes of 8 seconds, for 80 seconds of source video.
- Final duration must be between 78.0 and 82.0 seconds after encoding.
- Output is MP4, H.264 video, AAC audio, 1080×1920, square pixels, and 30 fps.
- The default language is Vietnamese (`vi-VN`), configurable per project.
- Gemini uses structured JSON output for planning, a Gemini image-capable model for each scene's opening image, and Gemini TTS for narration.
- Every Flow scene uses aspect ratio `9:16`, one output, an 8-second duration, the Gemini image as `startFrame`, and a scene-specific motion prompt.
- Narration is mixed over the Flow clip audio. Flow audio is ducked beneath narration rather than discarded. Captions are burned into the final video and also saved as `.srt`.
- Publishing uses YouTube Data API resumable uploads and TikTok Content Posting API `FILE_UPLOAD`; browser scripting is never used for social publishing.
- Public publishing is fail-closed: the tool never intentionally substitutes private or draft visibility. TikTok capability is checked before upload. YouTube has no reliable preflight endpoint for audit status, so publishing requires a user attestation in configuration, requests `public`, and verifies the returned resource immediately; an API-enforced private upload is recorded as a failed public attempt and reported for manual remediation.

## 3. Approaches considered

### Selected: extend the existing CLI with isolated adapters

Keep the tested Google Flow automation and add a `shorts` domain above it. Gemini, narration, rendering, and publishers implement small interfaces. The orchestrator owns durable state and never contains vendor-specific HTTP details. This gives the fastest path to a usable tool while keeping fragile Flow selectors isolated.

### Rejected for MVP: a desktop or web dashboard

A GUI would make OAuth and progress easier to discover, but it adds a server, browser security surface, state synchronization, and packaging before the generation pipeline is proven. The domain interfaces must remain usable by a future GUI.

### Rejected: replace Flow with a direct video API

This would be more stable than browser automation, but it changes the requested product and may not reproduce the user's Flow workflow or subscription access. The `SceneGenerator` interface allows a direct API implementation later without changing the project format.

## 4. Architecture

```text
topic + project config
        |
        v
GeminiStoryPlanner -----> project.json (validated creative manifest)
        |
        v
GeminiImageGenerator ---> scenes/*/start.jpg
        |
        v
GoogleFlowSceneGenerator -> scenes/*/clip.mp4
        |
        +---- quota/login/manual action ---> PAUSED + action-required.json
        v
GeminiNarrator ----------> episodes/*/narration.wav + captions.srt
        |
        v
FFmpegRenderer ----------> episodes/*/final.mp4 + media-report.json
        |
        v
PublishCoordinator ------> YouTubePublisher + TikTokPublisher
        |
        v
project.json records remote IDs and terminal status
```

The orchestrator runs stages in dependency order and writes state atomically after every material result. Completed artifacts are content-addressed with SHA-256 metadata. Resume skips a step only if its recorded inputs and output checksums still match.

## 5. Module boundaries

### `src/shorts/schema.ts`

Defines Zod schemas and inferred types for project input, creative plan, episode, scene, media probe, publish target, and durable state. It is the only boundary allowed to turn external JSON or Gemini output into trusted domain objects.

### `src/shorts/planner.ts`

Defines `StoryPlanner` and uses it to produce a ten-episode series. The concrete Gemini adapter requests JSON matching the exported schema. It performs at most two repair attempts when Gemini returns invalid output, then stops with a diagnostic that contains validation paths but not the raw API key or full unsafe response.

Every episode contains:

- a unique hook, self-contained story arc, title, description, and 3–5 hashtags;
- narration text sized for approximately 80 seconds;
- exactly ten scenes with visual description, motion prompt, narration segment, and caption text;
- a continuity block for recurring characters, clothing, locations, palette, camera language, and prohibited visual changes.

Across the batch, hooks and plots must not be duplicates. Episode 1 introduces the series premise and episode 10 resolves the series arc; episodes remain understandable individually.

### `src/shorts/gemini.ts`

Implements three narrow interfaces over the official Gemini API:

```ts
interface StoryPlanner {
  plan(input: PlanInput): Promise<CreativePlan>;
}

interface SceneImageGenerator {
  generate(input: SceneImageInput): Promise<ImageArtifact>;
}

interface Narrator {
  synthesize(input: NarrationInput): Promise<AudioArtifact>;
}
```

Model names live in project configuration rather than source code because model availability changes. Required keys are loaded from `GEMINI_API_KEY`; values are never accepted as CLI arguments, written to manifests, or logged.

### `src/shorts/flow-generator.ts`

Implements `SceneGenerator` by translating each planned scene into the existing `FlowAutomation.runJob` contract. It preserves one project-wide Chrome profile, uses the persistent authenticated session already supported by `gflow auth login`, and creates deterministic job IDs such as `ep-01-scene-03`.

The adapter does not enter Google passwords, handle OTPs, solve CAPTCHAs, purchase credits, conceal automation, or rotate accounts. A login, CAPTCHA, credit, rate-limit, or UI-contract error is a hard pause.

### `src/shorts/captions.ts`

Splits narration into caption cues using planned scene boundaries and measured audio duration. Each cue remains within its scene, contains at most two visible lines, and has monotonic SRT timestamps. Captions are treated as plain text and escaped for SRT and FFmpeg filter-file use.

Narration is synthesized as one segment per scene. A segment shorter than 8 seconds is padded with silence. A segment between 8 and 8.8 seconds may be time-compressed by at most 10%. A longer segment is regenerated once with a shorter script; if it still exceeds 8.8 seconds, that episode fails validation. This preserves ten fixed scene boundaries without severe speech distortion.

### `src/shorts/renderer.ts`

Defines `MediaRenderer`. The FFmpeg implementation invokes `ffmpeg` and `ffprobe` with `spawn` argument arrays and `shell: false`. It never interpolates a topic, caption, or path into a shell command. It normalizes scene clips, concatenates them, mixes narration with ducked source audio, burns captions, and probes the final file.

Rendering fails if dimensions, codecs, duration, missing audio, or output size violate the fixed MVP contract. The unmodified scene clips and narration remain available for retry.

### `src/shorts/publishers/*`

Defines a common publisher boundary:

```ts
interface Publisher {
  resolveTarget(): Promise<PublishTarget>;
  preflight(input: PublishPreflightInput): Promise<PublishCapability>;
  publish(input: PublishInput): Promise<PublishResult>;
  status(remoteId: string): Promise<PublishStatus>;
}
```

`YouTubePublisher` uses OAuth 2.0 and `videos.insert` with resumable upload. `TikTokPublisher` queries current creator information, verifies `PUBLIC_TO_EVERYONE` is allowed and the 80-second duration fits the creator limit, initializes a direct post, performs chunked `FILE_UPLOAD`, and polls publish status within documented limits.

OAuth client configuration is read from user-selected files. Refresh/access tokens are stored per local profile in files created with mode `0600`; the token directory is excluded from Git. Logs redact authorization headers, tokens, upload URLs, API keys, and OAuth secrets.

### `src/shorts/orchestrator.ts`

Owns the state machine, cancellation, bounded concurrency, retries, checkpoints, and idempotency. It depends only on the interfaces above.

Default concurrency is one Flow generation at a time, two Gemini image requests, one TTS request, and one publisher upload per platform. Retryable network and 5xx failures use capped exponential backoff with jitter. Authentication, policy, invalid input, moderation, insufficient credits, and schema errors are not blindly retried.

### `src/shorts/commands.ts`

Adds these commands without changing existing `gflow image`, `video`, `batch`, `scene`, or authentication behavior:

```text
gflow shorts plan --topic <text> --out <dir>
gflow shorts generate <project.json> [--resume]
gflow shorts render <project.json> [--resume]
gflow shorts publish <project.json> --visibility public [--platform youtube|tiktok|all]
gflow shorts run --topic <text> --out <dir> [--publish public] [--yes]
gflow shorts status <project.json>
```

`plan`, `generate`, and `render` never publish. `run` without `--publish` stops after render.

## 6. Project data and filesystem layout

```text
<out>/
  project.json
  project.yaml
  action-required.json
  creative-plan.json
  characters/
    <character-id>/reference.png
  episodes/
    01/
      narration.wav
      captions.srt
      final.mp4
      media-report.json
      scenes/
        01/start.jpg
        01/clip.mp4
        01/artifact.json
  logs/events.jsonl
```

`project.yaml` contains user-editable, non-secret configuration. `project.json` is machine-owned durable state with `schemaVersion`, project ID, normalized configuration, stage status, attempts, artifact hashes, errors, consent record, and remote publish IDs. State writes use a temporary sibling file followed by atomic rename.

The state machine is:

```text
CREATED -> PLANNED -> GENERATING -> GENERATED -> RENDERING -> READY
READY -> PUBLISHING -> PUBLISHED
any active stage -> PAUSED | FAILED | CANCELLED
PAUSED -> previous active stage through --resume
```

An episode may progress independently, but the project is `READY` only when all ten final files pass media validation. Publishing records separate per-episode/per-platform states so a completed YouTube upload is never repeated because TikTok failed.

## 7. Data validation and content rules

- Topic is trimmed Unicode text between 3 and 300 characters. Control characters and NUL are rejected.
- Output paths resolve beneath the selected output directory. Generated IDs use lowercase ASCII slug characters and cannot contain path separators.
- All Gemini JSON is parsed with Zod using strict objects, exact array lengths, bounded string sizes, and enums.
- Gemini output is data, never executable instructions. It cannot change models, file paths, credentials, CLI options, publish targets, or visibility.
- Image MIME type, byte size, and decoded dimensions are checked before writing the final artifact.
- Downloaded Flow media is validated by FFprobe before it becomes a completed scene.
- Titles, descriptions, hashtags, and captions are checked against platform length limits during publisher preflight. The tool reports which field failed and does not silently truncate story text.
- Content rejected by Gemini, Flow, TikTok, or YouTube policy pauses or fails with the provider reason. The tool does not rephrase repeatedly to evade safety systems.

## 8. Authentication, consent, and public publishing

### Google Flow

The first login is manual via `gflow auth login --profile <name>`. Later runs reuse that Chrome profile. When credits are exhausted, the project becomes `PAUSED` with action `FLOW_CREDITS_REQUIRED`. The CLI tells the user to wait for refresh, obtain credits through Google, or manually authenticate a different authorized profile and resume with `--profile`. It never selects or cycles accounts itself.

### Gemini

The API key comes only from the process environment or an OS-mediated secret injection. `doctor` reports whether it is present without printing any part of the value.

### YouTube

The user completes OAuth consent for the destination channel. Preflight resolves and displays the channel identity and requires `youtube.publicUploadApproved: true`, which is the user's attestation that the Google API project has completed any required audit. Because YouTube exposes no dependable audit-capability probe, the publisher requests `public` and immediately reads back the uploaded video's status. If YouTube restricts it to private, the tool records the remote video ID, marks the public publish as failed, does not claim success, and provides a manual remediation message. Upload sessions and returned video IDs are persisted immediately for resumability and idempotency.

### TikTok

The app must have approved `video.publish` scope and the creator must authorize it. Before upload, the tool queries current creator information and uses only a privacy option returned by TikTok. If `PUBLIC_TO_EVERYONE` is absent, the public job stops. Unaudited clients that are limited to private visibility are treated as incapable of satisfying the request.

### Consent record

Public batch consent records timestamp, project hash, platform target IDs, visibility, and the ten artifact hashes. Changing any of those values invalidates consent and requires confirmation again. A failed platform may be resumed without renewed consent only when this tuple is unchanged.

## 9. Failure and resume behavior

Errors use stable codes and one of four dispositions:

- `RETRY`: transient network, documented rate-limit, or provider 5xx; bounded backoff honors `Retry-After`.
- `PAUSE`: login, CAPTCHA, Flow credits, manual account/profile change, expired OAuth grant, or required public-app approval.
- `FAIL_ITEM`: invalid generated artifact or provider rejection limited to one episode; no automatic policy evasion.
- `FAIL_PROJECT`: corrupt state, incompatible schema version, unsafe path, invalid configuration, or inability to meet the ten-video contract.

Ctrl-C completes the current atomic state write, marks the active operation interrupted, closes the browser, and exits nonzero. Resume reconciles on-disk artifacts with hashes before contacting a provider. Unknown remote publish outcomes are checked through provider status APIs before a new upload is attempted.

## 10. Observability

Console output is human-readable and `logs/events.jsonl` is machine-readable. Each event contains timestamp, project ID, episode/scene where applicable, stage, attempt, duration, provider, status, and stable error code. No prompt response body is logged by default; a user-enabled debug mode may log sanitized prompts but still redacts secrets and upload URLs.

`gflow shorts status` prints:

- overall stage and last error/action;
- completed/total episodes and scenes;
- output paths and final durations;
- Flow profile name but no browser cookies;
- Gemini call counts but no API key;
- per-platform publish state and public URL when available.

## 11. Testing strategy

Development follows red-green-refactor. Production code is introduced only after a focused failing test demonstrates the behavior.

- Schema tests cover exact 10×10 shape, bounds, strict parsing, malicious paths, control characters, and Gemini repair exhaustion.
- Planner contract tests use recorded sanitized Gemini-shaped fixtures; unit tests never call a live model.
- Orchestrator tests use in-memory adapters and verify checkpointing, resume, hash invalidation, pause on quota, and per-platform idempotency.
- Renderer tests use tiny generated media fixtures and real local FFmpeg/FFprobe when available; a capability test skips with an explicit reason when unavailable.
- Publisher tests use local HTTP fixtures for OAuth refresh, resumable/chunked upload, retries, status reconciliation, public capability checks, and redaction.
- CLI tests verify existing commands do not regress and all publishing paths require explicit public visibility and valid consent.
- Browser Flow fixture tests verify translation from a scene plan into the existing `FlowAutomation` contract. Live Flow tests remain opt-in and never run in CI.
- Release verification is `npm test`, `npm run lint`, `npm run build`, `npm audit --omit=dev`, plus an opt-in end-to-end dry run that uses fake Gemini, Flow, and publisher adapters.

## 12. Delivery decomposition

The product contains four substantial subsystems. They are implemented as separately reviewable plans in this order:

1. **Creative manifest:** schemas, project state, Gemini story planning, opening images, TTS, CLI `plan`, and deterministic fake adapters.
2. **Flow generation and resume:** scene translation, artifact validation, quota/manual-action pauses, checkpoints, CLI `generate` and `status`.
3. **Rendering:** captions, FFmpeg assembly, FFprobe validation, CLI `render`, and end-to-end local dry run.
4. **Publishing:** secure OAuth token storage, YouTube resumable upload, TikTok direct/chunked upload and status polling, batch consent, CLI `publish`, and `run` orchestration.

Each plan must leave the repository in a working state and include its own tests and documentation. Publishing is not partially simulated in production: until real OAuth apps are configured and eligible for public posting, the public preflight returns a clear pause state.

## 13. Acceptance criteria

The MVP is accepted when all of the following are demonstrated:

1. With only a topic and valid configuration, `shorts plan` creates a valid ten-episode, ten-scene-per-episode manifest and no secrets appear on disk.
2. After one manual Flow login, `shorts generate --resume` produces or safely resumes 100 valid 9:16 scene clips without regenerating completed clips.
3. Exhausted Flow credits create a durable pause instruction; after a user-authorized profile change, the same command resumes at the first incomplete scene.
4. `shorts render` produces ten H.264/AAC 1080×1920 videos, each 78–82 seconds, with narration and burned captions.
5. Re-running any completed stage is idempotent unless inputs or artifact hashes changed.
6. Public publishing cannot start without verified target identities, matching consent, valid OAuth grants, TikTok public capability, and the YouTube public-upload attestation.
7. With audited/approved apps, each final video is posted once to the selected YouTube channel and TikTok creator with public visibility, and the remote IDs/URLs are recorded.
8. If either platform fails, resume completes only the missing platform operations and never duplicates successful posts.
9. Existing gflow commands and all automated tests, lint, build, and production dependency audit remain passing.

## 14. Explicit non-goals

- No CAPTCHA solving, credential entry, OTP interception, stealth automation, automatic account cycling, proxy rotation, credit bypass, watermark removal, or moderation evasion.
- No scheduling calendar, analytics dashboard, comment automation, engagement bot, or multi-user SaaS.
- No auto-deletion or alteration of published posts.
- No guarantee that browser automation survives a Google Flow UI change; locator failures pause with diagnostics.
- No fallback from public to private/draft publication.

## 15. External contracts used by this design

- Gemini structured output: <https://ai.google.dev/gemini-api/docs/structured-output>
- Gemini content and image response formats: <https://ai.google.dev/api/generate-content>
- Gemini text-to-speech: <https://ai.google.dev/gemini-api/docs/speech-generation>
- Google Flow credits and model durations: <https://support.google.com/flow/answer/16526234>
- YouTube `videos.insert`: <https://developers.google.com/youtube/v3/docs/videos/insert>
- YouTube resumable uploads: <https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol>
- TikTok Direct Post: <https://developers.tiktok.com/docs/en/content-posting-api-get-started>
- TikTok post status: <https://developers.tiktok.com/docs/en/content-posting-api-reference-get-video-status>
