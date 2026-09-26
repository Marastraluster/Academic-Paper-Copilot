/**
 * DS-DOC-008 — the reflowed reading.
 *
 * Four rules run through these tests. **Headings are sections**: a `title` block
 * the extractor did not derive a section from is not a heading, however loudly
 * its layout class says otherwise. **Captions belong to their crop**, above a
 * table and below a figure, wherever the block order happened to put them.
 * **Nothing is spent without a button**, and a paragraph with no translation says
 * so rather than being filled in. And **the chrome stays out of the prose**.
 *
 * The fixture is one page carrying every case at once: a real heading, a fake
 * one, a figure, a table, a formula, a paragraph, one the artifact could not
 * translate, and the references.
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

const HASH = "hash_current";

/** Lazily imported view, twenty-two test files at once: the default is too short. */
const SLOW = { timeout: 5_000 };

const BLOCKS = [
  { id: "b_head", layout_class: "abandon", bbox: [60, 25, 550, 49], text: "running head" },
  { id: "b_h1", layout_class: "title", bbox: [50, 80, 295, 96], text: "1 Introduction" },
  // A `title` the extractor derived no section from: a table sub-label, and the
  // class of the trap this view must not fall into.
  { id: "b_fake", layout_class: "title", bbox: [50, 300, 200, 312], text: "Method | Acc" },
  { id: "b_p1", layout_class: "plain text", bbox: [50, 100, 295, 200], text: "left one" },
  { id: "b_p2", layout_class: "plain text", bbox: [50, 220, 295, 300], text: "left two" },
  // Captions are placed *before* their targets here on purpose: the measured
  // case, and the one a naive walk gets wrong.
  { id: "b_figcap", layout_class: "figure_caption", bbox: [50, 500, 560, 520], text: "Figure 1. A figure.", caption_of: "b_fig" },
  { id: "b_fig", layout_class: "figure", bbox: [50, 520, 560, 640], text: "" },
  { id: "b_tab", layout_class: "table", bbox: [50, 660, 560, 740], text: "Method Acc" },
  { id: "b_tabcap", layout_class: "table_caption", bbox: [50, 745, 560, 760], text: "Table 1. Results.", caption_of: "b_tab" },
  { id: "b_fx", layout_class: "isolate_formula", bbox: [80, 770, 300, 800], text: "LInfoNCE = −1" },
  { id: "b_fxcap", layout_class: "formula_caption", bbox: [320, 770, 340, 782], text: "(1)", caption_of: "b_fx" },
  { id: "b_ref", layout_class: "plain text", bbox: [317, 100, 560, 200], text: "[1] He et al." },
];

function seedIr() {
  const document = seedDocument();
  const block = (id: string) => BLOCKS.find((entry) => entry.id === id)!;
  useWorkspaceStore.setState({
    ir: {
      document_id: document.documentId ?? "doc_test",
      content_hash: HASH,
      page_count: 1,
      pipeline_version: "5",
      metadata: { title: "A Paper" },
      pages: [
        {
          page_number: 1,
          width_pt: 612,
          height_pt: 792,
          rotation: 0,
          blocks: BLOCKS.map((entry) => ({
            ...entry,
            bbox: entry.bbox as [number, number, number, number],
            page_number: 1,
            source_anchor_id: "",
          })),
        },
      ],
      sections: [
        {
          id: "sec_1",
          title: "1 Introduction",
          level: 1,
          page_range: [1, 1],
          parent_id: null,
          heading_block_id: "b_h1",
          is_references: false,
        },
        {
          id: "sec_refs",
          title: "References",
          level: 1,
          page_range: [1, 1],
          parent_id: null,
          heading_block_id: null,
          is_references: true,
        },
      ],
      paragraphs: [
        {
          id: "p_1",
          source_anchor_id: "a1",
          section_id: "sec_1",
          text: "Deeper neural networks are more difficult to train.",
          page_number: 1,
          page_range: [1, 1],
          block_ids: ["b_p1"],
          bboxes: [block("b_p1").bbox as [number, number, number, number]],
        },
        {
          id: "p_2",
          source_anchor_id: "a2",
          section_id: "sec_1",
          text: "We present a residual learning framework.",
          page_number: 1,
          page_range: [1, 1],
          block_ids: ["b_p2"],
          bboxes: [block("b_p2").bbox as [number, number, number, number]],
        },
        {
          id: "p_ref",
          source_anchor_id: "a3",
          section_id: "sec_refs",
          text: "[1] Kaiming He et al. Deep Residual Learning.",
          page_number: 1,
          page_range: [1, 1],
          block_ids: ["b_ref"],
          bboxes: [block("b_ref").bbox as [number, number, number, number]],
        },
      ],
    } as never,
  });
}

