/**
 * DS-DOC-010 — display formulas typeset from reconstructed LaTeX.
 *
 * The feature's whole risk is that a reconstruction is **wrong in a way that
 * looks right**, so these tests are mostly about what happens when it cannot be
 * trusted: LaTeX that does not parse, a formula the model refused, a paper whose
 * formulas were never reconstructed at all, and a formula too long to fit. In
 * every one of those cases the answer is the paper's own pixels, said out loud.
 *
 * The renderer is real: `katex` is imported and asked to parse the strings, which
 * is what makes the fallback test meaningful rather than a mock agreeing with
 * itself.
 */
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BilingualView } from "@/api/bilingual";
import type { FormulaView } from "@/api/formulas";
import { App } from "@/app/App";
import { FormulaItem } from "@/formulas/FormulaItem";
import { useWorkspaceStore } from "@/stores/workspace";
import { seedDocument } from "@/tests/fixtures";

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

const HASH = "hash_formula";
const SLOW = { timeout: 5_000 };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The paper: one page, one display formula, its scrambled text, a number. */
function seedIr() {
  const document = seedDocument();
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
          blocks: [
            { id: "b_head", page_number: 1, layout_class: "abandon", source_anchor_id: "", bbox: [60, 25, 550, 49], text: "head" },
            { id: "b_p1", page_number: 1, layout_class: "plain text", source_anchor_id: "", bbox: [50, 100, 295, 200], text: "where τ is a learned temperature." },
            { id: "b_fx", page_number: 1, layout_class: "isolate_formula", source_anchor_id: "anchor_fx", bbox: [84, 640, 260, 706], text: "LInfoNCE = −1 / 2B", font_size: 9.3 },
            { id: "b_num", page_number: 1, layout_class: "formula_caption", source_anchor_id: "", bbox: [281, 667, 294, 679], text: "(1)", font_size: 9.3, caption_of: null },
          ],
        },
      ],
      sections: [],
      paragraphs: [
        {
          id: "p_1",
          source_anchor_id: "a1",
          section_id: null,
          text: "where τ is a learned temperature.",
          page_number: 1,
          page_range: [1, 1],
          block_ids: ["b_p1"],
          bboxes: [[50, 100, 295, 200]],
        },
      ],
    } as never,
  });
}

function reading(): BilingualView {
  return {
    status: "READY",
    cached: true,
    content_hash: HASH,
    target_language: "zh-CN",
    provider_model: "deepseek-flash",
    created_at: "2026-09-27T00:00:00+00:00",
    input_tokens: 1,
    output_tokens: 1,
    notes: [],
    total_paragraphs: 1,
    translated_paragraphs: 1,
    sections: [],
    paragraphs: [
      {
        paragraph_id: "p_1",
        page_number: 1,
        section_id: null,
        source_text: "where τ is a learned temperature.",
        translated_text: "其中 τ 是学到的温度参数。",
        status: "translated",
        note: "",
        bboxes: [[50, 100, 295, 200]],
      },
    ],
    blocks: [],
  };
}

function formulas(over: Partial<FormulaView> = {}): FormulaView {
  return {
    content_hash: HASH,
    status: "READY",
    total_formulas: 1,
    reconstructed_count: 1,
    refused_count: 0,
    failed_count: 0,
    formulas: [
      {
        block_id: "b_fx",
        source_anchor_id: "anchor_fx",
        page_number: 1,
        bbox: [84, 640, 260, 706],
        raw_soup: "LInfoNCE = −1 / 2B / B / X / i=1",
        font_size: 9.3,
        status: "reconstructed",
        latex: "\\mathcal{L}_{\\text{InfoNCE}} = -\\frac{1}{2B}\\sum_{i=1}^{B} \\log \\frac{\\exp(z_i^v \\cdot z_i^t/\\tau)}{\\sum_j \\exp(z_i^v \\cdot z_j^t/\\tau)}",
        equation_number: "(1)",
        refusal_reason: null,
        error_reason: null,
      },
    ],
    provider_model: "deepseek-flash",
    created_at: "2026-09-27T00:00:00+00:00",
    input_tokens: 900,
    output_tokens: 120,
    notes: [],
    ...over,
  };
}

