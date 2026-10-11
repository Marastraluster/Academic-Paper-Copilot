/**
 * Which model profile each kind of work uses.
 *
 * One profile serves everything until the reader says otherwise: a paper is
 * translated in bulk (cheap and fast matters), questioned in detail (reasoning
 * matters), and those are often different models. A task with no choice of its
 * own follows the default — the application's one selected profile — so nothing
 * changes for a reader who never opens this setting.
 *
 * The choices are a preference of this browser, not of a document, so they live
 * in `localStorage` beside the reading session. Only profile *ids* are stored;
 * the keys stay where they always were, in the backend's credential store.
 */
import type { ProviderProfile } from "@/api/profiles";

export type ModelTask = "translate" | "qa" | "overview" | "related";

export const MODEL_TASKS: ReadonlyArray<{ task: ModelTask; label: string; hint: string }> = [
  { task: "translate", label: "翻译", hint: "逐段对照与版面翻译" },
  { task: "qa", label: "问答", hint: "侧边栏提问与快捷操作" },
  { task: "overview", label: "AI 概览", hint: "生成论文概览" },
  { task: "related", label: "文献关系说明", hint: "说明相关论文与本文的关系" },
];

/** A task that is absent follows the default profile. */
export type TaskModels = Partial<Record<ModelTask, string>>;

export const TASK_MODELS_STORAGE_KEY = "copilot:task_models_v1";

const TASKS = new Set<string>(MODEL_TASKS.map((entry) => entry.task));

/** The stored choices. Every failure — no storage, a damaged record — is `{}`. */
export function readTaskModels(): TaskModels {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(TASK_MODELS_STORAGE_KEY);
  } catch {
    return {};
  }
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: TaskModels = {};
    for (const [task, id] of Object.entries(parsed)) {
      if (TASKS.has(task) && typeof id === "string" && id !== "") out[task as ModelTask] = id;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeTaskModels(choices: TaskModels): void {
  try {
    window.localStorage.setItem(TASK_MODELS_STORAGE_KEY, JSON.stringify(choices));
  } catch {
    // No storage: the choice lasts for this window, which is still a choice.
  }
}

/**
 * The profile a task should use right now.
 *
 * A choice that names a profile no longer in the list falls back to the default
 * rather than failing at the moment the reader asks for something. Before the
 * list has loaded the choice is trusted — the backend refuses an unknown id.
 */
export function profileIdFor(
  task: ModelTask,
  state: { profileId: string; profiles: ProviderProfile[] | null; taskModels: TaskModels },
): string {
  const chosen = state.taskModels[task];
  if (chosen && (state.profiles === null || state.profiles.some((profile) => profile.id === chosen))) {
    return chosen;
  }
  return state.profileId;
}
