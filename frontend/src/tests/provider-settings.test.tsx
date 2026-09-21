/**
 * DS-FE-004 — the settings screen: what it writes, and what it must never write.
 *
 * Two rules run through every test here. The first is that a stored key is
 * nobody's to show: the client is given a mask, the input starts empty, and a
 * save that did not touch the key must not mention it at all. The second is that
 * nothing spends a request without a click — not opening the dialog, not
 * selecting a profile, not editing a field.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderProfile } from "@/api/profiles";
import { App } from "@/app/App";
import { useWorkspaceStore } from "@/stores/workspace";

const getDocument = vi.fn();
vi.mock("@/pdf/pdfjs", () => {
  const STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0];
  const module = {
    getDocument: (...args: unknown[]) => getDocument(...args),
    TextLayer: class {
      render() { return Promise.resolve(); }
      cancel() {}
    },
    setLayerDimensions: () => {},
    GlobalWorkerOptions: {},
  };
  return {
    loadPdfjs: () => Promise.resolve(module),
    ZOOM_STEPS: STEPS, MIN_ZOOM: STEPS[0], MAX_ZOOM: STEPS[STEPS.length - 1],
    FIT_WIDTH_PADDING_PX: 32, RENDER_BUFFER_MARGIN_PX: 300,
    clampZoom: (s: number) => Math.min(3, Math.max(0.5, s)),
    zoomIn: (s: number) => STEPS.find((x) => x > s + 1e-6) ?? 3,
    zoomOut: (s: number) => [...STEPS].reverse().find((x) => x < s - 1e-6) ?? 0.5,
  };
});

function profile(over: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    id: "prof_1",
    name: "Deepseek",
    base_url: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    protocol: "auto",
    has_key: true,
    api_key_masked: "sk-••••••••1234",
    ...over,
  };
}

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

/** Answer the profile surface, and record every write verbatim. */
function backend(options: {
  profiles?: ProviderProfile[];
  onCreate?: () => Response;
  onPatch?: (body: Record<string, unknown>) => Response;
  onTest?: () => Response;
} = {}) {
  const calls: Recorded[] = [];
  let profiles = options.profiles ?? [profile()];

  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, path, body });

    if (path.includes("/test")) {
      return options.onTest
        ? options.onTest()
        : json({ ok: true, protocol: "chat_completions", model: "deepseek-chat", latency_ms: 142 });
    }
    if (/_delete|\/profiles\/[^/]+$/.test(path) && method === "DELETE") {
      profiles = profiles.filter((item) => !path.endsWith(item.id));
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/profiles") && method === "POST") {
      if (options.onCreate) return options.onCreate();
      const created = profile({
        id: "prof_new",
        name: String(body?.name ?? ""),
        base_url: String(body?.base_url ?? ""),
        model: String(body?.model ?? ""),
        has_key: typeof body?.api_key === "string" && body.api_key !== "",
        api_key_masked: typeof body?.api_key === "string" && body.api_key !== ""
          ? "sk-••••••••live" : "",
      });
      profiles = [...profiles, created];
      return json(created, 201);
    }
    if (/\/profiles\/[^/]+$/.test(path) && method === "PATCH") {
      if (options.onPatch) return options.onPatch(body ?? {});
      const id = path.split("/").pop()!;
      const existing = profiles.find((item) => item.id === id)!;
      const updated: ProviderProfile = {
        ...existing,
        name: String(body?.name ?? existing.name),
        model: String(body?.model ?? existing.model),
        has_key: body !== null && "api_key" in body ? body.api_key !== "" : existing.has_key,
        api_key_masked:
          body !== null && "api_key" in body && body.api_key !== ""
            ? "sk-••••••••5678" : existing.api_key_masked,
      };
      profiles = profiles.map((item) => (item.id === id ? updated : item));
      return json(updated);
    }
    if (path.includes("/profiles")) return json(profiles);
    if (path.includes("/overview") || path.includes("/annotations") || path.includes("/sections")) {
      return new Response("", { status: 404 });
    }
    return new Response("", { status: 404 });
  }));

  return {
    calls,
    writes: () => calls.filter((call) => call.method !== "GET"),
    patchBodies: () => calls.filter((call) => call.method === "PATCH").map((call) => call.body),
    /** The one body shape the backend refuses outright, counted. */
    patchesWithNullKey: () =>
      calls.filter(
        (call) => call.method === "PATCH" && call.body !== null && call.body.api_key === null,
      ).length,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

function errorEnvelope(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message, detail: {} } }), {
    status, headers: { "Content-Type": "application/json" },
  });
}

async function openSettings() {
  render(<App />);
  const user = userEvent.setup();
  await user.click(screen.getByTestId("settings-open"));
  return { user, dialog: await screen.findByTestId("settings-dialog") };
}

