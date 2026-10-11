/**
 * 按任务选择模型 — a profile per kind of work.
 *
 * Everything follows the default until the reader chooses; a choice is
 * remembered across reloads; a choice whose profile is gone falls back rather
 * than failing; and the request a task sends carries *its* profile.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderProfile } from "@/api/profiles";
import { RelatedPanel } from "@/related/RelatedPanel";
import { TaskModelsSection } from "@/settings/TaskModelsSection";
import {
  profileIdFor,
  readTaskModels,
  TASK_MODELS_STORAGE_KEY,
} from "@/settings/taskModels";
import { useWorkspaceStore } from "@/stores/workspace";
import { seedDocument } from "@/tests/fixtures";

const profile = (id: string, name: string): ProviderProfile => ({
  id, name, base_url: "https://api.example.com/v1", model: `${name}-model`,
  protocol: "auto", has_key: true, api_key_masked: "sk-••••", kind: "llm",
});

const FAST = profile("prof_fast", "Fast");
const DEEP = profile("prof_deep", "Deep");

describe("按任务选择模型", () => {
  beforeEach(() => {
    window.localStorage.removeItem(TASK_MODELS_STORAGE_KEY);
    useWorkspaceStore.setState({ profiles: [FAST, DEEP], profileId: FAST.id, taskModels: {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses the default for every task until one is chosen", () => {
    const state = useWorkspaceStore.getState();
    for (const task of ["translate", "qa", "overview", "related"] as const) {
      expect(profileIdFor(task, state)).toBe(FAST.id);
    }
  });

  it("remembers a choice, and gives a task back to the default", async () => {
    const user = userEvent.setup();
    render(<TaskModelsSection profiles={[FAST, DEEP]} />);
    expect(screen.getByTestId("settings-task-models")).toHaveTextContent("默认模型（Fast）");

    await user.selectOptions(screen.getByTestId("task-model-qa"), DEEP.id);
    expect(profileIdFor("qa", useWorkspaceStore.getState())).toBe(DEEP.id);
    expect(profileIdFor("translate", useWorkspaceStore.getState())).toBe(FAST.id);
    // What a reload would read back. Ids only — never a key.
    expect(readTaskModels()).toEqual({ qa: DEEP.id });
    expect(window.localStorage.getItem(TASK_MODELS_STORAGE_KEY)).not.toContain("sk-");

    await user.selectOptions(screen.getByTestId("task-model-qa"), "");
    expect(profileIdFor("qa", useWorkspaceStore.getState())).toBe(FAST.id);
    expect(readTaskModels()).toEqual({});
  });

  it("falls back to the default when the chosen profile no longer exists", () => {
    useWorkspaceStore.setState({ taskModels: { overview: "prof_deleted" } });
    expect(profileIdFor("overview", useWorkspaceStore.getState())).toBe(FAST.id);

    render(<TaskModelsSection profiles={[FAST, DEEP]} />);
    expect(screen.getByTestId("task-model-overview")).toHaveValue("");
  });

  it("survives a damaged stored record", () => {
    window.localStorage.setItem(TASK_MODELS_STORAGE_KEY, '{"qa": 5, "nonsense": "x", "related": "prof_deep"');
    expect(readTaskModels()).toEqual({});
    window.localStorage.setItem(TASK_MODELS_STORAGE_KEY, '{"qa": 5, "nonsense": "x", "related": "prof_deep"}');
    expect(readTaskModels()).toEqual({ related: "prof_deep" });
  });

  it("sends the explanation with the profile chosen for 文献关系说明", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({ document: seedDocument(), taskModels: { related: DEEP.id } });
    const sent: Array<{ profile_id: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        sent.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ relations: {} }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        source: "openalex", identified: null, cached: true,
        query: { doi: null, title: "Paper" },
        papers: [{
          key: "W1", kind: "citing", title: "Paper W1", authors: [], year: 2016, venue: null, doi: null,
          url: null, abstract: "An abstract.", cited_by: null, oa_pdf_url: null, relation: null,
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    render(<RelatedPanel />);
    await user.click(await screen.findByTestId("related-explain"));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.profile_id).toBe(DEEP.id);
  });
});
