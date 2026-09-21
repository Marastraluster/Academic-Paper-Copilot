/**
 * DS-DOC-004 — the reading session, across a reload.
 *
 * A reload is modelled the way the browser performs one: the module state that
 * holds the open document is thrown away, nothing is carried over except what
 * the page wrote down, and the application starts again. That is why every test
 * here begins by *seeding* the record and mounting, rather than by opening a
 * document and then pretending.
 *
 * PDF.js is mocked for the same reason the viewer suite mocks it: real PDF
 * parsing in jsdom proves nothing, and the page stack it renders is what the
 * restore path waits for.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AnnotationView } from "@/api/annotations";
import type { DocumentSummary } from "@/api/documents";
import type { OverviewView } from "@/api/overview";
import { App } from "@/app/App";
import { ACTIVE_SESSION_STORAGE_KEY } from "@/session/types";
import {
  selectActiveSelection,
  selectActiveTurns,
  useWorkspaceStore,
} from "@/stores/workspace";
import { seedQaSections } from "@/tests/fixtures";

const getDocument = vi.fn();

vi.mock("@/pdf/pdfjs", () => {
  const STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0];
  const module = {
    getDocument: (...args: unknown[]) => getDocument(...args),
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
    ZOOM_STEPS: STEPS,
    MIN_ZOOM: STEPS[0],
    MAX_ZOOM: STEPS[STEPS.length - 1],
    FIT_WIDTH_PADDING_PX: 32,
    RENDER_BUFFER_MARGIN_PX: 300,
    clampZoom: (s: number) => Math.min(3, Math.max(0.5, s)),
    zoomIn: (s: number) => STEPS.find((x) => x > s + 1e-6) ?? 3,
    zoomOut: (s: number) => [...STEPS].reverse().find((x) => x < s - 1e-6) ?? 0.5,
  };
});

const DOCUMENT_ID = "doc_restored";
const HASH = "1e0651b6810ecba34a3dbc5b5b0209226f889004607c1f203540a48d64e5a93a";

/** A real PDF header: the restore checks the bytes, not the name. */
function pdfBytes(): Uint8Array {
  return new TextEncoder().encode("%PDF-1.4\nrest of it");
}

function pdfResponse(): Response {
  return new Response(pdfBytes(), {
    status: 200,
    headers: { "Content-Type": "application/pdf" },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function summary(over: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    document_id: DOCUMENT_ID,
    name: "resnet.pdf",
    page_count: 12,
    source: "upload",
    has_translation: false,
    created_at: "2026-09-20T00:00:00+00:00",
    ...over,
  };
}

const overviewBody = (): OverviewView => ({
  status: "READY",
  cached: true,
  content_hash: HASH,
  target_language: "zh-CN",
  provider_model: "deepseek-flash",
  created_at: "2026-09-20T00:00:00+00:00",
  input_tokens: 10,
  output_tokens: 5,
  source_sections: ["Abstract"],
  notes: [],
  items: [
    {
      category: "core_idea", text: "残差学习。", inferred: false, partial: false,
      evidence: [{ paragraph_id: "p_1", page_number: 1 }],
    },
  ],
  key_terms: [],
});

function aNote(): AnnotationView {
  return {
    id: "ann_1", kind: "note", color: "#fff", quote: "a sentence", comment: "mine",
    created_at: "2026-09-20T00:00:00+00:00", updated_at: "2026-09-20T00:00:00+00:00",
    targets: [],
  };
}

interface BackendOptions {
  summary?: DocumentSummary | "404";
  file?: "ok" | "404" | "offline";
  translated?: "ok" | "404" | "garbage";
  annotations?: AnnotationView[];
  overview?: OverviewView | null;
  /** Held open until released, for the preemption test. */
  holdFile?: boolean;
}

/** Answer the requests a restore makes, and record them. */
function backend(options: BackendOptions = {}) {
  const calls: string[] = [];
  let releaseFile: (() => void) | null = null;

  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);

    if (path.includes("/file")) {
      if (options.file === "offline") throw new TypeError("Failed to fetch");
      if (options.file === "404") return new Response("", { status: 404 });
      if (options.holdFile) {
        await new Promise<void>((resolve) => { releaseFile = resolve; });
      }
      return pdfResponse();
    }
    if (path.includes("/translated")) {
      if (options.translated === "404") return new Response("", { status: 404 });
      if (options.translated === "garbage") {
        return new Response(new TextEncoder().encode("not a pdf at all"), { status: 200 });
      }
      return pdfResponse();
    }
    if (path.includes("/overview")) {
      return options.overview ? jsonResponse(options.overview) : new Response("", { status: 404 });
    }
    if (path.includes("/annotations")) {
      return jsonResponse({
        document_id: DOCUMENT_ID, content_hash: HASH,
        annotations: options.annotations ?? [],
      });
    }
    if (path.includes("/sections")) return jsonResponse([]);
    if (path.includes("/ir")) {
      return jsonResponse({
        document_id: DOCUMENT_ID, content_hash: HASH, page_count: 12, pipeline_version: "5",
        metadata: { title: "Deep Residual Learning" },
        pages: [], paragraphs: [], page_mapping: {},
      });
    }
    if (path.includes("/profiles")) return jsonResponse([]);
    if (/\/api\/documents$/.test(path) && method === "POST") {
      return jsonResponse(summary({ document_id: "doc_uploaded", name: "other.pdf" }));
    }
    if (/\/api\/documents\/[^/]+$/.test(path)) {
      if (options.summary === "404") return new Response("", { status: 404 });
      return jsonResponse(options.summary ?? summary());
    }
    return new Response("", { status: 404 });
  }));

  return {
    calls,
    get releaseFile() {
      return () => releaseFile?.();
    },
    fileHeld: () => releaseFile !== null,
  };
}

