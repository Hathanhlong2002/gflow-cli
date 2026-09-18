# Hybrid Music Video Design

**Date:** 2026-09-18

**Status:** Approved in chat; awaiting written-spec review

**Repository:** `Hathanhlong2002/gflow-cli`, forked from `swissmarley/gflow-cli`

**Target:** Local Node.js 20+ CLI with Chrome, FFmpeg, FFprobe, Gemini API access, and a Google Flow session

## 1. Product outcome

Add a separate music-video workflow to Flow Shorts Factory. A user supplies one topic and receives one finished 16:9 music video built around a Vietnamese vocal song of approximately three minutes.

The primary command is:

```bash
gflow music-video run \
  --topic "Tình yêu" \
  --out ./music-output/tinh-yeu \
  --profile music
```

After the initial Gemini and Flow authentication setup, topic and output directory are the only creative inputs required. The system chooses a suitable genre, mood, tempo, vocal direction, lyrical structure, visual treatment, and shot sequence from the topic.

The completed project contains the generated song, lyrics, timed captions, creative plan, generated image/video assets, durable progress state, and a final MP4. Generation never publishes the result to a social platform.

## 2. Fixed product decisions

- This is a new `music-video` domain and does not change the existing fixed 10-by-10 `shorts` manifest or commands.
- The song has Vietnamese lyrics and generated vocals.
- The target duration is approximately 180 seconds. The final video follows the probed duration of the generated song; the renderer does not truncate or time-stretch the song merely to reach exactly 180 seconds.
- The final video is MP4 with H.264 video, AAC audio, 1920x1080 resolution, square pixels, and 30 fps.
- Google Lyria 3.5 generates the complete song through the Gemini Interactions API.
- The visual track is hybrid: approximately eight key sections use 8-second Google Flow video clips, while the remaining sections use Gemini-generated images animated by FFmpeg.
- The actual number of visual sections is calculated after probing the song. The planner keeps sections short enough to maintain visual variety while avoiding unnecessary Flow generations.
- Lyrics are burned into the video as karaoke-style line captions and are also saved as `.ass` and plain text.
- The workflow is resumable and checkpoints every validated external artifact.
- Existing uncommitted renderer and Flow compatibility work must be preserved and integrated, not replaced.

## 3. Approaches considered

### Selected: hybrid Flow video and animated Gemini images

Use Flow video for the strongest moments such as the opening hook, choruses, bridge, climax, and outro. Use generated stills with restrained pan, zoom, parallax-like crop, and crossfade treatment elsewhere. This reduces Flow quota usage and generation time while maintaining enough motion for a full music video.

### Rejected: every section generated as Flow video

A three-minute song would require roughly 22 to 24 independent 8-second generations. This offers the most motion but is slower, more expensive, and more exposed to Flow UI failures and quota interruptions.

### Rejected: a small set of clips repeated for the whole song

This is faster and cheaper, but visible repetition lowers output quality. The chosen hybrid can use a distinct still for each non-video section without requiring a Flow generation for every section.

## 4. User workflow

The all-in-one command performs every stage in dependency order:

```text
topic
  -> song and lyric plan
  -> Lyria song generation
  -> audio probe
  -> duration-aware visual storyboard
  -> Gemini images
  -> selected Flow clips
  -> lyric caption timing
  -> FFmpeg render and validation
  -> final.mp4
```

If an external service or browser step requires attention, the run writes `action-required.json`, exits nonzero, and retains all completed artifacts. The same command resumes with:

```bash
gflow music-video run \
  --topic "Tình yêu" \
  --out ./music-output/tinh-yeu \
  --profile music \
  --resume
```

The topic and resolved configuration must match the existing project when resuming. The tool refuses to silently reuse an output directory for a different topic or model configuration.

Lower-level `plan`, `generate`, `render`, and `status` commands may be exposed for diagnosis, but `run` is the primary interface and must not require users to invoke those stages manually.

## 5. Architecture and module boundaries