function reading(over: Partial<BilingualView> = {}): BilingualView {
  return {
    status: "READY",
    cached: true,
    content_hash: HASH,
    target_language: "zh-CN",
    provider_model: "deepseek-flash",
    created_at: "2026-09-26T00:00:00+00:00",
    input_tokens: 1200,
    output_tokens: 340,
    notes: [],
    total_paragraphs: 3,
    translated_paragraphs: 1,
    sections: [
      {
        section_id: "sec_1",
        title: "1 Introduction",
        title_translated: "1 引言",
        level: 1,
        page_number: 1,
        is_references: false,
      },
    ],
    paragraphs: [
      {
        paragraph_id: "p_1",
        page_number: 1,
        section_id: "sec_1",
        source_text: "Deeper neural networks are more difficult to train.",
        translated_text: "更深的神经网络更难训练。",
        status: "translated",
        note: "",
        bboxes: [[50, 100, 295, 200]],
      },
      {
        paragraph_id: "p_2",
        page_number: 1,
        section_id: "sec_1",
        source_text: "We present a residual learning framework.",
        translated_text: "",
        status: "untranslated",
        note: "本段未能翻译",
        bboxes: [[50, 220, 295, 300]],
      },
      {
        paragraph_id: "p_ref",
        page_number: 1,
        section_id: "sec_refs",
        source_text: "[1] Kaiming He et al. Deep Residual Learning.",
        translated_text: "",
        status: "skipped",
        note: "参考文献不予翻译",
        bboxes: [[317, 100, 560, 200]],
      },
    ],
    blocks: [],
    ...over,
  };
}

const PLAN = { paragraphs: 101, batches: 9, characters: 40567, sections: 16, skipped: 6 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function backend(options: { reading?: BilingualView | null; onPost?: () => Response } = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      calls.push(`${init?.method ?? "GET"} ${path}`);

      if (init?.method === "POST") {
        return options.onPost ? options.onPost() : json(reading({ cached: false }));
      }
      if (path.includes("/bilingual-text")) {
        if (!options.reading) {
          return json(
            { error: { code: "BILINGUAL_TEXT_NOT_FOUND", message: "", detail: { plan: PLAN } } },
            404,
          );
        }
        return json(options.reading);
      }
      if (path.includes("/annotations")) {
        return json({ document_id: "doc_test", content_hash: HASH, annotations: [] });
      }
      if (path.includes("/overview")) return new Response("", { status: 404 });
      if (path.includes("/sections")) return json([]);
      if (path.includes("/profiles")) return json([]);
      return new Response("", { status: 404 });
    }),
  );
  return calls;
}

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  getDocument.mockReset();
  getDocument.mockReturnValue({
    promise: Promise.resolve({
      numPages: 1,
      getPage: vi.fn(async () => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: 612 * scale,
          height: 792 * scale,
          rotation: 0,
        }),
        render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
        streamTextContent: () => ({}),
      })),
    }),
    destroy: vi.fn(async () => undefined),
  });
  seedQaSections();
  seedIr();
  useWorkspaceStore.setState({
    readerMode: "immersive",
    outlinePanel: "outline",
    activePage: 1,
    bilingual: null,
    bilingualPlan: null,
    bilingualFor: null,
    bilingualStatus: "idle",
    bilingualError: null,
    bilingualStartedAt: null,
    profileId: "prof_1",
    profiles: [
      {
        id: "prof_1",
        name: "Deepseek",
        base_url: "https://api.deepseek.com",
        model: "deepseek-flash",
        protocol: "auto",
        has_key: true,
        api_key_masked: "sk-••••1234",
      },
    ],
  });
});

