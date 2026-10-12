/**
 * The reflowed reading over a MinerU parse, and translation as a background job.
 *
 * What is checked is what a reader would notice if it broke: a formula shown as
 * `$…$` source, a table that runs a script, a figure drawn as a blurry crop when
 * the paper's own image exists, a job that never stops polling.
 */
import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BilingualView } from "@/api/bilingual";
import type { DocumentIr } from "@/api/ir";
import { MathText, splitMath, styledSegments } from "@/bilingual/reflow/MathText";
import { sanitizeTableHtml, tableToText } from "@/bilingual/reflow/Recovered";
import { reflowStream } from "@/bilingual/reflow/stream";
import { generateBilingual } from "@/bilingual/session";
import { useWorkspaceStore } from "@/stores/workspace";
import { seedDocument, TEST_DOCUMENT_ID } from "@/tests/fixtures";

const HASH = "h".repeat(64);

function mineruIr(): DocumentIr {
  const block = (id: string, layout_class: string, extra: Record<string, unknown> = {}) => ({
    id, page_number: 1, layout_class, bbox: [10, 10, 100, 50] as [number, number, number, number],
    text: "", source_anchor_id: "", caption_of: null, ...extra,
  });
  return {
    document_id: TEST_DOCUMENT_ID,
    content_hash: HASH,
    pipeline_version: "mineru-1",
    source_filename: "paper.pdf",
    page_count: 1,
    metadata: { title: "Paper" },
    sections: [],
    pages: [
      {
        page_number: 1, width_pt: 600, height_pt: 800, rotation: 0,
        blocks: [
          block("b1", "plain text", { text: "We fit $F(x)$ here." }),
          block("b2", "isolate_formula", { text: "y = F(x) + x", latex: "y = F(x) + x" }),
          block("b3", "figure", { image_path: "images/fig1.jpg" }),
          block("b4", "figure_caption", { text: "Figure 1. Error.", caption_of: "b3" }),
          block("b5", "table", { html: "<table><tr><td>a</td></tr></table>" }),
          block("b6", "code", { text: "def f(): pass" }),
        ],
      },
    ],
    paragraphs: [
      {
        id: "p1", section_id: null, text: "We fit $F(x)$ here.", page_number: 1,
        page_range: [1, 1], block_ids: ["b1"], bboxes: [[10, 10, 100, 50]],
        is_abstract: false, source_anchor_id: "a1",
      },
    ],
    page_mapping: { p1: 1 },
    has_text_layer: true,
    ocr_required: false,
  } as unknown as DocumentIr;
}

describe("inline math", () => {
  it("splits formulas out of prose and leaves escaped dollars alone", () => {
    expect(splitMath("Let $F(x)$ be $x$.")).toEqual([
      { kind: "text", text: "Let " },
      { kind: "math", latex: "F(x)" },
      { kind: "text", text: " be " },
      { kind: "math", latex: "x" },
      { kind: "text", text: "." },
    ]);
    expect(splitMath("costs \\$5")).toEqual([{ kind: "text", text: "costs \\$5" }]);
  });
});

describe("table HTML from the parser", () => {
  it("keeps structure and spans, drops anything that could run or load", () => {
    const clean = sanitizeTableHtml(
      '<table onclick="x()"><tr><td colspan="2" style="color:red">a<script>alert(1)</script></td>' +
        '<td><img src="http://evil/x.png" onerror="y()">b</td><td><a href="http://evil">c</a></td></tr></table>',
    );
    expect(clean).toContain('colspan="2"');
    expect(clean).not.toMatch(/onclick|onerror|script|style|<img|<a |href/);
    expect(clean).toContain("b");
    expect(clean).toContain("c");
  });
});

describe("the paper's own emphasis", () => {
  it("cuts the text at its runs and loses nothing", () => {
    const text = "Residual Representations. In image recognition, VLAD1 is a representation.";
    const runs = [
      { start: 52, end: 53, styles: ["superscript"] },
      { start: 0, end: 25, styles: ["bold"] },
      { start: 10, end: 20, styles: ["italic"] }, // overlaps the first: ignored
      { start: 70, end: 999, styles: ["bold"] }, // past the end: ignored
    ];
    const segments = styledSegments(text, runs);
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
    expect(segments.filter((segment) => segment.styles.length > 0)).toEqual([
      { text: "Residual Representations.", styles: ["bold"] },
      { text: "1", styles: ["superscript"] },
    ]);
  });

  it("sets a run-in heading in bold and a footnote mark above the line", () => {
    const text = "Plain Network. Our baselines2 follow VGG.";
    const { container } = render(
      <p>
        <MathText
          text={text}
          runs={[{ start: 0, end: 14, styles: ["bold"] }, { start: 28, end: 29, styles: ["superscript"] }]}
        />
      </p>,
    );
    expect(container.querySelector("strong")).toHaveTextContent("Plain Network.");
    expect(container.querySelector("sup")).toHaveTextContent("2");
    expect(container.textContent).toBe(text);
  });
});

