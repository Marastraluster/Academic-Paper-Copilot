/**
 * DS-DOC-005 — the library: switching papers, and what each row is allowed to claim.
 *
 * **Why two tests fire events instead of using `userEvent`.** Clicking 打开 or
 * the delete confirm runs a handler that *closes the dialog it was clicked in*,
 * and it closes it after an await rather than synchronously. `userEvent` walks a
 * full pointer sequence with a macrotask between each step; a dialog that
 * unmounts underneath that sequence leaves it retrying, and the call takes ~40 s
 * to settle (measured — the same interaction through `fireEvent` returns in
 * 4 ms and the product converges in 33 ms). `fireEvent` sends the click without
 * the choreography, which is the right instrument for this particular shape. The
 * real browser harness covers the pointer path.
 *
 * Two rules run through these tests. **A row reports only what was recorded** —
 * the artifact on disk and the last successful run — never a model, a token count
 * or a latency nobody measured. And **switching papers is not re-opening one**:
 * the row is adopted, so the paper keeps its notes, its cached overview and its
 * translation, and no second registration is minted.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DocumentSummary } from "@/api/documents";
import { App } from "@/app/App";
import { ACTIVE_SESSION_STORAGE_KEY } from "@/session/types";
import { useWorkspaceStore } from "@/stores/workspace";
import { seedQaSections } from "@/tests/fixtures";

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

function pdfBytes(): Uint8Array {
  return new TextEncoder().encode("%PDF-1.4\nrest of it");
}

function row(over: Partial<DocumentSummary> = {}): DocumentSummary {
  return {
    document_id: "doc_a",
    name: "resnet.pdf",
    page_count: 12,
    source: "upload",
    has_translation: false,
    created_at: "2026-09-20T10:30:00+00:00",
    translation_record: null,
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

function pdfResponse(): Response {
  return new Response(pdfBytes(), {
    status: 200, headers: { "Content-Type": "application/pdf" },
  });
}

/** The library surface, plus everything opening a row reads. */
function backend(options: {
  documents?: DocumentSummary[];
  translated?: boolean;
  missingFile?: boolean;
} = {}) {
  const calls: { method: string; path: string }[] = [];
  let documents = options.documents ?? [row()];

  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    const method = init?.method ?? "GET";
    calls.push({ method, path });

    if (path.endsWith("/documents") && method === "GET") return json(documents);
    if (path.endsWith("/documents") && method === "POST") {
      return json(row({ document_id: "doc_new" }), 201);
    }
    if (/\/documents\/[^/]+$/.test(path) && method === "DELETE") {
      documents = documents.filter((item) => !path.endsWith(item.document_id));
      return new Response(null, { status: 204 });
    }
    if (path.includes("/translated")) {
      return options.translated ? pdfResponse() : new Response("", { status: 404 });
    }
    if (path.includes("/file")) {
      return options.missingFile ? new Response("", { status: 404 }) : pdfResponse();
    }
    if (path.includes("/annotations")) {
      return json({ document_id: "doc_a", content_hash: "h", annotations: [] });
    }
    if (path.includes("/overview")) return new Response("", { status: 404 });
    if (path.includes("/sections")) return json([]);
    if (path.includes("/ir")) {
      return json({
        document_id: "doc_a", content_hash: "h", page_count: 12, pipeline_version: "5",
        metadata: { title: "A paper" }, pages: [], paragraphs: [], page_mapping: {},
      });
    }
    if (path.includes("/profiles")) return json([]);
    if (/\/documents\/[^/]+$/.test(path)) {
      const id = path.split("/").pop()!;
      const found = documents.find((item) => item.document_id === id);
      return found ? json(found) : new Response("", { status: 404 });
    }
    return new Response("", { status: 404 });
  }));

  return { calls, writes: () => calls.filter((call) => call.method !== "GET") };
}

async function openLibrary(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("library-open"));
  const dialog = await screen.findByTestId("library-dialog");
  // The list is a read: the dialog mounts first and the rows arrive after it.
  await waitFor(() => {
    expect(
      within(dialog).queryByTestId("library-list") ??
        within(dialog).queryByTestId("library-empty"),
    ).not.toBeNull();
  });
  return dialog;
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
        getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale, rotation: 0 }),
        render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
        streamTextContent: () => ({}),
      })),
    }),
    destroy: vi.fn(async () => undefined),
  });
  seedQaSections();
  useWorkspaceStore.setState({
    document: null, translation: null, readerMode: "original",
    outlinePanel: "overview", activePage: 1,
    libraryOpen: false, libraryQuery: "",
  });
});

