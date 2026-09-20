import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "@/app/App";
import { useWorkspaceStore } from "@/stores/workspace";
import { seedTranslatedDocument } from "@/tests/fixtures";

/**
 * PDF.js is stubbed. These tests are about the translation flow — what request
 * is sent, what the UI reports, and which document a result belongs to — not
 * about rasterising pages.
 */
vi.mock("@/pdf/pdfjs", () => {
  const document = {
    numPages: 2,
    getPage: async () => ({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
      streamTextContent: () => ({}),
    }),
  };
  const module = {
    getDocument: () => ({ promise: Promise.resolve(document), destroy: async () => {} }),
    TextLayer: class {
      render() {
        return Promise.resolve();
      }
      cancel() {}
    },
    setLayerDimensions: () => {},
    GlobalWorkerOptions: {},
  };
  return {
    loadPdfjs: () => Promise.resolve(module),
    ZOOM_STEPS: [0.5, 0.75, 1, 1.25, 1.5, 2, 3],
    MIN_ZOOM: 0.5,
    MAX_ZOOM: 3,
    FIT_WIDTH_PADDING_PX: 32,
    RENDER_BUFFER_MARGIN_PX: 300,
    clampZoom: (s: number) => Math.min(3, Math.max(0.5, s)),
    zoomIn: (s: number) => s + 0.25,
    zoomOut: (s: number) => s - 0.25,
  };
});

// --- a fake EventSource ------------------------------------------------------

type Listener = (event: Event) => void;

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  closed = false;
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(name: string, listener: Listener): void {
    const existing = this.listeners.get(name) ?? [];
    existing.push(listener);
    this.listeners.set(name, existing);
  }

  close(): void {
    this.closed = true;
  }

  /** Deliver a server-sent named event carrying JSON. */
  emit(name: string, payload: unknown): void {
    if (this.closed) return;
    for (const listener of this.listeners.get(name) ?? []) {
      listener(new MessageEvent(name, { data: JSON.stringify(payload) }));
    }
  }

  /** Simulate the connection dropping — a bare Event, as the browser sends. */
  fail(): void {
    if (this.closed) return;
    for (const listener of this.listeners.get("error") ?? []) listener(new Event("error"));
  }
}

// --- a routed fetch ----------------------------------------------------------

const BASE = "http://127.0.0.1:8000";

interface RecordedCall {
  url: string;
  init: RequestInit;
}

let calls: RecordedCall[] = [];
let uploadCount = 0;
let translatedBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" });
let uploadGate: Promise<void> | null = null;
let artifactGate: Promise<void> | null = null;

/** Body that the fake task snapshot server reports next. */
let taskStatus = "PENDING";
let taskProgress: { page: number; page_count: number } | null = null;
let taskError: { code: string; message: string } | null = null;

const PROFILES = [
  {
    id: "prof_local",
    name: "Local vLLM",
    base_url: "http://127.0.0.1:8001/v1",
    model: "qwen2.5",
    protocol: "chat_completions",
    // Keyless: a supported configuration that must not be rejected.
    has_key: false,
    api_key_masked: "",
  },
  {
    id: "prof_remote",
    name: "DeepSeek",
    base_url: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    protocol: "chat_completions",
    has_key: true,
    api_key_masked: "sk-••••••••ab12",
  },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function envelope(status: number, code: string, message: string): Response {
  return json({ error: { code, message, detail: {} } }, status);
}

function taskPayload(overrides: Record<string, unknown> = {}) {
  return {
    task_id: "task_1",
    document_id: `doc_${uploadCount}`,
    status: taskStatus,
    lang_in: "en",
    lang_out: "zh",
    engine: "fast",
    progress: taskProgress,
    error: taskError,
    created_at: "2026-09-17T00:00:00Z",
    updated_at: "2026-09-17T00:00:00Z",
    ...overrides,
  };
}

function installFetch(handler?: (url: string, init: RequestInit) => Response | null) {
  const mock = vi.fn(async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });

    const custom = handler?.(url, init);
    if (custom) return custom;

    if (url === `${BASE}/api/profiles`) return json(PROFILES);

    if (url === `${BASE}/api/documents` && (init.method ?? "GET") === "POST") {
      if (uploadGate) await uploadGate;
      uploadCount += 1;
      return json(
        {
          document_id: `doc_${uploadCount}`,
          name: "paper.pdf",
          page_count: 2,
          source: "upload",
          has_translation: false,
          created_at: "2026-09-17T00:00:00Z",
        },
        201,
      );
    }

    if (/\/api\/documents\/doc_\d+\/translate$/.test(url)) {
      return json({ task_id: "task_1", document_id: `doc_${uploadCount}`, status: "PENDING" }, 202);
    }

    if (/\/api\/tasks\/[^/]+$/.test(url)) return json(taskPayload());

    if (/\/api\/documents\/doc_\d+\/translated$/.test(url)) {
      if (artifactGate) await artifactGate;
      return new Response(translatedBlob, {
        status: 200,
        headers: { "Content-Type": "application/pdf" },
      });
    }

    throw new Error(`unrouted request: ${init.method ?? "GET"} ${url}`);
  });

  vi.stubGlobal("fetch", mock);
  return mock;
}

