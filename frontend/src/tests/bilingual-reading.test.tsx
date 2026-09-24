/**
 * DS-DOC-006 — the paragraph-aligned column.
 *
 * Three rules run through these tests. **Nothing is spent without a button**: the
 * column reads, and the only request that can reach a provider is the one behind
 * 生成逐段对照. **A gap is said out loud**: a paragraph with no translation is
 * marked, never filled in. And **the chrome stays out of the prose**: a selection
 * dragged across a pair copies the two texts and nothing else.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BilingualView } from "@/api/bilingual";
import { App } from "@/app/App";
import { useWorkspaceStore } from "@/stores/workspace";
import { seedDocument, seedQaSections } from "@/tests/fixtures";

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

const HASH = "hash_current";

function seedIr() {
  const document = seedDocument();
  useWorkspaceStore.setState({
    ir: {
      document_id: document.documentId ?? "doc_test",
      content_hash: HASH,
      page_count: 2,
      pipeline_version: "5",
      metadata: { title: "A Paper" },
      pages: [
        {
          page_number: 1, width_pt: 612, height_pt: 792, rotation: 0,
          blocks: [
            { id: "b1", page_number: 1, layout_class: "plain text", bbox: [0, 0, 1, 1], text: "" },
            { id: "b2", page_number: 1, layout_class: "isolate_formula", bbox: [0, 0, 1, 1], text: "" },
            { id: "b3", page_number: 1, layout_class: "plain text", bbox: [0, 0, 1, 1], text: "" },
          ],
        },
        { page_number: 2, width_pt: 612, height_pt: 792, rotation: 0, blocks: [] },
      ],
      paragraphs: [
        {
          id: "p_1", source_anchor_id: "a1", section_id: "sec_a",
          text: "Deeper neural networks are more difficult to train.",
          page_number: 1, page_range: [1, 1], block_ids: ["b1"],
          bboxes: [[50, 100, 545, 140]], is_abstract: true,
        },
        {
          id: "p_2", source_anchor_id: "a2", section_id: "sec_a",
          text: "We present a residual learning framework.",
          page_number: 1, page_range: [1, 1], block_ids: ["b3"],
          bboxes: [[50, 200, 545, 240]],
        },
      ],
    } as never,
  });
  return document;
}

function reading(over: Partial<BilingualView> = {}): BilingualView {
  return {
    status: "READY",
    cached: true,
    content_hash: HASH,
    target_language: "zh-CN",
    provider_model: "deepseek-flash",
    created_at: "2026-09-23T00:00:00+00:00",
    input_tokens: 1200,
    output_tokens: 340,
    notes: [],
    total_paragraphs: 2,
    translated_paragraphs: 2,
    sections: [
      {
        section_id: "sec_a", title: "Abstract", title_translated: "摘要",
        level: 1, page_number: 1, is_references: false,
      },
    ],
    paragraphs: [
      {
        paragraph_id: "p_1", page_number: 1, section_id: "sec_a",
        source_text: "Deeper neural networks are more difficult to train.",
        translated_text: "更深的神经网络更难训练。",
        status: "translated", note: "", bboxes: [[50, 100, 545, 140]],
      },
      {
        paragraph_id: "p_2", page_number: 1, section_id: "sec_a",
        source_text: "We present a residual learning framework.",
        translated_text: "",
        status: "untranslated", note: "本段未能翻译", bboxes: [[50, 200, 545, 240]],
      },
    ],
    blocks: [
      {
        block_id: "b2", page_number: 1, layout_class: "isolate_formula",
        text: "y = F(x, {Wi}) + x", bbox: [0, 0, 1, 1],
      },
    ],
    ...over,
  };
}

const PLAN = { paragraphs: 101, batches: 9, characters: 40567, sections: 15, skipped: 6 };

/** The reading route, and nothing else: the column must not call anything else. */
function backend(options: { reading?: BilingualView | null; onPost?: () => Response } = {}) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    calls.push(`${init?.method ?? "GET"} ${path}`);

    if (init?.method === "POST") {
      return options.onPost
        ? options.onPost()
        : json(reading({ cached: false }));
    }
    if (path.includes("/bilingual-text")) {
      if (!options.reading) {
        return json({ error: { code: "BILINGUAL_TEXT_NOT_FOUND", message: "", detail: { plan: PLAN } } }, 404);
      }
      return json(options.reading);
    }
    if (path.includes("/annotations")) return json({ document_id: "doc_test", content_hash: HASH, annotations: [] });
    if (path.includes("/overview")) return new Response("", { status: 404 });
    if (path.includes("/sections")) return json([]);
    if (path.includes("/profiles")) return json([]);
    return new Response("", { status: 404 });
  }));
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  getDocument.mockReset();
  getDocument.mockReturnValue({
    promise: Promise.resolve({
      numPages: 2,
      getPage: vi.fn(async () => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale, rotation: 0 }),
        render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
        streamTextContent: () => ({}),
      })),
    }),
    destroy: vi.fn(async () => undefined),
  });
  seedQaSections();
  seedIr();
  useWorkspaceStore.setState({
    readerMode: "immersive", outlinePanel: "overview", activePage: 1,
    bilingual: null, bilingualPlan: null, bilingualFor: null,
    bilingualStatus: "idle", bilingualError: null, bilingualStartedAt: null,
    profileId: "prof_1",
  });
});

