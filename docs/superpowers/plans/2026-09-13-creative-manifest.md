# Creative Manifest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `gflow shorts plan` so one validated topic produces and durably stores a Gemini-generated creative manifest containing exactly ten episodes with ten 8-second scenes each.

**Architecture:** A strict Zod domain schema defines the only trusted plan format. `GeminiStoryPlanner` depends on an injected `GeminiTransport`, while `ProjectStore` owns safe paths and atomic state persistence. The CLI composes these units but tests inject fakes, so automated tests make no network calls.

**Tech Stack:** Node.js 20+, TypeScript ESM, Commander 12, Zod 3, native `fetch`, Vitest 1

**Spec:** `docs/superpowers/specs/2026-09-13-flow-shorts-factory-design.md`

## Global Constraints

- One project always produces exactly ten episodes.
- Each episode contains exactly ten scenes and every scene duration is exactly 8 seconds.
- Topic is trimmed Unicode text between 3 and 300 characters; control characters and NUL are rejected.
- Default language is `vi-VN`.
- Gemini JSON is untrusted and must pass strict Zod parsing before persistence.
- `GEMINI_API_KEY` is read from the environment only and must never be included in errors, logs, or files.
- Generated IDs contain lowercase ASCII letters, numbers, and hyphens only; all outputs remain beneath the selected output directory.
- State files are written through a temporary sibling and atomic rename.
- Existing CLI behavior and the 82 upstream tests must not regress.

---

### Task 1: Strict creative-plan domain schema

**Files:**
- Create: `src/shorts/schema.ts`
- Create: `tests/fixtures/shorts.ts`
- Create: `tests/shorts.schema.test.ts`

**Interfaces:**
- Consumes: Zod from the existing dependency set.
- Produces: `SHORTS_EPISODE_COUNT`, `SHORTS_SCENE_COUNT`, `SHORTS_SCENE_DURATION_SECONDS`, `topicSchema`, `creativePlanSchema`, `parseTopic(value: unknown): string`, `parseCreativePlan(value: unknown): CreativePlan`, and inferred `CreativePlan`, `EpisodePlan`, `ScenePlan` types.

- [ ] **Step 1: Write fixture and failing boundary tests**

```ts
// tests/fixtures/shorts.ts
export function validCreativePlan() {
  return {
    schemaVersion: 1,
    topic: "Những bí ẩn của đại dương",
    language: "vi-VN",
    seriesTitle: "Bên dưới mặt nước",
    seriesPremise: "Mười chuyến lặn khám phá những bí ẩn độc lập.",
    continuity: {
      characters: ["Linh, nhà sinh vật biển, áo lặn màu vàng"],
      locations: ["đại dương sâu"],
      palette: "xanh thẫm và vàng",
      cameraLanguage: "cinematic documentary",
      prohibitedChanges: ["không đổi trang phục của Linh"]
    },
    episodes: Array.from({ length: 10 }, (_, episodeIndex) => ({
      id: `episode-${String(episodeIndex + 1).padStart(2, "0")}`,
      title: `Bí ẩn ${episodeIndex + 1}`,
      hook: `Điều gì đang ẩn dưới vùng nước số ${episodeIndex + 1}?`,
      description: `Một câu chuyện độc lập số ${episodeIndex + 1}.`,
      hashtags: ["#daiduong", "#khampha", "#shorts"],
      scenes: Array.from({ length: 10 }, (_, sceneIndex) => ({
        id: `scene-${String(sceneIndex + 1).padStart(2, "0")}`,
        durationSeconds: 8,
        visual: `Khung cảnh dưới biển ${sceneIndex + 1}`,
        motionPrompt: `Máy quay tiến chậm trong cảnh ${sceneIndex + 1}`,
        narration: `Lời kể ngắn cho cảnh ${sceneIndex + 1}.`,
        caption: `Bí ẩn ${sceneIndex + 1}`
      }))
    }))
  };
}

// tests/shorts.schema.test.ts
it("accepts exactly ten episodes with ten eight-second scenes", () => {
  expect(parseCreativePlan(validCreativePlan()).episodes).toHaveLength(10);
});

it.each(["ab", "a\0bc", "x".repeat(301)])("rejects unsafe topic %j", (topic) => {
  expect(() => parseTopic(topic)).toThrow();
});

it("rejects the wrong episode or scene count", () => {
  const nineEpisodes = validCreativePlan();
  nineEpisodes.episodes.pop();
  expect(() => parseCreativePlan(nineEpisodes)).toThrow();
  const nineScenes = validCreativePlan();
  nineScenes.episodes[0].scenes.pop();
  expect(() => parseCreativePlan(nineScenes)).toThrow();
});

it("rejects unknown fields and non-eight-second scenes", () => {
  const plan = validCreativePlan() as ReturnType<typeof validCreativePlan> & { injected?: string };
  plan.injected = "ignored?";
  expect(() => parseCreativePlan(plan)).toThrow();
  delete plan.injected;
  plan.episodes[0].scenes[0].durationSeconds = 7;
  expect(() => parseCreativePlan(plan)).toThrow();
});
```