### Music-video schema

A dedicated schema validates the project state, song plan, visual storyboard, asset journal, and captions. It does not reuse the shorts schema because the shorts domain has fixed episode and scene counts that do not apply here.

The song plan contains:

- exact topic and language;
- title, genre, mood, BPM range, musical key or scale when appropriate;
- vocal direction that describes characteristics without requesting imitation of a real artist;
- a target duration of approximately 180 seconds;
- timestamped intro, verses, pre-choruses, choruses, bridge, climax, and outro as appropriate;
- original Vietnamese lyric lines assigned to sections;
- global visual palette, locations, characters, wardrobe, and continuity constraints.

All generated JSON uses strict objects, bounded strings and arrays, monotonic timestamps, and cross-field duration validation.

### Song planner

The existing structured Gemini transport creates the validated song plan. The user topic is treated only as data. It cannot alter model names, file paths, browser profile, command options, or system instructions.

The planner asks for original lyrics and rejects requests to copy copyrighted lyrics or imitate a named living or deceased artist's voice. It may describe broad musical properties such as genre, decade, instrumentation, timbre, and vocal range.

### Lyria transport

A narrow `MusicGenerator` interface calls the official Gemini Interactions API with `lyria-3.5`. It sends the validated musical direction, section timestamps, and original lyrics, and requests a full-length vocal song.

The adapter extracts audio and text only from allowlisted model-output content blocks. It validates the response envelope, base64 encoding, MIME type, maximum decoded size, and HTTP status before writing an artifact. The shared `GEMINI_API_KEY` remains environment-only and is never included in manifests or logs.

The response audio is saved atomically as `song.mp3`, then probed with FFprobe. Returned lyrics and structure are stored as untrusted source data and reconciled with the planned lyrics. If the response has no valid audio or substantially unusable lyrics, the stage fails with a stable diagnostic instead of continuing with a broken render.

### Visual storyboard planner

After the real song duration is known, Gemini produces a duration-aware storyboard. Each entry has start/end times, visual description, camera direction, continuity data, and a render mode of `flow-video` or `animated-image`.

The default selector assigns approximately eight high-impact sections to Flow, prioritizing the hook, choruses, bridge, climax, and outro. Remaining sections use distinct generated images. The final storyboard has no gaps or overlaps and covers the complete probed audio duration.

### Image and Flow generation

The existing Gemini image transport is extended to support `16:9`. Each storyboard entry receives a deterministic asset ID. Generated images are validated before checkpointing.

Flow entries use the existing browser automation and Google profile. A Flow video is requested at 16:9 and eight seconds, using the generated section image as its start frame when available. Authentication, CAPTCHA, credit, rate-limit, generation-block, or UI-contract failures pause the project. The tool never bypasses those controls or rotates accounts automatically.

### Caption builder

The renderer creates line-level ASS captions from the validated song structure and returned lyrics. Returned timestamps are used when valid. If Lyria provides section timing but not trustworthy line timing, lines are distributed proportionally inside their section and the project report marks caption timing as approximate.

The visual style resembles karaoke: the active lyric line is prominent and readable over changing imagery, with an outline or backing treatment for contrast. The MVP does not promise phoneme- or word-level highlighting because the provider response does not guarantee word-level alignment.

Caption text is treated as untrusted input and escaped for ASS. It is never interpolated into a shell command or an FFmpeg filter expression.

### Hybrid FFmpeg renderer

The renderer uses `spawn` argument arrays with `shell: false`. It turns still images into timed 1920x1080 clips with restrained motion, normalizes Flow clips, adds transitions, concatenates the visual timeline, burns ASS captions, maps the original song as the sole final audio track, and trims only excess visuals to the probed song duration.

The final media contract requires:

- one H.264 video stream and one AAC stereo audio stream;
- 1920x1080, square pixels, 30 fps;
- duration within a small probe tolerance of the source song;
- non-empty output and a recorded SHA-256 hash.