describe("DS-DOC-006 · the mode", () => {
  it("offers a fourth mode that needs no translated PDF (AC-P0-14)", async () => {
    backend({ reading: reading() });
    render(<App />);

    const button = await screen.findByTestId("reader-mode-immersive");
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent("逐段");
    // The two PDF modes are locked without a translation; this one is not.
    expect(screen.getByTestId("reader-mode-bilingual")).toBeDisabled();
  });

  it("reads the stored column without generating one (AC-P0-01)", async () => {
    const calls = backend({ reading: reading() });
    render(<App />);

    await screen.findByTestId("bilingual-panel");
    await waitFor(() => expect(calls.some((call) => call.includes("/bilingual-text"))).toBe(true));
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
  });
});

describe("DS-DOC-006 · when there is nothing yet", () => {
  it("says what a generation would cost, and waits to be asked (AC-P0-15)", async () => {
    const calls = backend({ reading: null });
    render(<App />);

    const panel = await screen.findByTestId("bilingual-panel");
    expect(within(panel).getByTestId("bilingual-not-generated")).toBeInTheDocument();
    const plan = within(panel).getByTestId("bilingual-plan");
    expect(plan).toHaveTextContent("101 个段落");
    expect(plan).toHaveTextContent("9 次模型请求");
    expect(plan).toHaveTextContent("40,567 字符");
    expect(within(panel).getByTestId("bilingual-generate-btn")).toHaveTextContent("生成逐段对照");
    // Nothing has been spent, and nothing has been asked for.
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
  });

  it("generates only on the button, and renders what comes back (AC-P0-15)", async () => {
    const calls = backend({ reading: null });
    render(<App />);
    const user = userEvent.setup();
    const panel = await screen.findByTestId("bilingual-panel");

    await user.click(within(panel).getByTestId("bilingual-generate-btn"));
    await screen.findAllByTestId("bilingual-pair");
    expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
  });
});