- [ ] **Step 2: Run the schema test and verify RED**

Run: `npm test -- tests/shorts.schema.test.ts`

Expected: FAIL because `src/shorts/schema.ts` does not exist.

- [ ] **Step 3: Implement strict schemas and exported parsers**

```ts
export const SHORTS_EPISODE_COUNT = 10;
export const SHORTS_SCENE_COUNT = 10;
export const SHORTS_SCENE_DURATION_SECONDS = 8;

export const topicSchema = z.string().trim().min(3).max(300)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "topic contains control characters");

const scenePlanSchema = z.object({
  id: z.string().regex(/^scene-(0[1-9]|10)$/),
  durationSeconds: z.literal(SHORTS_SCENE_DURATION_SECONDS),
  visual: z.string().trim().min(1).max(2000),
  motionPrompt: z.string().trim().min(1).max(2000),
  narration: z.string().trim().min(1).max(1000),
  caption: z.string().trim().min(1).max(300)
}).strict();

const episodePlanSchema = z.object({
  id: z.string().regex(/^episode-(0[1-9]|10)$/),
  title: z.string().trim().min(1).max(100),
  hook: z.string().trim().min(1).max(300),
  description: z.string().trim().min(1).max(2200),
  hashtags: z.array(z.string().regex(/^#[\p{L}\p{N}_]+$/u)).min(3).max(5),
  scenes: z.array(scenePlanSchema).length(SHORTS_SCENE_COUNT)
}).strict();
```

Complete `continuity` and root objects with `.strict()`, exact episode length, bounded strings/arrays, and the two parser functions. Add `superRefine` checks ensuring episode IDs and scene IDs match their 1-based array positions.

- [ ] **Step 4: Run schema tests and the full suite**

Run: `npm test -- tests/shorts.schema.test.ts`

Expected: PASS for every test in `tests/shorts.schema.test.ts`.

Run: `npm test`

Expected: all existing and new tests PASS.

- [ ] **Step 5: Commit the schema slice**

```bash
git add src/shorts/schema.ts tests/fixtures/shorts.ts tests/shorts.schema.test.ts
git commit -m "feat: define shorts creative manifest schema"
```

### Task 2: Safe project configuration and atomic state store

**Files:**
- Create: `src/shorts/project-store.ts`
- Create: `tests/shorts.project-store.test.ts`

**Interfaces:**
- Consumes: `CreativePlan`, `parseCreativePlan`, and `parseTopic` from Task 1.
- Produces: `ProjectState`, `CreateProjectInput`, and class `ProjectStore` with `create(input): Promise<ProjectState>`, `savePlan(plan): Promise<ProjectState>`, `load(): Promise<ProjectState>`, and `paths(): ProjectPaths`.

- [ ] **Step 1: Write failing tests for safe paths and durable state**

```ts
it("creates a normalized project beneath the selected output directory", async () => {
  const store = new ProjectStore(outputDir);
  const state = await store.create({
    topic: "  Đại dương kỳ bí  ",
    language: "vi-VN",
    textModel: "gemini-2.5-flash",
    imageModel: "gemini-2.5-flash-image",
    ttsModel: "gemini-2.5-flash-preview-tts"
  });
  expect(state).toMatchObject({ stage: "CREATED", topic: "Đại dương kỳ bí" });
  expect(JSON.parse(await readFile(join(outputDir, "project.json"), "utf8"))).toEqual(state);
});

it("uses fixed manifest paths beneath the selected output directory", () => {
  expect(new ProjectStore(outputDir).paths()).toEqual({
    root: resolve(outputDir),
    state: join(resolve(outputDir), "project.json"),
    plan: join(resolve(outputDir), "creative-plan.json")
  });
});

it("persists a validated plan and advances CREATED to PLANNED", async () => {
  const store = new ProjectStore(outputDir);
  await store.create(validInput);
  const state = await store.savePlan(validCreativePlan());
  expect(state.stage).toBe("PLANNED");
  expect(state.planHash).toMatch(/^[a-f0-9]{64}$/);
});
```