/** Run the real upload path and wait until the app has a backend document. */
async function openPdf(name = "paper.pdf") {
  const input = screen.getByTestId("pdf-file-input");
  fireEvent.change(input, {
    target: { files: [new File([new Uint8Array([1, 2, 3])], name, { type: "application/pdf" })] },
  });
  await waitFor(() =>
    expect(useWorkspaceStore.getState().document?.registration).toBe("ready"),
  );
}

function taskEvents(): FakeEventSource {
  const source = FakeEventSource.instances.at(-1);
  if (!source) throw new Error("no EventSource was opened");
  return source;
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  // The sidebar opens on 概览 now (DS-QA-014). This suite is about the QA panel,
  // so it says so rather than depending on which tab happens to be the default —
  // a dependency that would silently retarget every assertion here the next time
  // the default moves.
  useWorkspaceStore.setState({ outlinePanel: "qa", sidebarOpen: true });

  calls = [];
  uploadCount = 0;
  uploadGate = null;
  artifactGate = null;
  taskStatus = "PENDING";
  taskProgress = null;
  taskError = null;
  translatedBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" });
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  installFetch();
});

afterEach(() => {
  // Deliberately NOT `vi.unstubAllGlobals()`: setup.ts installs the
  // IntersectionObserver/ResizeObserver stubs through the same registry, and
  // clearing it here would tear them out for every later test in this file.
  // `fetch` and `EventSource` are re-stubbed in `beforeEach` instead.
  vi.restoreAllMocks();
});

// --- AC-P0-01 … AC-P0-03: opening and registering -----------------------------