function seedSession(over: Record<string, unknown> = {}): void {
  window.localStorage.setItem(
    ACTIVE_SESSION_STORAGE_KEY,
    JSON.stringify({
      schemaVersion: 1,
      documentId: DOCUMENT_ID,
      name: "resnet.pdf",
      activePage: 1,
      readerMode: "original",
      outlinePanel: "overview",
      lastActiveAt: "2026-09-20T00:00:00+00:00",
      ...over,
    }),
  );
}

function stored(): Record<string, unknown> | null {
  const raw = window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

beforeEach(() => {
  window.localStorage.clear();
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  getDocument.mockReset();
  getDocument.mockReturnValue({
    promise: Promise.resolve({
      numPages: 12,
      getPage: vi.fn(async () => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: 600 * scale, height: 800 * scale, rotation: 0,
        }),
        render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
        streamTextContent: () => ({}),
      })),
    }),
    destroy: vi.fn(async () => undefined),
  });
  seedQaSections();
  useWorkspaceStore.setState({
    document: null, translation: null, readerMode: "original",
    outlinePanel: "overview", activePage: 1, notice: null,
    annotations: null, overview: null, overviewStatus: "idle",
    engine: { state: "offline", label: "未连接" },
  });
});

describe("DS-DOC-004 · restoring on mount", () => {
  it("reopens the paper the reader was in, without being asked (AC-P0-02)", async () => {
    seedSession({ activePage: 3 });
    backend();
    render(<App />);

    await waitFor(() =>
      expect(useWorkspaceStore.getState().document?.registration).toBe("ready"),
    );
    expect(useWorkspaceStore.getState().document?.documentId).toBe(DOCUMENT_ID);
    expect(useWorkspaceStore.getState().engine.label).toBe("本地服务");
  });

  it("hydrates the reader with the backend's copy of the bytes (AC-P0-03)", async () => {
    seedSession();
    const server = backend();
    render(<App />);

    await waitFor(() =>
      expect(useWorkspaceStore.getState().document?.registration).toBe("ready"),
    );
    const file = useWorkspaceStore.getState().document?.file;
    expect(file).toBeInstanceOf(File);
    expect(file?.name).toBe("resnet.pdf");
    expect(server.calls.filter((call) => call.includes("/file"))).toHaveLength(1);
    await screen.findByTestId("viewer-original");
  });

  it("adopts the existing row instead of minting a new one (AC-P0-19)", async () => {
    seedSession();
    const server = backend();
    render(<App />);

    await waitFor(() =>
      expect(useWorkspaceStore.getState().document?.registration).toBe("ready"),
    );
    // No upload: a new row would have no translation under it, and the reader
    // would be told their paper was never translated.
    expect(server.calls.filter((call) => call.startsWith("POST"))).toEqual([]);
    expect(useWorkspaceStore.getState().document?.documentId).toBe(DOCUMENT_ID);
  });

  it("does nothing at all when there is no stored session (AC-P0-02)", async () => {
    const server = backend();
    render(<App />);

    await waitFor(() => expect(useWorkspaceStore.getState().document).toBeNull());
    expect(server.calls.filter((call) => call.includes("/documents/"))).toEqual([]);
  });

  it("puts the reader back on the page they were on (AC-P0-14)", async () => {
    seedSession({ activePage: 5 });
    backend();
    render(<App />);

    await waitFor(() =>
      expect(useWorkspaceStore.getState().document?.registration).toBe("ready"),
    );
    await waitFor(() => expect(useWorkspaceStore.getState().activePage).toBe(5));
  });

  it("puts them back on the panel they were on (AC-P0-15)", async () => {
    seedSession({ outlinePanel: "notes" });
    backend();
    render(<App />);

    await waitFor(() =>
      expect(useWorkspaceStore.getState().outlinePanel).toBe("notes"),
    );
    await screen.findByTestId("assistant-tabpanel-notes");
  });

  it("brings the notes back (AC-P0-07)", async () => {
    seedSession();
    backend({ annotations: [aNote()] });
    render(<App />);

    await waitFor(() =>
      expect(useWorkspaceStore.getState().annotations).toHaveLength(1),
    );
    expect(useWorkspaceStore.getState().annotations?.[0].comment).toBe("mine");
  });

  it("brings the cached overview back, for free (AC-P0-08)", async () => {
    seedSession();
    backend({ overview: overviewBody() });
    render(<App />);

    await waitFor(() => expect(useWorkspaceStore.getState().overviewStatus).toBe("ready"));
    expect(useWorkspaceStore.getState().overview?.content_hash).toBe(HASH);
  });
});