describe("DS-DOC-006 · the column", () => {
  it("puts each translation under its own paragraph (AC-P0-16)", async () => {
    backend({ reading: reading() });
    render(<App />);
    await screen.findAllByTestId("bilingual-pair");

    const pairs = screen.getAllByTestId("bilingual-pair");
    expect(pairs).toHaveLength(2);
    const first = pairs[0]!;
    expect(within(first).getByTestId("bilingual-source-p")).toHaveTextContent(
      "Deeper neural networks are more difficult to train.",
    );
    expect(within(first).getByTestId("bilingual-target-p")).toHaveTextContent("更深的神经网络更难训练。");
    // Headings divide the stream, with both languages.
    expect(screen.getByTestId("bilingual-section-sec_a")).toHaveTextContent("Abstract");
    expect(screen.getByTestId("bilingual-section-sec_a")).toHaveTextContent("摘要");
  });

  it("says a paragraph is untranslated rather than filling it in (AC-P0-11)", async () => {
    // A run with a gap in it is PARTIAL, and the panel says so as well as
    // marking the paragraph: the artifact and the paragraph agree.
    backend({ reading: reading({ status: "PARTIAL", translated_paragraphs: 1 }) });
    render(<App />);
    await screen.findAllByTestId("bilingual-pair");

    const second = screen.getAllByTestId("bilingual-pair")[1]!;
    expect(within(second).getByTestId("bilingual-missing")).toHaveTextContent("此段未翻译");
    expect(within(second).queryByTestId("bilingual-target-p")).toBeNull();
    expect(screen.getByTestId("bilingual-partial")).toBeInTheDocument();
  });

  it("links the two halves of a pair on hover (AC-P0-17)", async () => {
    backend({ reading: reading() });
    render(<App />);
    await screen.findAllByTestId("bilingual-pair");

    const first = screen.getAllByTestId("bilingual-pair")[0]!;
    expect(first).not.toHaveAttribute("data-hovered");
    fireEvent.mouseEnter(within(first).getByTestId("bilingual-target-p"));
    expect(first).toHaveAttribute("data-hovered", "true");
    fireEvent.mouseLeave(first);
    expect(first).not.toHaveAttribute("data-hovered");
  });

  it("jumps to the paragraph in the PDF (AC-P0-18)", async () => {
    backend({ reading: reading() });
    render(<App />);
    await screen.findAllByTestId("bilingual-pair");

    const first = screen.getAllByTestId("bilingual-pair")[0]!;
    fireEvent.click(within(first).getByTestId("bilingual-jump-pdf"));

    const state = useWorkspaceStore.getState();
    expect(state.readerMode).toBe("original");
    expect(state.jumpRequest?.pageNumber).toBe(1);
    expect(state.jumpRequest?.bboxes).toEqual([[50, 100, 545, 140]]);
  });

  it("keeps the chrome out of a copied selection (AC-P0-19)", async () => {
    /* The jsdom half. A real clipboard is a browser's to produce, and jsdom
       re-derives selection text from the DOM — so what is asserted here is the
       rule the implementation follows: prose in its own element, chrome marked
       unselectable. The browser harness drags a real selection across a pair. */
    backend({ reading: reading() });
    render(<App />);
    await screen.findAllByTestId("bilingual-pair");

    const first = screen.getAllByTestId("bilingual-pair")[0]!;
    const source = within(first).getByTestId("bilingual-source-p");
    expect(source.querySelector("button")).toBeNull();
    expect(source.textContent).toBe("Deeper neural networks are more difficult to train.");
    // Every piece of chrome inside the pair is unselectable.
    for (const node of within(first).getAllByText(/P\. 1|未翻译/)) {
      const marked = node.closest(".select-none");
      expect(marked, `${node.textContent} must be unselectable`).not.toBeNull();
    }
  });

  it("shows formulas in the source, labelled and never translated (AC-P0-09)", async () => {
    backend({ reading: reading() });
    render(<App />);
    await screen.findAllByTestId("bilingual-pair");

    const formula = screen.getByTestId("bilingual-block-isolate_formula");
    expect(formula).toHaveTextContent("公式");
    expect(formula).toHaveTextContent("y = F(x, {Wi}) + x");
    expect(within(formula).queryByTestId("bilingual-target-p")).toBeNull();
  });

  it("discloses that this translation may differ from the PDF's (AC-P0-22)", async () => {
    backend({ reading: reading() });
    render(<App />);
    await screen.findAllByTestId("bilingual-pair");

    expect(screen.getByTestId("bilingual-disclaimer")).toHaveTextContent("与版面翻译 PDF");
    expect(screen.getByTestId("bilingual-disclaimer")).toHaveTextContent("deepseek-flash");
  });

  it("shows one language when asked (AC-P1 view toggles)", async () => {
    backend({ reading: reading() });
    render(<App />);
    const user = userEvent.setup();
    await screen.findAllByTestId("bilingual-pair");

    await user.click(screen.getByTestId("bilingual-view-target"));
    expect(screen.queryByTestId("bilingual-source-p")).toBeNull();
    expect(screen.getAllByTestId("bilingual-target-p")).toHaveLength(1);

    await user.click(screen.getByTestId("bilingual-view-source"));
    expect(screen.getAllByTestId("bilingual-source-p")).toHaveLength(2);
    expect(screen.queryByTestId("bilingual-target-p")).toBeNull();
  });
});

describe("DS-DOC-006 · leaving the paper", () => {
  it("drops the reading when another paper is opened", async () => {
    /* The column's work is torn down by the column's own module — a
       subscription, so that the document lifecycle does not have to import this
       code into the initial bundle. What it must still guarantee is the same:
       paper A's paragraphs are gone before paper B can render anything. */
    backend({ reading: reading() });
    render(<App />);
    await screen.findAllByTestId("bilingual-pair");
    expect(useWorkspaceStore.getState().bilingual).not.toBeNull();

    const { openDocument } = await import("@/translation/session");
    openDocument(new File([new Uint8Array([1])], "other.pdf", { type: "application/pdf" }));

    await waitFor(() => expect(useWorkspaceStore.getState().bilingual).toBeNull());
    expect(useWorkspaceStore.getState().bilingualFor).toBeNull();
    expect(useWorkspaceStore.getState().bilingualStatus).toBe("idle");
  });
});

describe("DS-DOC-006 · failure", () => {
  it("tells the reader a run is already going (AC-P0-20)", async () => {
    backend({
      reading: null,
      onPost: () => json({ error: { code: "GENERATION_ALREADY_IN_PROGRESS", message: "", detail: {} } }, 409),
    });
    render(<App />);
    const user = userEvent.setup();
    const panel = await screen.findByTestId("bilingual-panel");

    await user.click(within(panel).getByTestId("bilingual-generate-btn"));
    await waitFor(() =>
      expect(screen.getByTestId("bilingual-error")).toHaveTextContent("正在生成中"),
    );
  });

  it("keeps the paper readable while generation runs (AC-P0-20)", async () => {
    backend({ reading: null });
    render(<App />);
    const panel = await screen.findByTestId("bilingual-panel");
    const button = within(panel).getByTestId("bilingual-generate-btn");
    expect(button).toBeEnabled();

    const user = userEvent.setup();
    await user.click(button);
    await screen.findAllByTestId("bilingual-pair");
  });
});