describe("DS-DOC-008 · the reading", () => {
  it("mounts the reflowed reading, and the pixel view is gone (AC-P0-07)", async () => {
    backend({ reading: reading() });
    render(<App />);

    await screen.findByTestId("reflow-reader", {}, SLOW);
    expect(screen.queryByTestId("bilingual-inpage")).toBeNull();
    expect(screen.queryByTestId("bilingual-inpage-strip")).toBeNull();
  });

  it("sets the prose as prose, with the translation beneath it (AC-P0-12/13)", async () => {
    backend({ reading: reading() });
    render(<App />);

    const sources = await screen.findAllByTestId("reflow-source", {}, SLOW);
    const source = sources[0]!;
    expect(source).toHaveTextContent("Deeper neural networks are more difficult to train.");
    const translation = screen.getByTestId("reflow-translation");
    expect(translation).toHaveTextContent("更深的神经网络更难训练。");
    // The pair is one group; the translation is subordinate, not hidden.
    expect(source.closest("[data-testid='reflow-pair']")).toBe(
      translation.closest("[data-testid='reflow-pair']"),
    );
    expect(translation.className).toContain("border-l-2");
  });

  it("takes headings from the sections, not from `title` blocks (AC-P0-08)", async () => {
    backend({ reading: reading() });
    render(<App />);

    const headings = await screen.findAllByTestId("reflow-heading", {}, SLOW);
    expect(headings).toHaveLength(1);
    expect(headings[0]).toHaveTextContent("1 Introduction");
    expect(screen.getByTestId("reflow-heading-translated")).toHaveTextContent("1 引言");
    // The trap: this block's layout class is `title`, and it is not a heading.
    expect(screen.queryByText("Method | Acc")).toBeNull();
  });

  it("carries figures, tables and formulas as crops, each with its own caption (AC-P0-09/10)", async () => {
    backend({ reading: reading() });
    render(<App />);

    const crops = await screen.findAllByTestId("reflow-crop", {}, SLOW);
    expect(crops).toHaveLength(3);

    const figure = crops.find((crop) => crop.dataset.layoutClass === "figure")!;
    const table = crops.find((crop) => crop.dataset.layoutClass === "table")!;
    const formula = crops.find((crop) => crop.dataset.layoutClass === "isolate_formula")!;

    // Placed by convention, not by block order: the figure's caption came BEFORE
    // its figure in the IR and is rendered below it here; the table's came after
    // and is rendered above it.
    expect(within(figure).getByTestId("reflow-caption")).toHaveTextContent("Figure 1.");
    expect(figure.dataset.classCaption).toBe("below");
    expect(within(table).getByTestId("reflow-caption")).toHaveTextContent("Table 1.");
    expect(table.dataset.classCaption).toBe("above");
    expect(within(formula).getByTestId("reflow-caption")).toHaveTextContent("(1)");
    expect(formula.dataset.classCaption).toBe("beside");

    // Never as text: the scrambled formula string is nowhere on the page.
    expect(screen.queryByText(/LInfoNCE/)).toBeNull();
    // And a caption is never emitted as a block of its own.
    expect(screen.queryAllByTestId("reflow-caption")).toHaveLength(3);
  });

  it("drops the running head and everything else the extractor abandoned (AC-P0-11)", async () => {
    backend({ reading: reading() });
    render(<App />);

    await screen.findByTestId("reflow-reader", {}, SLOW);
    expect(screen.queryByText("running head")).toBeNull();
  });

  it("keeps the references in the paper's words and says why (AC-P0-17)", async () => {
    backend({ reading: reading() });
    render(<App />);

    expect(await screen.findByTestId("reflow-references-notice", {}, SLOW)).toHaveTextContent(
      "参考文献保留原文",
    );
    expect(screen.getByText("[1] Kaiming He et al. Deep Residual Learning.")).toBeInTheDocument();
    // Nothing was invented for it, and no badge says it failed.
    expect(screen.queryAllByTestId("bilingual-gap-badge")).toHaveLength(1);
  });

  it("says a paragraph is untranslated instead of filling it in (AC-P0-18)", async () => {
    backend({ reading: reading() });
    render(<App />);

    const gap = await screen.findByTestId("bilingual-gap-badge", {}, SLOW);
    expect(gap).toHaveTextContent("此段未翻译");
    expect(screen.getByText("重新生成逐段对照")).toBeInTheDocument();
  });

  it("keeps the chrome out of a copied selection (AC-P0-19)", async () => {
    backend({ reading: reading() });
    render(<App />);

    const source = (await screen.findAllByTestId("reflow-source", {}, SLOW))[0]!;
    expect(source.querySelector("button")).toBeNull();
    expect(source.className).not.toContain("select-none");
    expect(screen.getByTestId("reflow-heading").className).toContain("select-none");
    expect(screen.getByTestId("reflow-references-notice").className).toContain("select-none");
  });

  it("discloses the cost, and spends nothing until asked (AC-P0-20)", async () => {
    const calls = backend({ reading: null });
    render(<App />);

    await screen.findByTestId("bilingual-not-generated", {}, SLOW);
    const plan = screen.getByTestId("bilingual-plan");
    expect(plan).toHaveTextContent("101 个段落");
    expect(plan).toHaveTextContent("9 次模型请求");
    expect(plan).toHaveTextContent("40,567 字符");
    expect(await screen.findByText(/Deepseek/, {}, SLOW)).toBeInTheDocument();
    expect(screen.queryByText(/sk-/)).toBeNull();
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);

    const user = userEvent.setup();
    await user.click(screen.getByTestId("bilingual-generate-btn"));
    await screen.findAllByTestId("reflow-pair", {}, SLOW);
    expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(1);
  });

  it("tells the reader a run is already going (AC-P0-20)", async () => {
    backend({
      reading: null,
      onPost: () =>
        json({ error: { code: "GENERATION_ALREADY_IN_PROGRESS", message: "", detail: {} } }, 409),
    });
    render(<App />);
    const user = userEvent.setup();

    await screen.findByTestId("bilingual-not-generated", {}, SLOW);
    await user.click(screen.getByTestId("bilingual-generate-btn"));
    await waitFor(
      () => expect(screen.getByTestId("bilingual-error")).toHaveTextContent("正在生成中"),
      SLOW,
    );
  });

  it("shows one language when asked, client-side (AC-P1-02)", async () => {
    backend({ reading: reading() });
    render(<App />);
    const user = userEvent.setup();

    await screen.findAllByTestId("reflow-source", {}, SLOW);
    await user.click(screen.getByTestId("bilingual-view-target"));
    for (const element of screen.getAllByTestId("reflow-source")) {
      expect(element.className).toContain("hidden");
    }
    expect(screen.getByTestId("reflow-translation").className).not.toContain("hidden");
    await user.click(screen.getByTestId("bilingual-view-source"));
    expect(screen.getByTestId("reflow-translation").className).toContain("hidden");
  });

  it("couples a pair on hover (AC-P1-03)", async () => {
    backend({ reading: reading() });
    render(<App />);

    const pair = (await screen.findAllByTestId("reflow-pair", {}, SLOW))[0]!;
    fireEvent.mouseEnter(pair);
    await waitFor(() => expect(pair.getAttribute("data-hovered")).toBe("true"));
    fireEvent.mouseLeave(pair);
    await waitFor(() => expect(pair.getAttribute("data-hovered")).toBeNull());
  });

  it("addresses a section's heading, so the outline has somewhere to land (AC-P1-06)", async () => {
    backend({ reading: reading() });
    render(<App />);

    const heading = await screen.findByTestId("reflow-heading", {}, SLOW);
    expect(heading.dataset.sectionId).toBe("sec_1");
    expect(heading.dataset.itemPage).toBe("1");
  });

  it("discloses that this translation may differ from the PDF's (AC-P0-24)", async () => {
    backend({ reading: reading() });
    render(<App />);

    expect(await screen.findByTestId("bilingual-disclaimer", {}, SLOW)).toHaveTextContent(
      "与版面翻译 PDF",
    );
  });
});

describe("DS-DOC-008 · leaving the paper", () => {
  it("drops the reading when another paper is opened", async () => {
    backend({ reading: reading() });
    render(<App />);
    await screen.findAllByTestId("reflow-pair", {}, SLOW);
    expect(useWorkspaceStore.getState().bilingual).not.toBeNull();

    const { openDocument } = await import("@/translation/session");
    openDocument(new File([new Uint8Array([1])], "other.pdf", { type: "application/pdf" }));

    await waitFor(() => expect(useWorkspaceStore.getState().bilingual).toBeNull());
    expect(useWorkspaceStore.getState().bilingualFor).toBeNull();
  });
});