- [ ] **Step 2: Run project-store tests and verify RED**

Run: `npm test -- tests/shorts.project-store.test.ts`

Expected: FAIL because `ProjectStore` does not exist.

- [ ] **Step 3: Implement state parsing, atomic writes, and containment checks**

```ts
export interface CreateProjectInput {
  topic: string;
  language: string;
  textModel: string;
  imageModel: string;
  ttsModel: string;
}

export interface ProjectPaths {
  root: string;
  state: string;
  plan: string;
}

export interface ProjectState {
  schemaVersion: 1;
  projectId: string;
  stage: "CREATED" | "PLANNED";
  topic: string;
  language: string;
  models: { text: string; image: string; tts: string };
  planHash?: string;
  createdAt: string;
  updatedAt: string;
}

export class ProjectStore {
  constructor(private readonly root: string) {}
  paths(): ProjectPaths;
  create(input: CreateProjectInput): Promise<ProjectState>;
  savePlan(plan: CreativePlan): Promise<ProjectState>;
  load(): Promise<ProjectState>;
}
```

Resolve the root once and construct only the two fixed child paths shown by the test. Create the root with mode `0700`. For every JSON write, create a random sibling such as `.project.json.<uuid>.tmp` with flags `wx` and mode `0600`, sync and close it, then rename it over the destination; clean that one known temporary file on failure. Hash the exact validated `creative-plan.json` bytes with SHA-256 and record the digest in state. Validate loaded state with a strict Zod schema and reject unsupported `schemaVersion` or invalid state transitions.

- [ ] **Step 4: Verify project-store and full tests**

Run: `npm test -- tests/shorts.project-store.test.ts`

Expected: PASS.

Run: `npm test`

Expected: all tests PASS.

- [ ] **Step 5: Commit the persistence slice**

```bash
git add src/shorts/project-store.ts tests/shorts.project-store.test.ts
git commit -m "feat: persist shorts project state safely"
```

### Task 3: Gemini structured-output transport and story planner

**Files:**
- Create: `src/shorts/gemini-transport.ts`
- Create: `src/shorts/planner.ts`
- Create: `tests/shorts.planner.test.ts`
- Create: `tests/shorts.gemini-transport.test.ts`

**Interfaces:**
- Consumes: `CreativePlan`, `creativePlanSchema`, `parseCreativePlan`, and `parseTopic` from Task 1.
- Produces: `GeminiTransport.generateJson(input: GeminiJsonRequest): Promise<unknown>`, `GoogleGeminiTransport`, `StoryPlanner.plan(input: PlanInput): Promise<CreativePlan>`, and `GeminiStoryPlanner`.

- [ ] **Step 1: Write failing planner behavior tests**

```ts
it("returns the first valid structured plan", async () => {
  const transport = { generateJson: vi.fn().mockResolvedValue(validCreativePlan()) };
  const planner = new GeminiStoryPlanner(transport);
  await expect(planner.plan({ topic: "Đại dương kỳ bí", language: "vi-VN", model: "gemini-2.5-flash" }))
    .resolves.toEqual(validCreativePlan());
  expect(transport.generateJson).toHaveBeenCalledOnce();
});

it("makes at most two repair attempts for invalid model output", async () => {
  const transport = { generateJson: vi.fn().mockResolvedValue({ bad: true }) };
  const planner = new GeminiStoryPlanner(transport);
  await expect(planner.plan({ topic: "Đại dương kỳ bí", language: "vi-VN", model: "gemini-2.5-flash" }))
    .rejects.toThrow(/invalid creative plan after 3 attempts/i);
  expect(transport.generateJson).toHaveBeenCalledTimes(3);
});

it("does not include an API key in a transport error", async () => {
  const secret = "gemini-secret-value";
  const fetcher = vi.fn().mockResolvedValue(new Response("denied", { status: 403 }));
  const transport = new GoogleGeminiTransport({ apiKey: secret, fetcher });
  await expect(transport.generateJson(request)).rejects.not.toThrow(secret);
});
```