describe("DS-FE-003 · opening a document", () => {
  it("keeps 翻译 disabled until a document has a backend identity (AC-P0-03)", async () => {
    render(<App />);
    expect(screen.getByTestId("ai-translate")).toBeDisabled();

    // Hold the upload open so the in-flight state is observable.
    const gate = deferred();
    uploadGate = gate.promise;

    fireEvent.change(screen.getByTestId("pdf-file-input"), {
      target: { files: [new File([new Uint8Array([1])], "paper.pdf", { type: "application/pdf" })] },
    });

    await waitFor(() =>
      expect(useWorkspaceStore.getState().document?.registration).toBe("pending"),
    );
    expect(screen.getByTestId("ai-translate")).toBeDisabled();

    gate.resolve();
    await waitFor(() => expect(screen.getByTestId("ai-translate")).toBeEnabled());
  });

  it("registers the file as a multipart upload (AC-P0-02)", async () => {
    render(<App />);
    await openPdf();

    const upload = calls.find(
      (call) => call.url === `${BASE}/api/documents` && call.init.method === "POST",
    );
    expect(upload).toBeDefined();

    const body = upload!.init.body;
    expect(body).toBeInstanceOf(FormData);
    const file = (body as FormData).get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("paper.pdf");

    // The browser must set the multipart boundary itself; a hand-set
    // Content-Type strips it and the request fails to parse.
    const headers = (upload!.init.headers ?? {}) as Record<string, string>;
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("renders the PDF before the backend has answered (AC-P0-01)", async () => {
    uploadGate = deferred().promise; // never resolves
    render(<App />);

    fireEvent.change(screen.getByTestId("pdf-file-input"), {
      target: { files: [new File([new Uint8Array([1])], "paper.pdf", { type: "application/pdf" })] },
    });

    // Reading does not wait on the network.
    await waitFor(() => expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument());
  });

  it("reports a registration failure without breaking the reader (AC-P0-13)", async () => {
    // A transport failure, not an HTTP error: nothing answers at all.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    render(<App />);
    fireEvent.change(screen.getByTestId("pdf-file-input"), {
      target: { files: [new File([new Uint8Array([1])], "paper.pdf", { type: "application/pdf" })] },
    });

    await waitFor(() =>
      expect(useWorkspaceStore.getState().document?.registration).toBe("failed"),
    );
    // The document is still readable, and translation is simply unavailable.
    await waitFor(() => expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument());
    expect(screen.getByTestId("ai-translate")).toBeDisabled();
    expect(useWorkspaceStore.getState().engine.state).toBe("error");
    expect(
      useWorkspaceStore.getState().document?.registrationError?.detail,
    ).toContain(BASE);
  });
});

// --- AC-P0-04 / AC-P0-05: dialog and request ---------------------------------

describe("DS-FE-003 · translate dialog", () => {
  it("lists providers and preselects the first (AC-P0-04)", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openPdf();

    await user.click(screen.getByTestId("ai-translate"));

    const select = await screen.findByTestId("translate-profile");
    expect(select).toHaveValue("prof_local");
    expect(within(select).getAllByRole("option")).toHaveLength(2);
  });

  it("accepts a keyless provider without demanding a key (AC-P0-04)", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openPdf();
    await user.click(screen.getByTestId("ai-translate"));

    const select = await screen.findByTestId("translate-profile");
    expect(select).toHaveValue("prof_local");
    // No key prompt, and the model of the keyless profile is shown.
    expect(screen.getByTestId("translate-model")).toHaveTextContent("qwen2.5");
    expect(screen.getByTestId("translate-submit")).toBeEnabled();
  });

  it("sends exactly the fields the request model allows (AC-P0-05)", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openPdf();
    await user.click(screen.getByTestId("ai-translate"));
    await screen.findByTestId("translate-profile");
    await user.click(screen.getByTestId("translate-submit"));

    await waitFor(() =>
      expect(useWorkspaceStore.getState().translation?.taskId).toBe("task_1"),
    );

    const start = calls.find((call) => call.url.endsWith("/translate"));
    expect(start).toBeDefined();
    const body = JSON.parse(String(start!.init.body));

    // `extra="forbid"` on the backend: an extra key is a 422, not a silent drop.
    // The set grew by one in DS-CTX-004 — `context_mode` is now part of the
    // contract, and the assertion is still exact, which is what makes it worth
    // having: a field added carelessly would fail here rather than at runtime.
    expect(Object.keys(body).sort()).toEqual(
      ["context_mode", "engine", "lang_in", "lang_out", "profile_id"].sort(),
    );
    expect(body).toEqual({
      profile_id: "prof_local",
      lang_in: "en",
      lang_out: "zh",
      engine: "fast",
      // Basic by default: DS-CTX-004 measured no quality difference between the
      // academic and basic prompts while academic cost 2.07x the tokens.
      context_mode: "off",
    });
  });

  it("says so plainly when no provider is configured (AC-P0-04)", async () => {
    const user = userEvent.setup();
    installFetch((url) => (url === `${BASE}/api/profiles` ? json([]) : null));

    render(<App />);
    await openPdf();
    await user.click(screen.getByTestId("ai-translate"));

    expect(await screen.findByTestId("translate-no-profiles")).toBeInTheDocument();
    expect(screen.getByTestId("translate-submit")).toBeDisabled();
  });

  it("surfaces a provider-list failure instead of silently offering nothing", async () => {
    const user = userEvent.setup();
    installFetch((url) =>
      url === `${BASE}/api/profiles`
        ? envelope(500, "INTERNAL_ERROR", "An internal error occurred.")
        : null,
    );

    render(<App />);
    await openPdf();
    await user.click(screen.getByTestId("ai-translate"));

    expect(await screen.findByTestId("translate-profile-error")).toBeInTheDocument();
    expect(screen.getByTestId("translate-submit")).toBeDisabled();
  });
});

// --- AC-P0-06 … AC-P0-09: progress and success --------------------------------