describe("DS-DOC-004 · the translation", () => {
  it("reopens the translated artifact instead of translating again (AC-P0-04)", async () => {
    seedSession({ readerMode: "bilingual" });
    const server = backend({ summary: summary({ has_translation: true }), translated: "ok" });
    render(<App />);

    await waitFor(() =>
      expect(useWorkspaceStore.getState().translation?.status).toBe("success"),
    );
    expect(useWorkspaceStore.getState().translation?.monoUrl).toContain("blob:");
    // The expensive one: a re-translation would be a new task and a new bill.
    // (`/translated` contains `/translate`, hence the anchored match.)
    expect(server.calls.filter((call) => /\/translate(\s|$)/.test(call))).toEqual([]);
    expect(server.calls.filter((call) => call.includes("/translated"))).toHaveLength(1);
  });

  it("comes back into the mode the reader left (AC-P0-05)", async () => {
    seedSession({ readerMode: "bilingual" });
    backend({ summary: summary({ has_translation: true }), translated: "ok" });
    render(<App />);

    await waitFor(() =>
      expect(useWorkspaceStore.getState().document?.registration).toBe("ready"),
    );
    await waitFor(() => expect(useWorkspaceStore.getState().readerMode).toBe("bilingual"));
    await screen.findByTestId("viewer-original");
    await screen.findByTestId("viewer-translated");
  });

  it("does not ask for a translation when there is none (AC-P0-04)", async () => {
    seedSession({ readerMode: "bilingual" });
    const server = backend({ summary: summary({ has_translation: false }) });
    render(<App />);

    await waitFor(() =>
      expect(useWorkspaceStore.getState().document?.registration).toBe("ready"),
    );
    expect(server.calls.filter((call) => call.includes("/translated"))).toEqual([]);
    expect(useWorkspaceStore.getState().readerMode).toBe("original");
  });

  it("falls back to the original when the stored translation is unusable (AC-P0-13)", async () => {
    seedSession({ readerMode: "bilingual" });
    backend({ summary: summary({ has_translation: true }), translated: "garbage" });
    render(<App />);

    await waitFor(() =>
      expect(useWorkspaceStore.getState().document?.registration).toBe("ready"),
    );
    expect(useWorkspaceStore.getState().readerMode).toBe("original");
    expect(useWorkspaceStore.getState().translation).toBeNull();
    await screen.findByTestId("viewer-original");
    await waitFor(() => expect(screen.getByTestId("qa-jump-notice")).toBeInTheDocument());
    expect(screen.getByTestId("qa-jump-notice")).toHaveTextContent("译文无法加载");
  });

  it("revokes the restored object URL when the paper is closed (AC-P0-16)", async () => {
    seedSession();
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    backend({ summary: summary({ has_translation: true }), translated: "ok" });
    render(<App />);

    await waitFor(() =>
      expect(useWorkspaceStore.getState().translation?.status).toBe("success"),
    );
    const url = useWorkspaceStore.getState().translation?.monoUrl ?? "";

    const { closeDocument } = await import("@/translation/session");
    closeDocument();

    expect(revoke).toHaveBeenCalledWith(url);
    expect(useWorkspaceStore.getState().translation).toBeNull();
    revoke.mockRestore();
  });
});