beforeEach(() => {
  window.localStorage.clear();
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  getDocument.mockReset();
  getDocument.mockReturnValue({
    promise: Promise.resolve({
      numPages: 12,
      getPage: vi.fn(async () => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale, rotation: 0 }),
        render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
        streamTextContent: () => ({}),
      })),
    }),
    destroy: vi.fn(async () => undefined),
  });
  useWorkspaceStore.setState({ document: null, translation: null, profileId: "" });
});

describe("DS-FE-004 · the screen itself", () => {
  it("opens from the settings button and closes again (AC-P0-01)", async () => {
    backend();
    const { user, dialog } = await openSettings();
    expect(dialog).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByTestId("settings-dialog")).toBeNull());
    // And focus is back on the control that opened it.
    expect(document.activeElement).toBe(screen.getByTestId("settings-open"));
  });

  it("keeps Tab inside the dialog (AC-P0-02)", async () => {
    backend();
    const { user, dialog } = await openSettings();

    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled])'),
    );
    const last = focusable[focusable.length - 1]!;
    last.focus();
    await user.tab();
    // Wrapped: the first control inside the dialog, not the page behind it.
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("lists the services, and says so when there are none (AC-P0-04)", async () => {
    backend();
    const { dialog } = await openSettings();
    expect(within(dialog).getByTestId("settings-profile-prof_1")).toHaveTextContent("Deepseek");
    expect(within(dialog).getByTestId("settings-profile-prof_1")).toHaveTextContent(
      "https://api.deepseek.com/v1",
    );
  });

  it("has an empty state with a way out of it (AC-P0-04)", async () => {
    backend({ profiles: [] });
    const { dialog } = await openSettings();
    expect(within(dialog).getByTestId("settings-empty")).toBeInTheDocument();
    expect(within(dialog).getByTestId("settings-new")).toBeInTheDocument();
  });

  it("shows a stored key as the server's mask, and never as anything else (AC-P0-05)", async () => {
    backend();
    const { user, dialog } = await openSettings();
    await user.click(within(dialog).getByTestId("settings-profile-prof_1"));

    expect(within(dialog).getByTestId("settings-key-badge")).toHaveTextContent("已保存凭据");
    expect(within(dialog).getByTestId("settings-form")).toHaveTextContent("sk-••••••••1234");
    // The input is empty: what is stored is not this screen's to display.
    expect((within(dialog).getByTestId("settings-api-key") as HTMLInputElement).value).toBe("");
  });

  it("marks a keyless service as such (AC-P0-05)", async () => {
    backend({ profiles: [profile({ has_key: false, api_key_masked: "" })] });
    const { dialog } = await openSettings();
    expect(within(dialog).getByTestId("settings-keyless-badge")).toHaveTextContent("免密模式");
  });
});

describe("DS-FE-004 · creating", () => {
  it("creates a keyless profile without demanding a key (AC-P0-06)", async () => {
    const server = backend({ profiles: [] });
    const { user, dialog } = await openSettings();

    await user.click(within(dialog).getByTestId("settings-new"));
    await user.type(within(dialog).getByTestId("settings-name"), "Ollama");
    await user.type(within(dialog).getByTestId("settings-base-url"), "http://127.0.0.1:11434/v1");
    await user.type(within(dialog).getByTestId("settings-model"), "qwen2.5:7b");
    await user.click(within(dialog).getByTestId("settings-save"));

    await waitFor(() => expect(server.writes().some((call) => call.method === "POST")).toBe(true));
    const post = server.writes().find((call) => call.method === "POST")!;
    expect(post.body).toMatchObject({
      name: "Ollama", base_url: "http://127.0.0.1:11434/v1", model: "qwen2.5:7b", protocol: "auto",
    });
    expect(post.body?.api_key).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId("settings-keyless-badge")).toBeInTheDocument(),
    );
  });

  it("creates a profile with a key, and shows the mask that comes back (AC-P0-07)", async () => {
    backend({ profiles: [] });
    const { user, dialog } = await openSettings();

    await user.click(within(dialog).getByTestId("settings-new"));
    await user.type(within(dialog).getByTestId("settings-name"), "DeepSeek");
    await user.type(within(dialog).getByTestId("settings-base-url"), "https://api.deepseek.com/v1");
    await user.type(within(dialog).getByTestId("settings-model"), "deepseek-chat");
    await user.type(within(dialog).getByTestId("settings-api-key"), "sk-live-secret-test1234");
    await user.click(within(dialog).getByTestId("settings-save"));

    await waitFor(() =>
      expect(screen.getByTestId("settings-key-badge")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("settings-profile-list")).not.toHaveTextContent("sk-live-secret-test1234");
  });

  it("refuses an address that is not http(s) before spending a request (AC-P0-08)", async () => {
    const server = backend({ profiles: [] });
    const { user, dialog } = await openSettings();

    await user.click(within(dialog).getByTestId("settings-new"));
    await user.type(within(dialog).getByTestId("settings-name"), "Bad");
    await user.type(within(dialog).getByTestId("settings-base-url"), "httpx://nope");
    await user.type(within(dialog).getByTestId("settings-model"), "m");
    await user.click(within(dialog).getByTestId("settings-save"));

    expect(within(dialog).getByTestId("settings-error")).toHaveTextContent("http://");
    expect(server.calls.filter((call) => call.method === "POST")).toEqual([]);
  });
});