describe("DS-FE-003 · progress", () => {
  it("shows an indeterminate bar before any page has been reported (AC-P0-07)", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openPdf();
    await user.click(screen.getByTestId("ai-translate"));
    await screen.findByTestId("translate-profile");
    await user.click(screen.getByTestId("translate-submit"));

    await waitFor(() => expect(screen.getByTestId("translation-running")).toBeInTheDocument());

    // No measurement yet, so no number and no aria-valuenow.
    expect(screen.getByTestId("status-percent")).toHaveTextContent("…");
    expect(screen.getByRole("progressbar", { name: "翻译进度" })).not.toHaveAttribute(
      "aria-valuenow",
    );
    expect(screen.getByTestId("translation-progress-label")).toHaveTextContent(
      "正在提交翻译任务…",
    );
  });

  it("reports the page the backend actually reached (AC-P0-07)", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openPdf();
    await user.click(screen.getByTestId("ai-translate"));
    await screen.findByTestId("translate-profile");
    await user.click(screen.getByTestId("translate-submit"));
    await waitFor(() => expect(taskEvents()).toBeDefined());

    act(() => {
      taskEvents().emit("progress", {
        event: "progress",
        status: "TRANSLATING",
        progress: { page: 1, page_count: 4 },
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId("status-page")).toHaveTextContent("Page 1 / 4"),
    );
    expect(screen.getByTestId("status-percent")).toHaveTextContent("25%");
    expect(screen.getByTestId("translation-progress-label")).toHaveTextContent(
      "正在翻译：第 1 / 4 页",
    );
  });

  it("never invents a phase or a block count (AC-P0-07)", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openPdf();
    await user.click(screen.getByTestId("ai-translate"));
    await screen.findByTestId("translate-profile");
    await user.click(screen.getByTestId("translate-submit"));
    await waitFor(() => expect(screen.getByTestId("translation-running")).toBeInTheDocument());

    act(() => {
      taskEvents().emit("progress", {
        event: "progress",
        status: "TRANSLATING",
        progress: { page: 2, page_count: 4 },
      });
    });

    // The fast kernel runs one unified pipeline; those states do not exist.
    expect(document.body.textContent).not.toMatch(/ANALYZING|RENDERING/);
    expect(document.body.textContent).not.toMatch(/block/i);
  });
});

describe("DS-FE-003 · success", () => {
  it("fetches the mono artifact and unlocks both translated modes (AC-P0-08, AC-P0-09)", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openPdf();

    // Before translation, neither translated mode is available.
    expect(screen.getByTestId("reader-mode-translation")).toBeDisabled();
    expect(screen.getByTestId("reader-mode-bilingual")).toBeDisabled();

    await user.click(screen.getByTestId("ai-translate"));
    await screen.findByTestId("translate-profile");
    await user.click(screen.getByTestId("translate-submit"));
    await waitFor(() => expect(taskEvents()).toBeDefined());

    taskStatus = "SUCCESS";
    act(() => {
      taskEvents().emit("done", { event: "done", status: "SUCCESS", page_count: 2 });
    });

    await waitFor(() =>
      expect(useWorkspaceStore.getState().translation?.status).toBe("success"),
    );

    // The mono artifact — never the 2N dual — feeds the reader.
    const artifact = calls.find((call) => call.url.endsWith("/translated"));
    expect(artifact).toBeDefined();
    expect(calls.some((call) => call.url.endsWith("/bilingual"))).toBe(false);

    expect(screen.getByTestId("reader-mode-translation")).toBeEnabled();
    expect(screen.getByTestId("reader-mode-bilingual")).toBeEnabled();
  });

  it("renders the translated document in the 译文 pane (AC-P0-10)", async () => {
    const user = userEvent.setup();
    seedTranslatedDocument();
    render(<App />);

    await user.click(screen.getByTestId("reader-mode-translation"));

    expect(
      await within(screen.getByTestId("viewer-translated")).findByTestId("pdf-viewer"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("viewer-original")).not.toBeInTheDocument();
  });
});

// --- AC-P0-13 / AC-P0-14: failures -------------------------------------------

