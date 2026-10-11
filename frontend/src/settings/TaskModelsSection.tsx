/**
 * 设置 · 按任务选择模型.
 *
 * Four kinds of work, each with a choice of profile; all four follow the default
 * until changed. Choosing here sends nothing anywhere — it only decides which
 * `profile_id` the next translation, question, overview or explanation carries.
 */
import { Workflow } from "lucide-react";

import type { ProviderProfile } from "@/api/profiles";
import { MODEL_TASKS, profileIdFor } from "@/settings/taskModels";
import { useWorkspaceStore } from "@/stores/workspace";

export function TaskModelsSection({ profiles }: { profiles: ProviderProfile[] | null }) {
  const taskModels = useWorkspaceStore((state) => state.taskModels);
  const setTaskModel = useWorkspaceStore((state) => state.setTaskModel);
  const defaultId = useWorkspaceStore((state) => state.profileId);

  if (profiles === null || profiles.length === 0) return null;

  // The application's default is its first profile until a document loads the
  // list into the store; name the one that will actually be used.
  const fallback = profiles.find((profile) => profile.id === defaultId) ?? profiles[0]!;

  return (
    <section data-testid="settings-task-models" className="space-y-2 border-t pt-3">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold">
        <Workflow className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
        按任务选择模型
      </h3>
      <p className="text-2xs leading-relaxed text-muted-foreground">
        不同的工作可以交给不同的模型：例如翻译用便宜快速的，问答用推理更强的。未单独选择的任务使用默认模型（{fallback.name}）。
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        {MODEL_TASKS.map(({ task, label, hint }) => {
          // A choice whose profile has been deleted shows as the default it
          // falls back to, not as a blank row.
          const effective = profileIdFor(task, { profileId: "", profiles, taskModels });
          return (
            <label key={task} className="text-2xs text-muted-foreground">
              {label}
              <span className="ml-1 opacity-80">· {hint}</span>
              <select
                data-testid={`task-model-${task}`}
                value={effective}
                onChange={(event) => setTaskModel(task, event.target.value)}
                className="mt-0.5 h-7 w-full rounded-md border bg-background px-1 text-xs text-foreground"
              >
                <option value="">默认（{fallback.name}）</option>
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}（{profile.model}）
                  </option>
                ))}
              </select>
            </label>
          );
        })}
      </div>
    </section>
  );
}