Temporary render files use random sibling names and are removed on failure. Original inputs remain intact for retry.

### Orchestrator and state

The orchestrator owns stage transitions, checkpointing, cancellation, retries, and resume. Domain adapters do not decide what stage runs next.

```text
CREATED -> SONG_PLANNED -> SONG_READY -> STORYBOARDED
        -> ASSETS_GENERATING -> ASSETS_READY -> RENDERING -> READY

any active stage -> PAUSED | FAILED | CANCELLED
PAUSED -> previous active stage through --resume
```

State writes are atomic. An artifact is skipped during resume only when its recorded inputs and SHA-256 still match the file on disk. Network and provider 5xx failures receive bounded retry with backoff. Authentication, quota, policy rejection, invalid schemas, and unsafe artifacts are not blindly retried.

## 6. Filesystem layout

```text
<out>/
  project.json
  song-plan.json
  storyboard.json
  generation.json
  action-required.json
  audio/
    song.mp3
    lyrics.txt
    lyria-response.json
  captions/
    lyrics.ass
  assets/
    001/
      start.png
      clip.mp4          # only for Flow entries
      artifact.json
  output/
    final.mp4
    media-report.json
  logs/
    events.jsonl
```

`lyria-response.json` stores only sanitized, non-secret response metadata and textual structure needed for reproducibility. Raw headers, authorization values, and unrelated provider payload fields are not persisted.

## 7. Failure handling and safety

- Topic input is trimmed Unicode text between 3 and 300 characters; NUL and control characters are rejected.
- Model identifiers are validated against a conservative character allowlist.
- External JSON is parsed through strict schemas before entering the domain.
- Base64 audio/image outputs have encoded and decoded size limits.
- Paths are generated by the application beneath the selected project root. AI output cannot supply a path.
- FFmpeg and FFprobe use direct process arguments without a shell.
- Error messages redact secrets and do not persist complete unsafe provider responses.
- Safety or copyright rejection is terminal for that generation attempt; prompts are not repeatedly rewritten to evade provider controls.
- A Flow pause always explains the required manual action and the resume command.
- Ctrl-C preserves the last completed checkpoint and cleans temporary files where safe.

## 8. Compatibility with current workspace changes

The repository currently has uncommitted Flow compatibility and renderer work, including a new `src/shorts/renderer.ts` and its tests. Implementation must begin by reviewing that diff and running its tests. Shared low-level probe/process helpers may be extracted only when this reduces duplication without changing the behavior of the existing `shorts render` and top-level `merge` commands.

No existing user changes are discarded, overwritten, or included in unrelated commits.

## 9. Testing strategy

Implementation follows test-driven development.

Unit tests cover:

- strict music project and storyboard validation;
- timestamp monotonicity, full timeline coverage, and mode allocation;
- Lyria request construction, envelope parsing, response limits, error redaction, and retry behavior;
- caption escaping and approximate timing fallback;
- stage transitions, atomic checkpoints, artifact hash reconciliation, and resume;
- CLI registration and option validation.

Renderer integration tests use short synthetic FFmpeg fixtures to verify animated stills, Flow clip normalization, caption burn-in, audio mapping, output dimensions, duration, codecs, and cleanup. They do not call paid APIs.

A mocked end-to-end test runs topic-to-final through fake Gemini, Lyria, image, and Flow adapters.

After automated tests, the approved live smoke test uses the topic `Tình yêu`. It may consume Gemini/Lyria and Flow quota. The test runs only with the user's configured API key and authenticated Flow profile, respects manual login/quota interruptions, and reports whether the final media contract passes. Generated live output remains outside Git.

## 10. Documentation updates

The README and Vietnamese run guide document prerequisites, authentication, the main command, resume behavior, output files, quota implications, approximate caption timing, Lyria SynthID watermarking, and the limitation that Google Flow browser automation is unofficial and can break when its UI changes.

`TOOLS.md` is updated after implementation to describe the new music-video capability and the verification status achieved during the live `Tình yêu` smoke test.