/** The reading routes, and the formula routes. Nothing else is called. */
function backend(options: { formulas?: FormulaView | null; bilingual?: BilingualView | null } = {}) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${path}`);

      if (path.includes("/formulas")) {
        if (method === "POST") {
          return json(options.formulas === null ? {} : (options.formulas ?? formulas()));
        }
        if (!options.formulas) {
          return json(
            {
              error: {
                code: "FORMULA_NOT_FOUND",
                message: "no formulas yet",
                detail: { plan: { total_formulas: 7, batch_count: 1, character_volume: 1280 } },
              },
            },
            404,
          );
        }
        return json(options.formulas);
      }
      if (path.includes("/bilingual-text")) {
        return json(options.bilingual === null ? {} : (options.bilingual ?? reading()));
      }
      if (path.includes("/annotations")) {
        return json({ document_id: "doc_test", content_hash: HASH, annotations: [] });
      }
      if (path.includes("/overview")) return new Response("", { status: 404 });
      if (path.includes("/sections")) return json([]);
      if (path.includes("/profiles")) return json([]);
      if (path.includes("/ir")) return json({});
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
  seedIr();
  useWorkspaceStore.setState({
    readerMode: "immersive",
    outlinePanel: "outline",
    activePage: 1,
    bilingual: null,
    bilingualFor: null,
    bilingualStatus: "idle",
    formulas: null,
    formulasFor: null,
    formulasPlan: null,
    formulasStatus: "idle",
    formulasError: null,
    profileId: "prof_1",
  });
});

describe("DS-DOC-010 · a reconstructed formula", () => {
  it("typesets the model's LaTeX instead of showing the paper's pixels (AC-P0-04, AC-P0-07)", async () => {
    backend({ formulas: formulas() });
    render(<App />);

    const math = await screen.findByTestId("reflow-formula-math", {}, SLOW);
    // KaTeX's own output, with the glyph soup nowhere in sight.
    expect(math.querySelector(".katex")).not.toBeNull();
    expect(screen.queryByText(/LInfoNCE = −1/)).toBeNull();
    expect(screen.getByTestId("reflow-formula-item").dataset.renderMode).toBe("latex");
  });

  it("says the formula was reconstructed, and hands back the original on a click (AC-P0-11)", async () => {
    backend({ formulas: formulas() });
    render(<App />);
    const user = userEvent.setup();

    // Wait for the renderer to have arrived: while it is being fetched the item
    // is already showing the paper, and asserting the badge before then asserts
    // the loading state.
    const item = await screen.findByTestId("reflow-formula-item", {}, SLOW);
    await waitFor(() => expect(item.dataset.renderMode).toBe("latex"));
    const badge = screen.getByTestId("reflow-formula-badge");
    expect(badge).toHaveTextContent("AI 重建");
    expect(badge.getAttribute("title")).toContain("可能存在符号或下标偏差");

    await user.click(screen.getByTestId("reflow-formula-math"));
    await waitFor(() =>
      expect(screen.getByTestId("reflow-formula-item").dataset.renderMode).toBe("crop"),
    );
    expect(screen.getByTestId("reflow-formula-badge")).toHaveTextContent("原版 PDF 剪裁");

    // And back again, which is what makes the comparison a loop rather than a
    // one-way door.
    await user.click(screen.getByTestId("reflow-formula-crop-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("reflow-formula-item").dataset.renderMode).toBe("latex"),
    );
  });

  it("puts the number in its own right-hand slot (AC-P0-08)", async () => {
    backend({ formulas: formulas() });
    render(<App />);

    await screen.findByTestId("reflow-formula-item", {}, SLOW);
    const item = screen.getByTestId("reflow-formula-item");
    expect(item.className).toContain("grid-cols-[64px_1fr_64px]");
    expect(within(item).getByTestId("reflow-formula-number")).toHaveTextContent("(1)");
    expect(within(item).getByTestId("reflow-formula-number").parentElement?.className).toContain(
      "justify-end",
    );
  });

  it("copies the raw LaTeX, not the rendering (AC-P0-14)", async () => {
    backend({ formulas: formulas() });
    render(<App />);
    const user = userEvent.setup();
    // After `setup()`: userEvent installs a clipboard stub of its own, and one
    // written before it would be replaced without a word.
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (text: string) => written.push(text) },
    });

    await user.click(await screen.findByTestId("reflow-formula-copy", {}, SLOW));
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("\\mathcal{L}_{\\text{InfoNCE}}");
    expect(written[0]).not.toContain("AI 重建");
    expect(written[0]).not.toContain("(1)");
  });
});

describe("DS-DOC-010 · when it cannot be trusted", () => {
  it("shows the paper rather than LaTeX that does not parse (AC-P0-06)", async () => {
    const broken = formulas();
    broken.formulas[0]!.latex = "\\frac{1}{2";
    backend({ formulas: broken });
    render(<App />);

    const item = await screen.findByTestId("reflow-formula-item", {}, SLOW);
    await waitFor(() => expect(item.dataset.renderMode).toBe("crop"));
    // Not displayed as text, and not displayed as a broken formula either.
    expect(screen.queryByTestId("reflow-formula-math")).toBeNull();
    expect(screen.queryByText(/\\frac/)).toBeNull();
  });

  it("shows the paper when the model refused, and says why (AC-P0-05)", async () => {
    const refused = formulas({ status: "PARTIAL", reconstructed_count: 0, refused_count: 1 });
    refused.formulas[0] = {
      ...refused.formulas[0]!,
      status: "refusal",
      latex: "",
      refusal_reason: "字形无法辨识",
    };
    backend({ formulas: refused });
    render(<App />);

    const item = await screen.findByTestId("reflow-formula-item", {}, SLOW);
    await waitFor(() => expect(item.dataset.renderMode).toBe("crop"));
    expect(screen.getByTestId("reflow-formula-badge")).toHaveTextContent("未重建");
    expect(screen.getByText("字形无法辨识")).toBeInTheDocument();
  });

  it("falls back to the crop when even the legible floor is too wide (AC-P0-10)", async () => {
    // jsdom has no layout: the surface's natural width is stubbed to something
    // no column could hold, which is the case the floor exists for.
    const spy = vi
      .spyOn(HTMLElement.prototype, "scrollWidth", "get")
      .mockReturnValue(4000);
    backend({ formulas: formulas() });
    render(<App />);

    const item = await screen.findByTestId("reflow-formula-item", {}, SLOW);
    await waitFor(() => expect(item.dataset.renderMode).toBe("crop"));
    expect(screen.getByTestId("reflow-formula-badge")).toHaveTextContent("公式过长");
    spy.mockRestore();
  });
});

describe("DS-DOC-010 · a paper reconstructed before this tranche", () => {
  it("reads normally, shows the paper's formulas, and offers the upgrade (AC-P0-03, AC-P0-13)", async () => {
    const calls = backend({ formulas: null });
    render(<App />);

    // The reading works, from its own cache, with no reconstruction anywhere.
    expect(await screen.findByTestId("reflow-translation", {}, SLOW)).toBeInTheDocument();
    expect(screen.queryByTestId("reflow-formula-math")).toBeNull();
    expect(screen.getByTestId("reflow-crop")).toBeInTheDocument();

    const banner = screen.getByTestId("reflow-formulas-upgrade");
    expect(banner).toHaveTextContent("检测到 7 处公式");
    expect(banner).toHaveTextContent("1 次请求");
    // Nothing has been spent: reading is free, and so is being offered this.
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
  });

  it("reconstructs only when the reader presses the button (AC-P0-13)", async () => {
    const calls = backend({ formulas: null });
    render(<App />);
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("reflow-formulas-generate", {}, SLOW));
    await waitFor(() =>
      expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(1),
    );
    expect(calls.filter((call) => call.startsWith("POST"))[0]).toContain("/formulas");
  });
});

describe("DS-DOC-010 · the component on its own", () => {
  it("reserves the crop's place while the renderer is still arriving", () => {
    render(
      <FormulaItem
        latex={null}
        number={null}
        pageNumber={1}
        blockId="b_fx"
        availableWidthPx={552}
        crop={<div data-testid="the-crop" />}
      />,
    );
    // No reconstruction is not an error: the paper is what is shown, and it says so.
    expect(screen.getByTestId("the-crop")).toBeInTheDocument();
    expect(screen.getByTestId("reflow-formula-badge")).toHaveTextContent("未重建");
  });
});