describe("DS-FE-003 · failure", () => {
  async function translateThenFail(code: string, message: string) {
    const user = userEvent.setup();
    render(<App />);
    await openPdf();
    await user.click(screen.getByTestId("ai-translate"));
    await screen.findByTestId("translate-profile");
    await user.click(screen.getByTestId("translate-submit"));
    await waitFor(() => expect(taskEvents()).toBeDefined());

    taskStatus = "FAILED";
    taskError = { code, message };
    act(() => {
      taskEvents().emit("error", { event: "error", status: "FAILED", code, message });
    });

    await waitFor(() =>
      expect(useWorkspaceStore.getState().translation?.status).toBe("failed"),
    );
  }

  it("keeps the original readable and offers a retry (AC-P0-13)", async () => {
    await translateThenFail("TRANSLATION_SERVICE_ERROR", "provider exploded");

    expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument();
    expect(screen.getByTestId("translation-error")).toBeInTheDocument();
    // No automatic retry loop: exactly one translate call so far.
    expect(calls.filter((call) => call.url.endsWith("/translate"))).toHaveLength(1);
    expect(screen.getByTestId("translation-retry")).toBeInTheDocument();
  });

  it("turns a provider auth failure into something actionable (AC-P0-14)", async () => {
    // This is the shape a task failure really takes: the kernel wraps it and the
    // provider's identity survives only inside the message (AC_CHANGE_REQUEST 1).
    await translateThenFail(
      "TRANSLATION_SERVICE_ERROR",
      "Translation aborted after a provider failure — LLM_AUTHENTICATION_ERROR: rejected",
    );

    const banner = screen.getByTestId("translation-error");
    expect(banner).toHaveTextContent("认证失败");
    // A rejected key will be rejected again; offering retry would be noise.
    expect(screen.queryByTestId("translation-retry")).not.toBeInTheDocument();
  });

  it("reports an unreachable backend with its address (AC-P0-13)", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openPdf();
    await user.click(screen.getByTestId("ai-translate"));
    await screen.findByTestId("translate-profile");

    // The backend dies between opening the dialog and submitting.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await user.click(screen.getByTestId("translate-submit"));

    const banner = await screen.findByTestId("translation-error");
    expect(banner).toHaveTextContent(BASE);
  });
});

// --- AC-P0-11 / AC-P0-12 / AC-P0-15: identity, retranslation, cleanup ---------

describe("DS-FE-003 · document identity", () => {
  it("drops a result for a document the user has left (AC-P0-11)", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openPdf("first.pdf");

    await user.click(screen.getByTestId("ai-translate"));
    await screen.findByTestId("translate-profile");
    await user.click(screen.getByTestId("translate-submit"));
    await waitFor(() => expect(taskEvents()).toBeDefined());

    // Document A succeeded, but its artifact is slow to arrive.
    const gate = deferred();
    artifactGate = gate.promise;
    taskStatus = "SUCCESS";
    act(() => {
      taskEvents().emit("done", { event: "done", status: "SUCCESS", page_count: 2 });
    });

    // The user moves on before the download finishes.
    await openPdf("second.pdf");
    expect(useWorkspaceStore.getState().document?.documentId).toBe("doc_2");

    // Only now does A's artifact resolve — the post-await guard must reject it.
    await act(async () => {
      gate.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const state = useWorkspaceStore.getState();
    expect(state.translation).toBeNull();
    expect(screen.queryByTestId("translation-running")).not.toBeInTheDocument();
    expect(screen.getByTestId("reader-mode-bilingual")).toBeDisabled();
  });

  it("clears the previous translation and revokes its URL on switch (AC-P0-15)", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    seedTranslatedDocument();
    const { unmount } = render(<App />);

    await waitFor(() =>
      expect(useWorkspaceStore.getState().translation?.monoUrl).toBeTruthy(),
    );

    unmount();

    expect(revoke).toHaveBeenCalledWith("blob:test-translated");
  });

  it("revokes the previous artifact when retranslating (AC-P0-12)", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openPdf();

    await user.click(screen.getByTestId("ai-translate"));
    await screen.findByTestId("translate-profile");
    await user.click(screen.getByTestId("translate-submit"));
    await waitFor(() => expect(taskEvents()).toBeDefined());
    taskStatus = "SUCCESS";
    act(() => {
      taskEvents().emit("done", { event: "done", status: "SUCCESS", page_count: 2 });
    });
    await waitFor(() =>
      expect(useWorkspaceStore.getState().translation?.status).toBe("success"),
    );

    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const firstUrl = useWorkspaceStore.getState().translation?.monoUrl;
    expect(firstUrl).toBeTruthy();

    // Translate again from the toolbar.
    taskStatus = "PENDING";
    await user.click(screen.getByTestId("ai-translate"));
    await screen.findByTestId("translate-profile");
    await user.click(screen.getByTestId("translate-submit"));

    await waitFor(() => expect(revoke).toHaveBeenCalledWith(firstUrl));
    expect(useWorkspaceStore.getState().translation?.monoUrl).toBeNull();
  });
});