- [ ] **Step 2: Run planner/transport tests and verify RED**

Run: `npm test -- tests/shorts.planner.test.ts tests/shorts.gemini-transport.test.ts`

Expected: FAIL because the planner and transport modules do not exist.

- [ ] **Step 3: Implement a narrow REST transport and repair loop**

```ts
export interface GeminiJsonRequest {
  model: string;
  systemInstruction: string;
  prompt: string;
  responseSchema: Record<string, unknown>;
}

export interface GeminiTransport {
  generateJson(input: GeminiJsonRequest): Promise<unknown>;
}

export interface PlanInput {
  topic: string;
  language: string;
  model: string;
}

export interface StoryPlanner {
  plan(input: PlanInput): Promise<CreativePlan>;
}

export class GoogleGeminiTransport implements GeminiTransport {
  constructor(options: { apiKey: string; fetcher?: typeof fetch; timeoutMs?: number });
  generateJson(input: GeminiJsonRequest): Promise<unknown>;
}
```

POST to the official `generateContent` endpoint using `x-goog-api-key`, `AbortSignal.timeout`, `responseMimeType: "application/json"`, and `responseJsonSchema`. Reject non-HTTPS endpoint overrides. Cap the response body at 2 MiB before JSON parsing. On non-2xx responses, expose only HTTP status and a stable provider code.

Build the planning prompt from constant instructions plus the validated topic/language. Repair prompts contain only summarized Zod issue paths and the original topic, never the full invalid response. Validate every attempt with `parseCreativePlan`.

- [ ] **Step 4: Verify focused and full tests**

Run: `npm test -- tests/shorts.planner.test.ts tests/shorts.gemini-transport.test.ts`

Expected: PASS.

Run: `npm test`

Expected: all tests PASS.

- [ ] **Step 5: Commit the Gemini planning slice**

```bash
git add src/shorts/gemini-transport.ts src/shorts/planner.ts tests/shorts.planner.test.ts tests/shorts.gemini-transport.test.ts
git commit -m "feat: plan shorts series with Gemini"
```

### Task 4: Planning service orchestration

**Files:**
- Create: `src/shorts/plan-service.ts`
- Create: `tests/shorts.plan-service.test.ts`

**Interfaces:**
- Consumes: `StoryPlanner` from Task 3 and `ProjectStore` from Task 2.
- Produces: `planShortsProject(input: PlanShortsInput): Promise<ProjectState>`.

- [ ] **Step 1: Write the failing service test**

```ts
it("creates state, plans once, then persists the validated result", async () => {
  const calls: string[] = [];
  const store = {
    create: vi.fn(async () => { calls.push("create"); return createdState; }),
    savePlan: vi.fn(async () => { calls.push("savePlan"); return plannedState; })
  };
  const planner = {
    plan: vi.fn(async () => { calls.push("plan"); return validCreativePlan(); })
  };
  await expect(planShortsProject({ config: validInput, store, planner })).resolves.toEqual(plannedState);
  expect(calls).toEqual(["create", "plan", "savePlan"]);
});
```

Add cases proving planner failure leaves a durable `CREATED` project, and an already `PLANNED` project is returned without a second Gemini call unless `force: true`.

- [ ] **Step 2: Run service tests and verify RED**

Run: `npm test -- tests/shorts.plan-service.test.ts`

Expected: FAIL because `planShortsProject` does not exist.

- [ ] **Step 3: Implement minimal orchestration**

```ts
export interface PlanShortsInput {
  config: CreateProjectInput;
  store: Pick<ProjectStore, "create" | "load" | "savePlan">;
  planner: StoryPlanner;
  force?: boolean;
}

export async function planShortsProject(input: PlanShortsInput): Promise<ProjectState>;
```

The service validates configuration before provider work, does not catch and rewrite typed provider errors, and never serializes the planner or transport objects into project state.

- [ ] **Step 4: Verify service and full tests**

Run: `npm test -- tests/shorts.plan-service.test.ts`

Expected: PASS.

Run: `npm test`

Expected: all tests PASS.

- [ ] **Step 5: Commit the orchestration slice**

```bash
git add src/shorts/plan-service.ts tests/shorts.plan-service.test.ts
git commit -m "feat: orchestrate shorts planning"
```