describe("DS-FE-004 · editing, and the key that must not be touched", () => {
  async function openForEdit(options: Parameters<typeof backend>[0] = {}) {
    const server = backend(options);
    const { user, dialog } = await openSettings();
    await user.click(within(dialog).getByTestId("settings-profile-prof_1"));
    return { server, user, dialog };
  }

  it("saves metadata without mentioning the key at all (AC-P0-09)", async () => {
    const { server, user, dialog } = await openForEdit();

    const model = within(dialog).getByTestId("settings-model");
    await user.clear(model);
    await user.type(model, "deepseek-reasoner");
    await user.click(within(dialog).getByTestId("settings-save"));

    await waitFor(() =>
      expect(server.calls.some((call) => call.method === "PATCH")).toBe(true),
    );
    const body = server.patchBodies()[0]!;
    expect(body).toMatchObject({ model: "deepseek-reasoner" });
    // The whole point: absent, not null, not "". Either of the others would
    // destroy a credential the reader never touched.
    expect("api_key" in body).toBe(false);
    expect(server.patchesWithNullKey()).toBe(0);
  });

  it("replaces the key when one is typed (AC-P0-10)", async () => {
    const { server, user, dialog } = await openForEdit();

    await user.type(within(dialog).getByTestId("settings-api-key"), "sk-new-secret-5678");
    await user.click(within(dialog).getByTestId("settings-save"));

    await waitFor(() =>
      expect(server.calls.some((call) => call.method === "PATCH")).toBe(true),
    );
    expect(server.patchBodies()[0]?.api_key).toBe("sk-new-secret-5678");
    await waitFor(() =>
      expect((screen.getByTestId("settings-api-key") as HTMLInputElement).value).toBe(""),
    );
    expect(screen.getByTestId("settings-form")).toHaveTextContent("sk-••••••••5678");
  });

  it("clears the key only when the reader asks for it (AC-P0-11)", async () => {
    const { server, user, dialog } = await openForEdit();

    await user.click(within(dialog).getByTestId("settings-clear-key"));
    expect(within(dialog).getByTestId("settings-clear-pending")).toBeInTheDocument();
    await user.click(within(dialog).getByTestId("settings-save"));

    await waitFor(() =>
      expect(server.calls.some((call) => call.method === "PATCH")).toBe(true),
    );
    expect(server.patchBodies()[0]?.api_key).toBe("");
    await waitFor(() =>
      expect(screen.getByTestId("settings-keyless-badge")).toBeInTheDocument(),
    );
  });

  it("never sends a null key, in any edit (AC-P0-12)", async () => {
    const { server, user, dialog } = await openForEdit();

    await user.click(within(dialog).getByTestId("settings-save"));
    await waitFor(() => expect(server.patchBodies().length).toBe(1));
    await user.click(within(dialog).getByTestId("settings-clear-key"));
    await user.click(within(dialog).getByTestId("settings-save"));
    await waitFor(() => expect(server.patchBodies().length).toBe(2));

    expect(server.patchesWithNullKey()).toBe(0);
    for (const body of server.patchBodies()) {
      expect(Object.values(body ?? {})).not.toContain(null);
    }
  });
});

describe("DS-FE-004 · deleting", () => {
  it("asks first, then removes the profile and its credential (AC-P0-13)", async () => {
    backend();
    const { user, dialog } = await openSettings();
    await user.click(within(dialog).getByTestId("settings-profile-prof_1"));

    await user.click(within(dialog).getByTestId("settings-delete"));
    expect(within(dialog).getByTestId("settings-confirm-delete")).toHaveTextContent(
      "同时清理系统密钥",
    );
    await user.click(within(dialog).getByTestId("settings-delete-confirm"));

    await waitFor(() =>
      expect(screen.getByTestId("settings-empty")).toBeInTheDocument(),
    );
  });

  it("leaves nothing pointing at the deleted profile (AC-P0-14)", async () => {
    /* The translation dialog re-reads the list every time it opens, so a
       deleted profile cannot be selected there — that half is
       `translation.test.tsx::"says so plainly when no provider is configured"`
       and `::"lists providers and preselects the first"`. What this covers is
       the *application's* selection, which the question and overview paths use:
       left dangling it fails later, when the reader asks for something. */
    backend();
    const { user, dialog } = await openSettings();
    useWorkspaceStore.setState({ profileId: "prof_1" });

    await user.click(within(dialog).getByTestId("settings-profile-prof_1"));
    await user.click(within(dialog).getByTestId("settings-delete"));
    await user.click(within(dialog).getByTestId("settings-delete-confirm"));

    await waitFor(() => expect(screen.getByTestId("settings-empty")).toBeInTheDocument());
    expect(useWorkspaceStore.getState().profileId).toBe("");
  });
});

