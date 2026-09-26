/**
 * DS-DOC-007 — the unrolled page.
 *
 * The column this replaces re-typeset the paper and lost its layout; these tests
 * hold the new view to the opposite promise. **The paper is the paper**: every
 * region on screen is a canvas carrying the page's own pixels, and no source
 * paragraph is ever rendered as HTML text. **The translation is text**: it is
 * selectable, and the chrome around it is not. **Nothing is spent without a
 * button**, and a paragraph that has no translation says so rather than being
 * filled in.
 *
 * The fixture is a two-column page with a running head, a wide figure and a
 * folio — the shape every body page of a real paper has, small enough to reason
 * about by hand.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BilingualView } from "@/api/bilingual";
import { App } from "@/app/App";
import { pageFlow } from "@/bilingual/inpage/geometry";
import { estimateFlowHeight } from "@/bilingual/inpage/heights";
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

/**
 * This view is lazily imported, and twenty-two test files compile at once: the
 * one-second default is not enough for the chunk to arrive plus the page to
 * build, and a slow chunk is not a product failure.
 */
const SLOW = { timeout: 5_000 };

/**
 * One two-column page, in the IR's own coordinates.
 *
 * Left lane x 50–295, right lane x 317–560, a wide figure across both, a running
 * head above the body and a folio below it.
 */
const BLOCKS = [
  { id: "b_head", layout_class: "abandon", bbox: [60, 25, 550, 49], text: "paper 1" },
  { id: "b_left1", layout_class: "plain text", bbox: [50, 100, 295, 200], text: "left one" },
  { id: "b_left2", layout_class: "plain text", bbox: [50, 220, 295, 320], text: "left two" },
  { id: "b_fig", layout_class: "figure", bbox: [50, 400, 560, 500], text: "figure" },
  { id: "b_right1", layout_class: "plain text", bbox: [317, 100, 560, 200], text: "right one" },
  { id: "b_right2", layout_class: "plain text", bbox: [317, 220, 560, 320], text: "references" },
  { id: "b_folio", layout_class: "abandon", bbox: [300, 762, 310, 772], text: "1" },
];

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
          page_number: 1,
          width_pt: 612,
          height_pt: 792,
          rotation: 0,
          blocks: BLOCKS.map((block) => ({
            ...block,
            page_number: 1,
            font_size: 9.5,
            source_anchor_id: "",
          })),
        },
        { page_number: 2, width_pt: 612, height_pt: 792, rotation: 0, blocks: [] },
      ],
      paragraphs: [
        {
          id: "p_1",
          source_anchor_id: "a1",
          section_id: "sec_a",
          text: "Deeper neural networks are more difficult to train.",
          page_number: 1,
          page_range: [1, 1],
          block_ids: ["b_left1"],
          bboxes: [[50, 100, 295, 200]],
        },
        {
          id: "p_2",
          source_anchor_id: "a2",
          section_id: "sec_a",
          text: "We present a residual learning framework.",
          page_number: 1,
          page_range: [1, 1],
          block_ids: ["b_left2"],
          bboxes: [[50, 220, 295, 320]],
        },
        {
          id: "p_3",
          source_anchor_id: "a3",
          section_id: "sec_a",
          text: "The right column starts here.",
          page_number: 1,
          page_range: [1, 1],
          block_ids: ["b_right1"],
          bboxes: [[317, 100, 560, 200]],
        },
        {
          id: "p_4",
          source_anchor_id: "a4",
          section_id: "sec_refs",
          text: "[1] Kaiming He et al. Deep Residual Learning.",
          page_number: 1,
          page_range: [1, 1],
          block_ids: ["b_right2"],
          bboxes: [[317, 220, 560, 320]],
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
    created_at: "2026-09-23T00:00:00+00:00",
    input_tokens: 1200,
    output_tokens: 340,
    notes: [],
    total_paragraphs: 4,
    translated_paragraphs: 2,
    sections: [
      {
        section_id: "sec_a",
        title: "Abstract",
        title_translated: "摘要",
        level: 1,
        page_number: 1,
        is_references: false,
      },
    ],
    paragraphs: [
      {
        paragraph_id: "p_1",
        page_number: 1,
        section_id: "sec_a",
        source_text: "Deeper neural networks are more difficult to train.",
        translated_text: "更深的神经网络更难训练。",
        status: "translated",
        note: "",
        bboxes: [[50, 100, 295, 200]],
      },
      {
        paragraph_id: "p_2",
        page_number: 1,
        section_id: "sec_a",
        source_text: "We present a residual learning framework.",
        translated_text: "",
        status: "untranslated",
        note: "本段未能翻译",
        bboxes: [[50, 220, 295, 320]],
      },
      {
        paragraph_id: "p_3",
        page_number: 1,
        section_id: "sec_a",
        source_text: "The right column starts here.",
        translated_text: "右栏从这里开始。",
        status: "translated",
        note: "",
        bboxes: [[317, 100, 560, 200]],
      },
      {
        paragraph_id: "p_4",
        page_number: 1,
        section_id: "sec_refs",
        source_text: "[1] Kaiming He et al. Deep Residual Learning.",
        translated_text: "",
        status: "skipped",
        note: "参考文献不予翻译",
        bboxes: [[317, 220, 560, 320]],
      },
    ],
    blocks: [],
    ...over,
  };
}