describe("DS-DOC-005 · the doors", () => {
  it("opens from the top bar (AC-P0-05)", async () => {
    const before = window.location.href;
    backend();
    render(<App />);
    const user = userEvent.setup();
    const dialog = await openLibrary(user);
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByTestId("library-list")).toBeInTheDocument();
    // Which paper is open is application state, never a URL (AC-P0-19).
    expect(window.location.href).toBe(before);
    expect(window.location.hash).toBe("");
  });

  it("opens from the empty workspace, where a reader with no paper is (AC-P0-06)", async () => {
    backend();
    render(<App />);
    const user = userEvent.setup();
    await screen.findByTestId("pdf-empty-state");

    await user.click(screen.getByTestId("open-from-library"));
    expect(await screen.findByTestId("library-dialog")).toBeInTheDocument();
  });

  it("opens from the top bar's search field, carrying what was typed (AC-P0-20)", async () => {
    /* The field said 搜索论文… for four tasks and did nothing. A reader who wants
       a different paper reaches for the control that says it searches papers. */
    backend({
      documents: [
        row({ document_id: "doc_a", name: "resnet.pdf" }),
        row({ document_id: "doc_b", name: "mamba.pdf" }),
      ],
    });
    render(<App />);
    const user = userEvent.setup();

    await user.type(screen.getByTestId("paper-search"), "mamba");
    const dialog = await screen.findByTestId("library-dialog");

    expect(within(dialog).getByTestId("library-search-input")).toHaveValue("mamba");
    expect(within(dialog).getByTestId("library-row-doc_b")).toBeInTheDocument();
    expect(within(dialog).queryByTestId("library-row-doc_a")).toBeNull();
  });

  it("says so when nothing has been opened (AC-P0-04)", async () => {
    backend({ documents: [] });
    render(<App />);
    const user = userEvent.setup();
    const dialog = await openLibrary(user);
    expect(within(dialog).getByTestId("library-empty")).toBeInTheDocument();
  });
});

describe("DS-DOC-005 · what a row shows", () => {
  it("names the paper, its size, where it came from and when (AC-P0-07)", async () => {
    backend({ documents: [row({ name: "resnet.pdf", page_count: 12, source: "path" })] });
    render(<App />);
    const user = userEvent.setup();
    const dialog = await openLibrary(user);

    const line = within(dialog).getByTestId("library-row-doc_a");
    expect(line).toHaveTextContent("resnet.pdf");
    expect(line).toHaveTextContent("12 页");
    expect(line).toHaveTextContent("本地路径");
    expect(within(line).getByTestId("library-source-path")).toHaveAttribute(
      "title", expect.stringContaining("不会删除本地源文件"),
    );
    expect(line).toHaveTextContent("2026-09-20");
  });

  it("reports the translation that was recorded, and nothing more (AC-P0-09)", async () => {
    backend({
      documents: [row({
        has_translation: true,
        translation_record: {
          lang_in: "en", lang_out: "zh", engine: "fast",
          translated_at: "2026-09-20T11:00:00+00:00", profile_id: "prof_1",
        },
      })],
    });
    render(<App />);
    const user = userEvent.setup();
    const dialog = await openLibrary(user);

    const line = within(dialog).getByTestId("library-row-doc_a");
    expect(within(line).getByTestId("library-translated")).toHaveTextContent("已翻译");
    expect(within(line).getByTestId("library-record")).toHaveTextContent("en → zh · fast");
    // No model, no tokens, no latency: none of them was recorded.
    expect(line).not.toHaveTextContent("token");
    expect(line).not.toHaveTextContent("ms");
  });

  it("marks the paper already on screen and will not open it again (AC-P0-08)", async () => {
    backend();
    useWorkspaceStore.setState({
      document: {
        sessionToken: "s", name: "resnet.pdf",
        file: new File([pdfBytes()], "resnet.pdf"), documentId: "doc_a",
        registration: "ready", registrationError: null, backendPageCount: 12,
      },
    });
    render(<App />);
    const user = userEvent.setup();
    const dialog = await openLibrary(user);

    const line = within(dialog).getByTestId("library-row-doc_a");
    expect(line).toHaveAttribute("data-current", "true");
    expect(within(line).getByTestId("library-current")).toHaveTextContent("正在阅读");
    expect(within(line).getByTestId("library-open-doc_a")).toBeDisabled();
  });
});