describe("DS-FE-004 · the probe", () => {
  it("does not probe until it is asked to (AC-P0-15)", async () => {
    const server = backend();
    const { user, dialog } = await openSettings();
    await user.click(within(dialog).getByTestId("settings-profile-prof_1"));
    expect(server.calls.filter((call) => call.path.includes("/test"))).toEqual([]);

    await user.click(within(dialog).getByTestId("settings-test"));
    await waitFor(() =>
      expect(server.calls.filter((call) => call.path.includes("/test"))).toHaveLength(1),
    );
    expect(await screen.findByTestId("settings-probe-result")).toHaveTextContent("连接成功");
    expect(screen.getByTestId("settings-probe-result")).toHaveTextContent("142");
  });

  it("says what the provider said, and does not block the form (AC-P0-16)", async () => {
    backend({
      onTest: () => errorEnvelope(502, "PROVIDER_AUTH_FAILED", "the key was refused"),
    });
    const { user, dialog } = await openSettings();
    await user.click(within(dialog).getByTestId("settings-profile-prof_1"));
    await user.click(within(dialog).getByTestId("settings-test"));

    const result = await screen.findByTestId("settings-probe-result");
    expect(result).toHaveTextContent("认证失败");
    expect(within(dialog).getByTestId("settings-save")).toBeEnabled();
  });
});

describe("DS-FE-004 · when the backend says no", () => {
  it("names a duplicate name on the field (AC-P0-19)", async () => {
    const server = backend();
    const { user, dialog } = await openSettings();
    await user.click(within(dialog).getByTestId("settings-new"));
    await user.type(within(dialog).getByTestId("settings-name"), "deepseek");
    await user.type(within(dialog).getByTestId("settings-base-url"), "https://api.deepseek.com/v1");
    await user.type(within(dialog).getByTestId("settings-model"), "m");
    await user.click(within(dialog).getByTestId("settings-save"));

    // Caught before the request: the list is in hand and the check is the same
    // one the server makes.
    expect(within(dialog).getByTestId("settings-name-error")).toHaveTextContent("已存在");
    expect(server.calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("still names it when the server is the one that refuses (AC-P0-19)", async () => {
    backend({
      profiles: [],
      onCreate: () => errorEnvelope(400, "BAD_REQUEST", "A profile named 'Taken' already exists."),
    });
    const { user, dialog } = await openSettings();
    await user.click(within(dialog).getByTestId("settings-new"));
    await user.type(within(dialog).getByTestId("settings-name"), "Taken");
    await user.type(within(dialog).getByTestId("settings-base-url"), "https://api.deepseek.com/v1");
    await user.type(within(dialog).getByTestId("settings-model"), "m");
    await user.click(within(dialog).getByTestId("settings-save"));

    await waitFor(() =>
      expect(screen.getByTestId("settings-name-error")).toHaveTextContent("已存在"),
    );
  });

  it("explains a credential store that is not there, without falling back to disk (AC-P0-19)", async () => {
    backend({
      profiles: [],
      onCreate: () => errorEnvelope(503, "SERVICE_UNAVAILABLE", "Credential store is unavailable"),
    });
    const { user, dialog } = await openSettings();
    await user.click(within(dialog).getByTestId("settings-new"));
    await user.type(within(dialog).getByTestId("settings-name"), "New");
    await user.type(within(dialog).getByTestId("settings-base-url"), "https://api.deepseek.com/v1");
    await user.type(within(dialog).getByTestId("settings-model"), "m");
    await user.type(within(dialog).getByTestId("settings-api-key"), "sk-should-not-be-saved");
    await user.click(within(dialog).getByTestId("settings-save"));

    await waitFor(() =>
      expect(screen.getByTestId("settings-error")).toHaveTextContent("凭据存储不可用"),
    );
    // Nothing was invented to make it work: the key is in the request and
    // nowhere else on this machine.
    expect(window.localStorage.getItem("copilot:active_session_v1")).toBeNull();
  });
});