describe("DS-DOC-004 · when it cannot be done", () => {
  it("a paper whose bytes are gone resets to an empty workspace, and says so (AC-P0-11)", async () => {
    seedSession();
    backend({ file: "404" });
    render(<App />);

    await waitFor(() => expect(stored()).toBeNull());
    expect(useWorkspaceStore.getState().document).toBeNull();
    await screen.findByTestId("qa-jump-notice");
    expect(screen.getByTestId("qa-jump-notice")).toHaveTextContent("源文件已不可用");
    await screen.findByTestId("pdf-empty-state");
  });

  it("a deleted row resets to an empty workspace, and says so (AC-P0-11)", async () => {
    seedSession();
    backend({ summary: "404" });
    render(<App />);

    await waitFor(() => expect(stored()).toBeNull());
    expect(useWorkspaceStore.getState().document).toBeNull();
    await screen.findByTestId("pdf-empty-state");
  });

  it("an unreachable backend keeps the session and waits (AC-P0-12)", async () => {
    seedSession();
    backend({ file: "offline" });
    render(<App />);

    await waitFor(() => expect(useWorkspaceStore.getState().engine.state).toBe("offline"));
    // Kept: when the local service is up again, the next reload restores it.
    expect(stored()).not.toBeNull();
    expect(useWorkspaceStore.getState().document).toBeNull();
    await screen.findByTestId("pdf-empty-state");
  });

  it("keeps an empty workspace after the reader closed the paper (AC-P0-10)", async () => {
    seedSession();
    backend();
    const { closeDocument } = await import("@/translation/session");
    closeDocument();
    expect(stored()).toBeNull();

    render(<App />);
    await waitFor(() => expect(useWorkspaceStore.getState().document).toBeNull());
    await screen.findByTestId("pdf-empty-state");
  });
});

describe("DS-DOC-004 · a gesture wins", () => {
  it("abandons a restore the reader has overtaken (AC-P0-09)", async () => {
    seedSession();
    const server = backend({ holdFile: true });
    render(<App />);
    await waitFor(() => expect(server.fileHeld()).toBe(true));

    const { openDocument } = await import("@/translation/session");
    openDocument(new File([pdfBytes()], "mychoice.pdf", { type: "application/pdf" }));
    server.releaseFile();

    await waitFor(() =>
      expect(useWorkspaceStore.getState().document?.registration).toBe("ready"),
    );
    // The upload's row, not the one that was guessed on their behalf.
    expect(useWorkspaceStore.getState().document?.documentId).toBe("doc_uploaded");
  });
});