// --- AC-P2-01 / AC-P2-02: artifact export ------------------------------------

describe("DS-FE-003 · export", () => {
  it("stays disabled until a translation exists", async () => {
    render(<App />);
    expect(screen.getByTestId("export-menu-trigger")).toBeDisabled();
  });

  it("offers the mono and the dual artifact once translated (AC-P2-01, AC-P2-02)", async () => {
    const user = userEvent.setup();
    seedTranslatedDocument();
    render(<App />);

    const trigger = screen.getByTestId("export-menu-trigger");
    expect(trigger).toBeEnabled();

    await user.click(trigger);

    // The dual PDF is export-only; the reader never loads it.
    expect(screen.getByTestId("export-translated")).toHaveAttribute(
      "href",
      expect.stringContaining(`/api/documents/doc_test/translated`),
    );
    expect(screen.getByTestId("export-bilingual")).toHaveAttribute(
      "href",
      expect.stringContaining(`/api/documents/doc_test/bilingual`),
    );
  });

  it("closes the menu on Escape", async () => {
    const user = userEvent.setup();
    seedTranslatedDocument();
    render(<App />);

    await user.click(screen.getByTestId("export-menu-trigger"));
    expect(screen.getByTestId("export-menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByTestId("export-menu")).not.toBeInTheDocument(),
    );
  });
});

// --- AC-P0-16: credentials ----------------------------------------------------

describe("DS-FE-003 · credentials", () => {
  it("never sends or renders a stored API key (AC-P0-16)", async () => {
    const user = userEvent.setup();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    render(<App />);
    await openPdf();
    await user.click(screen.getByTestId("ai-translate"));

    const select = await screen.findByTestId("translate-profile");
    await user.selectOptions(select, "prof_remote");
    await user.click(screen.getByTestId("translate-submit"));
    await waitFor(() => expect(taskEvents()).toBeDefined());

    // Requests carry a profile id and nothing resembling a credential.
    for (const call of calls) {
      const body = call.init.body;
      const serialised =
        typeof body === "string" ? body : body instanceof FormData ? "" : "";
      expect(serialised).not.toMatch(/sk-[A-Za-z0-9]/);
      const headers = (call.init.headers ?? {}) as Record<string, string>;
      expect(headers["Authorization"]).toBeUndefined();
    }

    // Nor is one rendered. The masked form may appear; the real key may not.
    expect(document.body.textContent).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});


// --- DS-CTX-004: translation modes -------------------------------------------


describe("DS-CTX-004 · translation mode selection", () => {
  it("offers the three modes and defaults to Basic", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openPdf();
    await user.click(screen.getByTestId("ai-translate"));
    await screen.findByTestId("translate-profile");

    expect(screen.getByTestId("translate-mode-basic")).toBeChecked();
    expect(screen.getByTestId("translate-mode-academic")).not.toBeChecked();
    expect(screen.getByTestId("translate-mode-contextual")).not.toBeChecked();
  });

  it("sends the chosen mode, mapping the UI's name to the API's", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openPdf();
    await user.click(screen.getByTestId("ai-translate"));
    await screen.findByTestId("translate-profile");

    // "学术" maps to the API's `academic`.
    await user.click(screen.getByTestId("translate-mode-academic"));
    await user.click(screen.getByTestId("translate-submit"));

    await waitFor(() =>
      expect(useWorkspaceStore.getState().translation?.taskId).toBe("task_1"),
    );
    const start = calls.find((call) => call.url.endsWith("/translate"));
    expect(JSON.parse(String(start!.init.body)).context_mode).toBe("academic");
  });

  it("discloses the cost of the contextual mode rather than calling it better", async () => {
    const user = userEvent.setup();
    render(<App />);
    await openPdf();
    await user.click(screen.getByTestId("ai-translate"));
    await screen.findByTestId("translate-profile");

    const contextual = screen.getByTestId("translate-mode-contextual");
    const label = contextual.closest("label")!;

    // The measured cost, stated where the user chooses — a several-minute wait
    // that is not disclosed reads as a hang.
    expect(label).toHaveTextContent(/分析全文/);
    expect(label).toHaveTextContent(/6\.6/);
    expect(label).toHaveTextContent("实验性");
  });
});