describe("DS-DOC-005 · switching papers", () => {
  it("adopts the row instead of registering a new one (AC-P0-10, AC-P0-11)", async () => {
    const server = backend({ documents: [row({ document_id: "doc_b", name: "mamba.pdf" })] });
    render(<App />);
    const user = userEvent.setup();
    const dialog = await openLibrary(user);

    fireEvent.click(within(dialog).getByTestId("library-open-doc_b"));

    await waitFor(() =>
      expect(useWorkspaceStore.getState().document?.documentId).toBe("doc_b"),
    );
    expect(useWorkspaceStore.getState().document?.registration).toBe("ready");
    // The whole point: no upload, so the paper keeps the identity its notes and
    // its cached overview and its translation are stored under.
    expect(server.writes()).toEqual([]);
    expect(server.calls.filter((call) => call.path.includes("/file"))).toHaveLength(1);
    await waitFor(() => expect(screen.queryByTestId("library-dialog")).toBeNull());
  });

  it("brings the translation back and the reader back to the first page (AC-P0-10)", async () => {
    backend({
      documents: [row({ document_id: "doc_b", has_translation: true })],
      translated: true,
    });
    render(<App />);
    const user = userEvent.setup();
    const dialog = await openLibrary(user);

    fireEvent.click(within(dialog).getByTestId("library-open-doc_b"));

    await waitFor(() => expect(useWorkspaceStore.getState().translation?.status).toBe("success"));
    expect(useWorkspaceStore.getState().translation?.monoUrl).toContain("blob:");
    expect(useWorkspaceStore.getState().activePage).toBe(1);
  });

  it("records the switch in the reading session, so a reload comes back here (AC-P0-13)", async () => {
    backend({ documents: [row({ document_id: "doc_b", name: "mamba.pdf" })] });
    render(<App />);
    const user = userEvent.setup();
    const dialog = await openLibrary(user);

    fireEvent.click(within(dialog).getByTestId("library-open-doc_b"));

    await waitFor(() => expect(stored()?.documentId).toBe("doc_b"));
    expect(stored()?.name).toBe("mamba.pdf");
  });

  it("revokes the paper it is leaving behind (AC-P0-14)", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    backend({ documents: [row({ document_id: "doc_b", has_translation: true })], translated: true });
    render(<App />);
    const user = userEvent.setup();

    // Take up doc_a first, so there is a translated artifact to let go of.
    useWorkspaceStore.setState({
      document: {
        sessionToken: "s", name: "a.pdf", file: new File([pdfBytes()], "a.pdf"),
        documentId: "doc_a", registration: "ready", registrationError: null, backendPageCount: 12,
      },
      translation: {
        documentId: "doc_a", sessionToken: "s", taskId: null, status: "success",
        progress: null, error: null, monoUrl: "blob:previous", monoPageCount: 12, degraded: false,
      },
    });

    const dialog = await openLibrary(user);
    fireEvent.click(within(dialog).getByTestId("library-open-doc_b"));

    await waitFor(() => expect(revoke).toHaveBeenCalledWith("blob:previous"));
    revoke.mockRestore();
  });

  it("does not replace the reader's paper with one whose bytes are gone (AC-P0-12)", async () => {
    backend({ documents: [row({ document_id: "doc_b", name: "gone.pdf" })], missingFile: true });
    render(<App />);
    const user = userEvent.setup();
    useWorkspaceStore.setState({
      document: {
        sessionToken: "s", name: "a.pdf", file: new File([pdfBytes()], "a.pdf"),
        documentId: "doc_a", registration: "ready", registrationError: null, backendPageCount: 12,
      },
    });

    const dialog = await openLibrary(user);
    fireEvent.click(within(dialog).getByTestId("library-open-doc_b"));

    await waitFor(() =>
      expect(screen.getByTestId("qa-jump-notice")).toHaveTextContent("源文件已不可用"),
    );
    // The paper on screen is still the one that works.
    expect(useWorkspaceStore.getState().document?.documentId).toBe("doc_a");
  });
});

describe("DS-DOC-005 · deleting from the library", () => {
  it("asks first, says what survives, then removes it (AC-P0-15, AC-P0-16)", async () => {
    const server = backend({ documents: [row({ document_id: "doc_b", name: "mamba.pdf" })] });
    render(<App />);
    const user = userEvent.setup();
    const dialog = await openLibrary(user);

    fireEvent.click(within(dialog).getByTestId("library-delete-doc_b"));
    const confirm = within(dialog).getByTestId("library-confirm-doc_b");
    expect(confirm).toHaveTextContent("笔记与概览缓存会保留");

    fireEvent.click(within(dialog).getByTestId("library-delete-confirm-doc_b"));

    await waitFor(() =>
      expect(server.calls.some((call) => call.method === "DELETE")).toBe(true),
    );
    await waitFor(() => expect(screen.getByTestId("library-empty")).toBeInTheDocument());
  });

  it("empties the workspace when the paper on screen is the one deleted (AC-P0-17)", async () => {
    backend({ documents: [row({ document_id: "doc_b", name: "mamba.pdf" })] });
    render(<App />);
    const user = userEvent.setup();
    useWorkspaceStore.setState({
      document: {
        sessionToken: "s", name: "mamba.pdf", file: new File([pdfBytes()], "mamba.pdf"),
        documentId: "doc_b", registration: "ready", registrationError: null, backendPageCount: 12,
      },
    });
    const dialog = await openLibrary(user);

    fireEvent.click(within(dialog).getByTestId("library-delete-doc_b"));
    fireEvent.click(within(dialog).getByTestId("library-delete-confirm-doc_b"));

    await waitFor(() => expect(useWorkspaceStore.getState().document).toBeNull());
    expect(stored()).toBeNull();
  });
});