describe("table presentation", () => {
  const cell = (clean: string, row: number, column: number) => {
    const holder = document.createElement("div");
    holder.innerHTML = clean;
    return holder.querySelectorAll("tr")[row]!.children[column]!;
  };

  it("right-aligns a column only when every value in it is a number", () => {
    const clean = sanitizeTableHtml(
      "<table><tr><td>model</td><td>top-1 err.</td><td>FLOPs</td><td>note</td></tr>" +
        "<tr><td>plain-18</td><td>27.94</td><td>1.8×10<sup>9</sup></td><td>baseline</td></tr>" +
        "<tr><td>ResNet-34</td><td>25.03</td><td>3.6×10<sup>9</sup></td><td>-</td></tr>" +
        "<tr><td>ResNet-152</td><td>21.43 ± 0.2</td><td>11.3×10<sup>9</sup></td><td>ours</td></tr></table>",
    );
    expect(cell(clean, 1, 1).hasAttribute("data-num")).toBe(true);
    expect(cell(clean, 0, 1).hasAttribute("data-num")).toBe(true); // the header sits over its digits
    expect(cell(clean, 1, 0).hasAttribute("data-num")).toBe(false); // row names
    expect(cell(clean, 1, 3).hasAttribute("data-num")).toBe(false); // words
  });

  it("leaves a table with merged cells as it was, and drops glyphs that only a PDF font can draw", () => {
    const merged = sanitizeTableHtml(
      '<table><tr><td rowspan="2">a</td><td>1</td></tr><tr><td>2</td></tr><tr><td>b</td><td>3</td></tr></table>',
    );
    expect(merged).not.toContain("data-num");
    expect(sanitizeTableHtml("<table><tr><td>\uF8EE3×3, 64\uF8F9×2</td></tr></table>")).toContain(
      "<td>3×3, 64×2</td>",
    );
  });

  it("copies as tab-separated rows a spreadsheet will take", () => {
    expect(tableToText("<table><tr><td>model</td><td>err.</td></tr><tr><td>ResNet-34</td><td> 25.03 </td></tr></table>"))
      .toBe("model\terr.\nResNet-34\t25.03");
  });
});

describe("the reflow stream over a MinerU parse", () => {
  it("carries LaTeX, table cells, the image and code onto the items", () => {
    const items = reflowStream(mineruIr(), null);
    const crops = items.filter((item) => item.kind === "crop");
    const by = Object.fromEntries(crops.map((c) => [c.kind === "crop" ? c.layoutClass : "", c]));
    expect(by.isolate_formula).toMatchObject({ latex: "y = F(x) + x" });
    expect(by.figure).toMatchObject({ imagePath: "images/fig1.jpg", caption: { text: "Figure 1. Error." } });
    expect(by.table).toMatchObject({ html: "<table><tr><td>a</td></tr></table>" });
    expect(by.code).toMatchObject({ code: "def f(): pass" });
  });
});

describe("translating as a background job", () => {
  const view = (job: Record<string, unknown> | null, translated: string): BilingualView =>
    ({
      status: job?.status === "running" ? "PARTIAL" : "READY",
      cached: false,
      content_hash: HASH,
      target_language: "zh-CN",
      provider_model: "m",
      created_at: "",
      input_tokens: null,
      output_tokens: null,
      notes: [],
      total_paragraphs: 1,
      translated_paragraphs: translated ? 1 : 0,
      sections: [],
      blocks: [],
      paragraphs: [
        {
          paragraph_id: "p1", page_number: 1, section_id: null, source_text: "We fit.",
          translated_text: translated, status: translated ? "translated" : "pending",
          note: "", bboxes: [],
        },
      ],
      job: job as never,
    }) as BilingualView;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    useWorkspaceStore.setState({ document: seedDocument(), profileId: "prof_1" });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("starts a job, shows the reading as it fills in, and stops polling when it finishes", async () => {
    const reads = [
      view({ status: "running", done_batches: 0, total_batches: 2 }, ""),
      view({ status: "completed", done_batches: 2, total_batches: 2 }, "我们拟合。"),
    ];
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${String(url).replace(/^.*\/api/, "/api")}`);
        if (init?.method === "POST") {
          return new Response(JSON.stringify({ status: "running", done_batches: 0, total_batches: 2 }), {
            status: 202, headers: { "Content-Type": "application/json" },
          });
        }
        const body = reads.length > 1 ? reads.shift() : reads[0];
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );

    const running = generateBilingual();
    await vi.advanceTimersByTimeAsync(0);
    expect(useWorkspaceStore.getState().bilingual?.paragraphs[0]?.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(2000);
    const outcome = await running;

    expect(outcome).toEqual({ ok: true });
    expect(useWorkspaceStore.getState().bilingual?.paragraphs[0]?.translated_text).toBe("我们拟合。");
    expect(useWorkspaceStore.getState().bilingualStatus).toBe("ready");
    expect(calls[0]).toBe(`POST /api/documents/${TEST_DOCUMENT_ID}/bilingual-text/jobs`);
    expect(calls.filter((c) => c.startsWith("GET"))).toHaveLength(2);
  });

  it("falls back to the one-request generation on a backend without jobs", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = String(url).replace(/^.*\/api/, "/api");
        calls.push(`${init?.method ?? "GET"} ${path}`);
        if (path.endsWith("/jobs")) return new Response("", { status: 404 });
        return new Response(JSON.stringify(view(null, "我们拟合。")), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }),
    );
    expect(await generateBilingual()).toEqual({ ok: true });
    expect(calls).toEqual([
      `POST /api/documents/${TEST_DOCUMENT_ID}/bilingual-text/jobs`,
      `POST /api/documents/${TEST_DOCUMENT_ID}/bilingual-text`,
    ]);
  });

  it("names a job that failed half-way and keeps what it translated", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          return new Response(JSON.stringify({ status: "running" }), {
            status: 202, headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify(view({ status: "failed", message: "key refused" }, "我们拟合。")),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const outcome = await generateBilingual();
    expect(outcome.ok).toBe(false);
    expect(useWorkspaceStore.getState().bilingualError).toContain("key refused");
    expect(useWorkspaceStore.getState().bilingual?.paragraphs[0]?.translated_text).toBe("我们拟合。");
  });
});
