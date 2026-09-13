import type { ProjectState, CreateProjectInput, ProjectStore } from "./project-store.js";
import type { StoryPlanner } from "./planner.js";
import { parseTopic } from "./schema.js";

export interface PlanShortsInput {
  config: CreateProjectInput;
  store: Pick<ProjectStore, "create" | "load" | "savePlan">;
  planner: StoryPlanner;
  force?: boolean;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function configMatchesState(config: CreateProjectInput, state: ProjectState): boolean {
  return (
    parseTopic(config.topic) === state.topic &&
    config.language.trim() === state.language &&
    config.textModel.trim() === state.models.text &&
    config.imageModel.trim() === state.models.image &&
    config.ttsModel.trim() === state.models.tts
  );
}

async function loadOrCreate(
  store: Pick<ProjectStore, "create" | "load">,
  config: CreateProjectInput
): Promise<ProjectState> {
  try {
    return await store.load();
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return store.create(config);
  }
}

export async function planShortsProject(input: PlanShortsInput): Promise<ProjectState> {
  const state = await loadOrCreate(input.store, input.config);
  if (!configMatchesState(input.config, state)) {
    throw new Error("Planning configuration does not match the existing shorts project");
  }
  if (state.stage === "PLANNED" && !input.force) return state;

  const plan = await input.planner.plan({
    topic: state.topic,
    language: state.language,
    model: state.models.text
  });
  return input.store.savePlan(plan);
}
