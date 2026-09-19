/**
 * DS-QA-013 — annotating the canonical source ParagraphIR excludes.
 *
 * The two things this file exists to hold apart:
 *
 * **The annotation domain is wider than the QA domain.** A drag across a figure
 * caption maps to no paragraph, so it is not a question and Selection QA must
 * stay unavailable — and it is still a note the reader is entitled to make. A
 * refactor that collapsed the two would look like a simplification and would
 * either refuse the note or admit the caption as evidence.
 *
 * **One order across two structures.** Paragraphs come from a reading-order
 * list, blocks from a per-page one. A note spanning a paragraph and the caption
 * beneath it must read the way the page does, not "all paragraphs, then all
 * captions".
 */
import { describe, expect, it } from "vitest";

import type { DocumentIr, IrBlock, IrParagraph } from "@/api/ir";
import { buildScope, scopeAvailability } from "@/qa/session";
import {
  ANCHORABLE_BLOCK_CLASSES,
  anchorableBlocks,
  buildAnnotationTargets,
  sourceOrderKey,
} from "@/notes/targets";

function block(
  id: string,
  page: number,
  top: number,
  text: string,
  layout_class = "figure_caption",
): IrBlock {
  return {
    id, page_number: page, layout_class,
    bbox: [50, top, 545, top + 30], text,
    source_anchor_id: `anchor_${id}`,
  };
}

function paragraph(id: string, page: number, top: number, text: string): IrParagraph {
  return {
    id, source_anchor_id: `anchor_${id}`, section_id: null, text,
    page_number: page, page_range: [page, page],
    block_ids: [], bboxes: [[50, top, 545, top + 40]],
  };
}

function ir(paragraphs: IrParagraph[], blocks: IrBlock[]): DocumentIr {
  const pages = new Map<number, IrBlock[]>();
  for (const item of blocks) {
    pages.set(item.page_number, [...(pages.get(item.page_number) ?? []), item]);
  }
  return {
    document_id: "doc_1", content_hash: "hash", page_count: 1,
    paragraphs,
    pages: [...pages.entries()].map(([page_number, list]) => ({
      page_number, width_pt: 595, height_pt: 842, rotation: 0, blocks: list,
    })),
  };
}

/** A selection covering a rectangle on one page. */
const covering = (page: number, top: number, bottom: number) => ({
  rects: { [page]: [[50, top, 545, bottom]] as [number, number, number, number][] },
  text: "",
});

describe("DS-QA-013 · which blocks may be annotated", () => {
  it("keeps the measured four and nothing else", () => {
    expect([...ANCHORABLE_BLOCK_CLASSES].sort()).toEqual([
      "figure_caption", "formula_caption", "isolate_formula", "table_caption",
    ]);
  });

  it("offers no anchor for a class outside the set", () => {
    /* `figure` and `table` hold run-together fragments — a real figure block's
       text layer read `"identityweight layerweight layerrelu…"` — and `abandon`
       is the arXiv stamp and the page numbers. */
    const document = ir([], [
      block("b1", 1, 100, "Figure 1. Training error."),
      block("b2", 1, 200, "identityweight layerweight layer", "figure"),
      block("b3", 1, 300, "arXiv:1512.03385v1", "abandon"),
      block("b4", 1, 400, "greatly benefited from very deep models.", "title"),
    ]);
    expect(anchorableBlocks(document).map((item) => item.id)).toEqual(["b1"]);
  });

  it("skips a block whose text is blank, because there is nothing to anchor to", () => {
    const document = ir([], [block("b1", 1, 100, "   "), block("b2", 1, 200, "Real.")]);
    expect(anchorableBlocks(document).map((item) => item.id)).toEqual(["b2"]);
  });
});