### Task 5: `gflow shorts plan` CLI and documentation

**Files:**
- Create: `src/shorts/commands.ts`
- Create: `tests/shorts.cli.test.ts`
- Modify: `src/cli.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `planShortsProject`, `ProjectStore`, and `GeminiStoryPlanner` from Tasks 2–4.
- Produces: `registerShortsCommands(program: Command, dependencies?: ShortsCommandDependencies): void` and the public `gflow shorts plan` command.

- [ ] **Step 1: Write failing CLI tests**

```ts
it("plans ten episodes from only a topic and output directory", async () => {
  const planProject = vi.fn().mockResolvedValue(plannedState);
  const program = createProgram({ planShortsProject: planProject });
  await program.parseAsync(["node", "gflow", "shorts", "plan", "--topic", "Đại dương kỳ bí", "--out", outputDir]);
  expect(planProject).toHaveBeenCalledWith(expect.objectContaining({
    config: expect.objectContaining({ topic: "Đại dương kỳ bí", language: "vi-VN" })
  }));
});

it("fails before provider work when GEMINI_API_KEY is absent", async () => {
  const program = createProgram({ environment: {} });
  await expect(program.parseAsync(["node", "gflow", "shorts", "plan", "--topic", "Đại dương kỳ bí", "--out", outputDir]))
    .rejects.toThrow(/GEMINI_API_KEY is required/);
});

it("keeps existing top-level commands in help", () => {
  const help = createProgram().helpInformation();
  expect(help).toContain("shorts");
  expect(help).toContain("image");
  expect(help).toContain("video");
  expect(help).toContain("batch");
});
```

- [ ] **Step 2: Run CLI tests and verify RED**

Run: `npm test -- tests/shorts.cli.test.ts`

Expected: FAIL because the `shorts` command and dependency hook do not exist.

- [ ] **Step 3: Register and compose the command**

```ts
export interface ShortsCommandDependencies {
  environment?: NodeJS.ProcessEnv;
  planShortsProject?: typeof planShortsProject;
}

export function registerShortsCommands(program: Command, dependencies: ShortsCommandDependencies = {}): void;
```

Options are `--topic <text>`, `--out <path>`, `--language <tag>` defaulting to `vi-VN`, `--text-model <name>` defaulting to `gemini-2.5-flash`, `--image-model <name>` defaulting to `gemini-2.5-flash-image`, `--tts-model <name>` defaulting to `gemini-2.5-flash-preview-tts`, and `--force`. Resolve `--out` once and pass it to `ProjectStore`. Construct the real Gemini transport lazily inside the action so help and unrelated commands never require an API key.

Extend `CreateProgramOptions` with the same dependency hooks and call `registerShortsCommands(program, options)`. Print the manifest path, project stage, episode count, and scene count after success; do not print prompts or secrets.

- [ ] **Step 4: Document exact usage and secret handling**

Add a README section containing:

```bash
export GEMINI_API_KEY="set-this-in-your-shell-secret-manager"
npm run dev -- shorts plan --topic "Đại dương kỳ bí" --out ./shorts-output/ocean
```

State that the first milestone plans only; it does not generate media, spend Flow credits, or publish. Link the approved design spec.

- [ ] **Step 5: Verify CLI, full suite, lint, build, and production audit**

Run: `npm test -- tests/shorts.cli.test.ts tests/cli.help.test.ts tests/cli.test.ts`

Expected: PASS.

Run: `npm test`

Expected: all tests PASS.

Run: `npm run lint`

Expected: exit 0 with no lint errors.

Run: `npm run build`

Expected: exit 0 with no TypeScript errors.

Run: `npm audit --omit=dev`

Expected: zero production vulnerabilities.

- [ ] **Step 6: Commit the CLI milestone**

```bash
git add src/cli.ts src/shorts/commands.ts tests/shorts.cli.test.ts README.md
git commit -m "feat: add shorts planning command"
```

## Milestone verification

- [ ] Run `npm test` and record the passing test count.
- [ ] Run `npm run lint` and confirm zero errors.
- [ ] Run `npm run build` and confirm exit 0.
- [ ] Run `npm audit --omit=dev` and confirm zero production advisories.
- [ ] Run `git diff --check HEAD~5 HEAD` and confirm no whitespace errors across the milestone commits.
- [ ] Run `git status --short --branch` and report any remaining or unrelated changes without deleting them.