describe("DS-DOC-004 · what is written down", () => {
  it("stores the session the moment a document becomes usable (AC-P0-01)", async () => {
    // Mounted first, because the write belongs to the running application: a
    // module that is not mounted is not watching anything.
    backend();
    render(<App />);
    await screen.findByTestId("pdf-empty-state");
    expect(stored()).toBeNull();

    const { openDocument } = await import("@/translation/session");
    openDocument(new File([pdfBytes()], "paper.pdf", { type: "application/pdf" }));

    await waitFor(() => expect(stored()).not.toBeNull());
    expect(stored()).toMatchObject({
      schemaVersion: 1,
      documentId: "doc_uploaded",
      name: "other.pdf",
      readerMode: "original",
      outlinePanel: "overview",
    });
  });

  it("debounces the page while the reader scrolls (AC-P1-04)", async () => {
    seedSession({ activePage: 1 });
    backend();
    render(<App />);
    await waitFor(() =>
      expect(useWorkspaceStore.getState().document?.registration).toBe("ready"),
    );

    for (let page = 2; page <= 6; page += 1) {
      useWorkspaceStore.setState({ activePage: page });
    }
    // Ten page changes in a scroll are one write, and until it happens the
    // stored page is the one the reader actually stopped on last time.
    expect(stored()?.activePage).toBe(1);

    await waitFor(() => expect(stored()?.activePage).toBe(6));
  });

  it("ignores a record from a schema it does not know (AC-P1-02)", async () => {
    seedSession({ schemaVersion: 999 });
    backend();
    render(<App />);

    await screen.findByTestId("pdf-empty-state");
    expect(useWorkspaceStore.getState().document).toBeNull();
  });

  it("survives a record that was truncated mid-write (AC-P1-03)", async () => {
    window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, '{"documentId":');
    backend();
    render(<App />);

    await screen.findByTestId("pdf-empty-state");
    expect(useWorkspaceStore.getState().document).toBeNull();
    expect(stored()).toBeNull();
  });
});

describe("DS-DOC-004 · the shell", () => {
  it("does not bring back a conversation, a selection or a scroll offset (Decision G)", async () => {
    seedSession();
    useWorkspaceStore.setState({
      turns: [
        {
          id: "turn_1", documentId: DOCUMENT_ID, sessionToken: "old",
          question: "什么是退化问题？", scopeType: "whole_paper", scopeLabel: "当前论文",
          profileId: "prof_1", result: { status: "answered" } as never,
        },
      ],
      selection: { documentId: DOCUMENT_ID, sessionToken: "old" } as never,
    });
    backend();
    render(<App />);

    await waitFor(() =>
      expect(useWorkspaceStore.getState().document?.registration).toBe("ready"),
    );
    // A question asked in the session that ended belongs to that session: the
    // restored one has a new token, so the old turn is unreachable rather than
    // merely cleared — the same guarantee the translation has.
    expect(selectActiveTurns(useWorkspaceStore.getState())).toEqual([]);
    expect(selectActiveSelection(useWorkspaceStore.getState())).toBeNull();
  });

  it("offers a developer the session, and a way to forget it (AC-P2-01)", async () => {
    seedSession({ activePage: 4 });
    backend();
    render(<App />);
    await waitFor(() =>
      expect(useWorkspaceStore.getState().document?.registration).toBe("ready"),
    );

    const handle = (window as unknown as { __COPILOT_SESSION__?: {
      getActiveSession: () => { documentId?: string } | null;
      clearSession: () => void;
    } }).__COPILOT_SESSION__;
    expect(handle).toBeDefined();
    expect(handle?.getActiveSession()?.documentId).toBe(DOCUMENT_ID);

    handle?.clearSession();
    expect(stored()).toBeNull();
  });

  it("does not touch the settings button or the URL (AC-P0-18)", async () => {
    const before = window.location.href;
    seedSession();
    backend();
    render(<App />);

    await waitFor(() =>
      expect(useWorkspaceStore.getState().document?.registration).toBe("ready"),
    );
    expect(window.location.href).toBe(before);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("设置"));
    // No settings dialog exists, and this task is not the one that adds it.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(window.location.href).toBe(before);
  });
});