describe("DS-QA-013 · building targets from a drag", () => {
  const prose = paragraph("p_1", 1, 100, "A body paragraph with real words in it.");
  const caption = block("b_1", 1, 200, "Figure 1. Training error on CIFAR-10.");

  it("makes a target for a caption the selection covered", () => {
    const document = ir([prose], [caption]);
    const targets = buildAnnotationTargets(document, {
      ...covering(1, 195, 235),
      text: "Figure 1. Training error on CIFAR-10.",
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]!.sourceClass).toBe("figure_caption");
    expect(targets[0]!.sourceAnchorId).toBe("anchor_b_1");
    // The block's canonical text, not the drag's: that is what a reattachment
    // matches against, and it is what the panel shows.
    expect(targets[0]!.quote).toBe("Figure 1. Training error on CIFAR-10.");
  });

  it("makes a paragraph target from the same drag geometry", () => {
    const document = ir([prose], [caption]);
    const targets = buildAnnotationTargets(document, {
      ...covering(1, 95, 145),
      text: "A body paragraph with real words in it.",
    });
    expect(targets.map((target) => target.sourceClass)).toEqual(["paragraph"]);
  });

  it("orders a mixed selection by the page, not by the kind", () => {
    /* Paragraph at y=100, caption at y=200 — the caption is below it, and the
       note must read that way. Sorting by kind would put every caption after
       every paragraph, which is an order no page has. */
    const document = ir([prose], [caption]);
    const text = "A body paragraph with real words in it. Figure 1. Training error on CIFAR-10.";
    const targets = buildAnnotationTargets(document, {
      rects: {
        1: [[50, 95, 545, 145], [50, 195, 545, 235]],
      },
      text,
    });
    expect(targets.map((target) => target.sourceClass)).toEqual([
      "paragraph", "figure_caption",
    ]);
    expect(targets[0]!.pageNumber).toBe(1);
  });

  it("orders a caption above a paragraph as the page reads", () => {
    const body = paragraph("p_1", 1, 300, "Text that sits beneath the caption.");
    const above = block("b_1", 1, 200, "Figure 1. A caption above the text.");
    const document = ir([body], [above]);
    const targets = buildAnnotationTargets(document, {
      rects: { 1: [[50, 195, 545, 350]] },
      text: "Figure 1. A caption above the text. Text that sits beneath the caption.",
    });
    expect(targets.map((target) => target.sourceClass)).toEqual([
      "figure_caption", "paragraph",
    ]);
  });

  it("makes no target for a class that is not annotatable", () => {
    /* The selection is a real overlap and a refusal. `figure` text is a jumble
       of diagram labels, and persisting it would store a sentence nobody wrote. */
    const figure = block("b_1", 1, 100, "identityweight layerreluF(x)", "figure");
    const document = ir([], [figure]);
    const targets = buildAnnotationTargets(document, {
      ...covering(1, 95, 135),
      text: "identityweight layerreluF(x)",
    });
    expect(targets).toEqual([]);
  });

  it("does not make a target for a caption the drag did not reach", () => {
    const far = block("b_1", 1, 600, "Figure 9. Somewhere else entirely.");
    const document = ir([prose], [far]);
    const targets = buildAnnotationTargets(document, {
      ...covering(1, 95, 145),
      text: "A body paragraph with real words in it.",
    });
    expect(targets.map((target) => target.sourceClass)).toEqual(["paragraph"]);
  });

  it("needs the text to support it, not only the geometry", () => {
    /* The rule the paragraph matcher already applies, for the same reason: a
       caption's rectangle is a real overlap and a false identity when the reader
       selected the table beside it. */
    const document = ir([], [caption]);
    const targets = buildAnnotationTargets(document, {
      ...covering(1, 195, 235),
      text: "A completely different sentence about something else.",
    });
    expect(targets).toEqual([]);
  });

  it("gives each target its own page and its own geometry", () => {
    const pageOne = block("b_1", 1, 200, "Figure 1. First page caption.");
    const pageTwo = block("b_2", 2, 200, "Figure 2. Second page caption.");
    const document = ir([], [pageOne, pageTwo]);
    const targets = buildAnnotationTargets(document, {
      rects: {
        1: [[50, 195, 545, 235]],
        2: [[50, 195, 545, 235]],
      },
      text: "Figure 1. First page caption. Figure 2. Second page caption.",
    });
    expect(targets.map((target) => [target.pageNumber, target.sourceAnchorId]))
      .toEqual([[1, "anchor_b_1"], [2, "anchor_b_2"]]);
  });
});

describe("DS-QA-013 · the two domains stay apart", () => {
  it("leaves Selection QA unavailable for a caption that notes may annotate", () => {
    /* The boundary this task exists to hold. The caption is a real annotatable
     * source and it is not paper evidence: a reader asking a question about a
     * figure caption must be told there is nothing to scope to, not answered
     * from a caption that was never in the retrieval corpus. */
    const scope = buildScope("selection", 1, {
      status: "valid", paragraphIds: [], pages: [1], text: "", truncated: false,
      rects: {}, reason: "",
    });
    expect(scope).toBeNull();

    expect(scopeAvailability(1, {
      status: "non_prose", paragraphIds: [], pages: [1], text: "", truncated: false,
      rects: {}, reason: "",
    }).selection).toBe(false);
  });

  it("never places a block anchor in the paragraph scope", () => {
    /* The drag's text has to be long enough for the same support rule the
       paragraph matcher applies — a five-word selection is only accepted when it
       contains the source verbatim, which is the rule that stops a stray overlap
       becoming an identity. */
    const document = ir(
      [paragraph("p_1", 1, 100, "A body paragraph with several words in it.")],
      [block("b_1", 1, 200, "Figure 1. Training error on CIFAR-10.")],
    );
    const targets = buildAnnotationTargets(document, {
      rects: { 1: [[50, 95, 545, 235]] },
      text: "A body paragraph with several words in it. Figure 1. Training error on CIFAR-10.",
    });
    const paragraphIds = document.paragraphs.map((item) => item.id);
    for (const target of targets) {
      if (target.sourceClass === "paragraph") {
        expect(paragraphIds).toContain(target.sourceAnchorId.replace("anchor_", ""));
      }
    }
    // And the block target's anchor is not a paragraph's, so a scope built from
    // paragraph ids cannot reach it.
    expect(targets.some((target) => target.sourceAnchorId === "anchor_b_1")).toBe(true);
    expect(paragraphIds).not.toContain("b_1");
  });
});

describe("DS-QA-013 · the shared order key", () => {
  it("is monotone in page and in position", () => {
    expect(sourceOrderKey(1, 100)).toBeLessThan(sourceOrderKey(1, 200));
    expect(sourceOrderKey(1, 900)).toBeLessThan(sourceOrderKey(2, 0));
  });
});