const PLAN = { paragraphs: 101, batches: 9, characters: 40567, sections: 15, skipped: 6 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The reading route, and nothing else: this view must not call anything else. */
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
      if (path.includes("/profiles")) {
        return json([
          {
            id: "prof_1",
            name: "Deepseek",
            base_url: "https://api.deepseek.com",
            model: "deepseek-flash",
            protocol: "auto",
            temperature: null,
            max_output_tokens: null,
            timeout_s: 60,
            custom_headers: null,
            has_key: true,
            api_key_masked: "sk-••••1234",
            created_at: "2026-09-17T00:00:00+00:00",
            updated_at: "2026-09-17T00:00:00+00:00",
          },
        ]);
      }
      return new Response("", { status: 404 });
    }),
  );
  return calls;
}

beforeEach(() => {
  // jsdom logs "not implemented" for each getContext call; the view copes with a
  // missing 2D context already (it is what a headless jsdom *is*), and the stub
  // keeps that from drowning the suite's output.
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  getDocument.mockReset();
  getDocument.mockReturnValue({
    promise: Promise.resolve({
      numPages: 2,
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
    outlinePanel: "overview",
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

describe("DS-DOC-007 · the mode", () => {
  it("mounts the unrolled page, and the extracted column is gone (AC-P0-17)", async () => {
    backend({ reading: reading() });
    render(<App />);

    await screen.findByTestId("bilingual-inpage", {}, SLOW);
    // The DS-DOC-006 column is deleted, not kept beside this: one 逐段 mode.
    expect(screen.queryByTestId("bilingual-panel")).toBeNull();
    expect(screen.queryByTestId("bilingual-pair")).toBeNull();
  });

  it("reads the stored reading without generating one (AC-P0-01)", async () => {
    const calls = backend({ reading: reading() });
    render(<App />);

    await screen.findAllByTestId("bilingual-inpage-strip", {}, SLOW);
    await waitFor(() =>
      expect(calls.some((call) => call.includes("/bilingual-text"))).toBe(true),
    );
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
  });
});

describe("DS-DOC-007 · nothing generated yet", () => {
  it("says what a generation would cost, and waits to be asked (AC-P0-18)", async () => {
    const calls = backend({ reading: null });
    render(<App />);

    await screen.findByTestId("bilingual-not-generated", {}, SLOW);
    const plan = screen.getByTestId("bilingual-plan");
    expect(plan).toHaveTextContent("101 个段落");
    expect(plan).toHaveTextContent("9 次模型请求");
    expect(plan).toHaveTextContent("40,567 字符");
    // The profile is named; the key never is.
    expect(await screen.findByText(/Deepseek/, {}, SLOW)).toBeInTheDocument();
    expect(screen.queryByText(/sk-/)).toBeNull();
    expect(screen.getByTestId("bilingual-generate-btn")).toHaveTextContent("生成逐段对照");
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
  });

  it("generates only on the button (AC-P0-18)", async () => {
    const calls = backend({ reading: null });
    render(<App />);
    const user = userEvent.setup();

    // Wait for the read to settle before clicking. The button exists from the
    // first paint, and the read replaces it with "正在载入…" a moment later — so a
    // click that lands in between hits a node React has already swapped out and
    // spends nothing. The line only shown when there is nothing stored is what
    // says the read has finished.
    await screen.findByTestId("bilingual-not-generated", {}, SLOW);
    await user.click(screen.getByTestId("bilingual-generate-btn"));
    await screen.findAllByTestId("bilingual-inpage-target", {}, SLOW);
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
});

describe("DS-DOC-007 · the page", () => {
  it("draws the paper's own regions as canvases, sized to the geometry (AC-P0-07)", async () => {
    backend({ reading: reading() });
    render(<App />);

    const strips = await screen.findAllByTestId("bilingual-inpage-strip", {}, SLOW);
    expect(strips.length).toBeGreaterThan(3);
    for (const strip of strips) {
      expect(strip.querySelector("canvas")).not.toBeNull();
    }
    // The running head is a full-width band at the top of the page; the folio is
    // the last band. Both are the paper's pixels, neither is prose.
    const head = strips[0]!;
    expect(head.dataset.stripLane).toBe("full");
    expect(Number(head.dataset.regionY0)).toBe(0);

    // No source text is re-typeset: the only HTML text on the page is what the
    // generator inserted, never the paragraph the paper drew.
    expect(screen.queryByText("Deeper neural networks are more difficult to train.")).toBeNull();
  });

  it("puts each translation directly under its own paragraph (AC-P0-10)", async () => {
    backend({ reading: reading() });
    render(<App />);

    const targets = await screen.findAllByTestId("bilingual-inpage-target", {}, SLOW);
    const translated = targets.filter(
      (target) => target.querySelector('[data-testid="bilingual-inpage-text"]') !== null,
    );
    expect(translated).toHaveLength(2);
    expect(within(translated[0]!).getByTestId("bilingual-inpage-text")).toHaveTextContent(
      "更深的神经网络更难训练。",
    );
    expect(within(translated[1]!).getByTestId("bilingual-inpage-text")).toHaveTextContent(
      "右栏从这里开始。",
    );

    // Each translation follows the strip whose source region ends where the
    // paragraph does — the paper's own geometry, not a list position.
    const order = Array.from(
      screen.getByTestId("bilingual-inpage-scroll").querySelectorAll(
        '[data-testid="bilingual-inpage-strip"], [data-testid="bilingual-inpage-target"]',
      ),
    );
    for (const target of translated) {
      const at = order.indexOf(target);
      const strip = order[at - 1]!;
      expect(strip.getAttribute("data-testid")).toBe("bilingual-inpage-strip");
      expect(Number(strip.getAttribute("data-region-y1"))).toBeCloseTo(
        Number(target.getAttribute("data-region-y1")),
        1,
      );
    }
  });

  it("says a paragraph is untranslated instead of filling it in (AC-P0-22)", async () => {
    backend({ reading: reading() });
    render(<App />);

    const gap = await screen.findByTestId("bilingual-inpage-gap", {}, SLOW);
    expect(gap).toHaveTextContent("此段未翻译");
    expect(screen.getByTestId("bilingual-inpage-retry")).toBeInTheDocument();
  });

  it("says the references are kept in the paper's own words (AC-P0-12)", async () => {
    backend({ reading: reading() });
    render(<App />);

    expect(await screen.findByTestId("bilingual-inpage-kept-original", {}, SLOW)).toHaveTextContent(
      "参考文献保留原文",
    );
    // The skipped paragraph is still the paper's pixels: nothing was dropped.
    const strips = screen.getAllByTestId("bilingual-inpage-strip");
    expect(strips.length).toBeGreaterThan(0);
  });

  it("reserves an estimated height before the page has been laid out (AC-P0-13)", async () => {
    backend({ reading: reading() });
    render(<App />);

    const pages = await screen.findAllByTestId("bilingual-inpage-page", {}, SLOW);
    const reserved = Number.parseFloat(pages[0]!.style.minHeight);
    // The paper's own height in CSS pixels is the floor; the translations are the
    // rest, and a container that defaulted to the paper's height would let the
    // page grow under the reader as it laid out.
    expect(reserved).toBeGreaterThanOrEqual(792);
    expect(reserved).toBeGreaterThan(792);

    // And the estimate is the view's own: the same flow gives the same number
    // every time, which is what makes reserving space testable at all.
    const flow = pageFlow(
      { pageNumber: 1, widthPt: 612, heightPt: 792 },
      BLOCKS.map((block) => ({
        id: block.id,
        layoutClass: block.layout_class,
        box: block.bbox as [number, number, number, number],
        fontSize: 9.5,
      })),
      reading().paragraphs.map((paragraph) => ({
        id: paragraph.paragraph_id,
        boxes: paragraph.bboxes as [number, number, number, number][],
        status: paragraph.status,
        text: paragraph.translated_text,
        note: paragraph.note,
      })),
    );
    expect(estimateFlowHeight(flow, 1, () => 9.5)).toBe(reserved);
  });

  it("keeps the chrome out of a copied selection (AC-P0-16)", async () => {
    backend({ reading: reading() });
    render(<App />);

    const target = (await screen.findAllByTestId("bilingual-inpage-target", {}, SLOW))[0]!;
    // The prose is its own element; every button and badge around it is marked
    // unselectable, so a drag copies the translation and nothing else.
    const prose = within(target).getByTestId("bilingual-inpage-text");
    expect(prose.querySelector("button")).toBeNull();
    for (const chrome of target.querySelectorAll("button")) {
      expect(chrome.className).toContain("select-none");
    }
    // And the mark is on the chrome only: a root that carried it would make the
    // translation uncopyable, which is the opposite of what this view is for.
    expect(prose.className).not.toContain("select-none");
    for (const chrome of screen.getAllByTestId("bilingual-inpage-seam")) {
      expect(chrome.className).toContain("select-none");
    }
    expect(screen.getByTestId("bilingual-counts").parentElement?.className).toContain("select-none");
  });

  it("discloses that this translation may differ from the PDF's (AC-P0-24)", async () => {
    backend({ reading: reading() });
    render(<App />);

    expect(await screen.findByTestId("bilingual-disclaimer", {}, SLOW)).toHaveTextContent(
      "与版面翻译 PDF",
    );
  });

  it("takes the reader back to the paragraph in the PDF (AC-P0-23)", async () => {
    backend({ reading: reading() });
    render(<App />);
    const user = userEvent.setup();

    const badges = await screen.findAllByTestId("bilingual-jump-pdf", {}, SLOW);
    await user.click(badges[0]!);
    await waitFor(() => expect(useWorkspaceStore.getState().readerMode).toBe("original"));
    expect(useWorkspaceStore.getState().jumpRequest?.pageNumber).toBe(1);
  });

  it("shows one language when asked, client-side (AC-P1-02)", async () => {
    backend({ reading: reading() });
    render(<App />);
    const user = userEvent.setup();

    const targets = await screen.findAllByTestId("bilingual-inpage-target", {}, SLOW);
    await user.click(screen.getByTestId("bilingual-view-source"));
    for (const target of targets) {
      if (target.querySelector('[data-testid="bilingual-inpage-text"]') !== null) {
        expect(target.className).toContain("hidden");
      }
    }
  });

  it("links the two halves of a pair on hover (AC-P1-01)", async () => {
    backend({ reading: reading() });
    render(<App />);

    const target = (await screen.findAllByTestId("bilingual-inpage-target", {}, SLOW))[0]!;
    fireEvent.mouseEnter(target);
    await waitFor(() =>
      expect(target.getAttribute("data-hovered")).toBe("true"),
    );
    fireEvent.mouseLeave(target);
    await waitFor(() => expect(target.getAttribute("data-hovered")).toBeNull());
  });
});

describe("DS-DOC-007 · leaving the paper", () => {
  it("drops the reading when another paper is opened", async () => {
    backend({ reading: reading() });
    render(<App />);
    await screen.findAllByTestId("bilingual-inpage-strip", {}, SLOW);
    expect(useWorkspaceStore.getState().bilingual).not.toBeNull();

    const { openDocument } = await import("@/translation/session");
    openDocument(new File([new Uint8Array([1])], "other.pdf", { type: "application/pdf" }));

    await waitFor(() => expect(useWorkspaceStore.getState().bilingual).toBeNull());
    expect(useWorkspaceStore.getState().bilingualFor).toBeNull();
  });
});
