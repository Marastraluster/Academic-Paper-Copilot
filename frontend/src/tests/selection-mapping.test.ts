import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { IrParagraph } from "@/api/ir";
import {
  MAX_SELECTED_PARAGRAPHS,
  matchParagraphs,
  normalizeText,
  readDomSelection,
  textSupports,
  toPdfRects,
  type PdfRect,
} from "@/qa/selection";

/**
 * The mapping rules, tested without a browser.
 *
 * The transform and the matching are separated deliberately, because they fail in
 * different ways: a transform error puts a selection on the wrong *place*, a
 * matching error puts it on the wrong *paragraph*, and a test that exercised both
 * at once would not say which had happened.
 */

/** A page 612x792 pt — US Letter, the size the ResNet paper actually is. */
const PAGE = { width_pt: 612, height_pt: 792, rotation: 0 };

/** ResNet's real two-column geometry, measured from the IR. */
const LEFT_COLUMN = { x0: 49, x1: 287 };
const RIGHT_COLUMN = { x0: 310, x1: 548 };

function paragraph(
  id: string,
  page: number,
  box: { x0: number; y0: number; x1: number; y1: number },
  text: string,
): IrParagraph {
  return {
    id,
    section_id: "s1",
    text,
    page_number: page,
    page_range: [page, page],
    block_ids: [`b_${id}`],
    bboxes: [[box.x0, box.y0, box.x1, box.y1]],
  };
}

const rect = (x0: number, y0: number, x1: number, y1: number): PdfRect => ({ x0, y0, x1, y1 });

describe("DS-QA-005 · the coordinate transform", () => {
  it("inverts the highlight transform at any scale", () => {
    // The page container sits at (365, 109) on screen; a fragment 263.234 px into
    // it, at fit-width's measured scale of 1.7156862, is 153.4 pt into the page.
    // These are the real numbers the probe produced.
    const scale = 1.7156862745098038;
    const [box] = toPdfRects(
      [{ left: 365 + 263.234, top: 109 + 180.438, width: 311.56, height: 14 }],
      { left: 365, top: 109 },
      scale,
      PAGE,
    );

    expect(box!.x0).toBeCloseTo(153.4, 1);
    expect(box!.y0).toBeCloseTo(105.2, 1);
  });

  it("gives the same PDF points at every zoom", () => {
    const fragment = { width: 200, height: 14 };
    const at = (scale: number) =>
      toPdfRects(
        [{ left: 100 * scale, top: 40 * scale, ...fragment }],
        { left: 0, top: 0 },
        scale,
        PAGE,
      )[0]!;

    const [one, two, three] = [at(1), at(2), at(0.75)];
    expect(one.x0).toBeCloseTo(100, 6);
    expect(two.x0).toBeCloseTo(100, 6);
    expect(three.x0).toBeCloseTo(100, 6);
    expect(one.y0).toBeCloseTo(40, 6);
  });

  it("drops fragments too small to be a line of text", () => {
    const boxes = toPdfRects(
      [
        { left: 0, top: 0, width: 1, height: 20 }, // a sliver
        { left: 0, top: 30, width: 100, height: 12 },
      ],
      { left: 0, top: 0 },
      1,
      PAGE,
    );
    expect(boxes).toHaveLength(1);
  });

  it("refuses a page with no usable scale rather than dividing by zero", () => {
    expect(toPdfRects([{ left: 0, top: 0, width: 10, height: 10 }], { left: 0, top: 0 }, 0, PAGE))
      .toEqual([]);
  });

  it("refuses to map a rotated page rather than guessing (AC-02)", () => {
    // The affine inverse was implemented, measured against a real /Rotate 90
    // fixture, and removed: the drag mapped to nothing, and the two coordinate
    // conventions involved could not be reconciled by inspection. A wrong inverse
    // returns a confidently wrong paragraph, which is worse than none — so a
    // rotated page maps to nothing and Selection stays unavailable.
    for (const rotation of [90, 180, 270]) {
      expect(
        toPdfRects(
          [{ left: 10, top: 20, width: 100, height: 12 }],
          { left: 0, top: 0 },
          1,
          { ...PAGE, rotation },
        ),
      ).toEqual([]);
    }
  });

  it("still maps an unrotated page, so the refusal is only about rotation", () => {
    expect(
      toPdfRects(
        [{ left: 10, top: 20, width: 100, height: 12 }],
        { left: 0, top: 0 },
        1,
        PAGE,
      ),
    ).toHaveLength(1);
  });
});

describe("DS-QA-005 · normalization", () => {
  it("decomposes ligatures and strips soft hyphens", () => {
    expect(normalizeText("deﬁne the ﬂow")).toBe("define the flow");
    expect(normalizeText("soft­hyphen")).toBe("softhyphen");
  });

  it("rejoins a word broken across a line by a hyphen", () => {
    expect(normalizeText("multi-\ntask learning")).toBe("multitask learning");
  });

  it("keeps identifiers distinguishable", () => {
    // The tokens that must survive normalization intact.
    for (const token of ["ResNet-50", "CIFAR-10", "F(x)"]) {
      expect(normalizeText(token)).toContain(token.toLowerCase());
    }
  });
});

describe("DS-QA-005 · the text validator", () => {
  it("accepts a short selection that appears in the paragraph", () => {
    expect(textSupports("residual learning", "We adopt residual learning here.")).toBe(true);
  });

  it("accepts a long selection whose words mostly appear", () => {
    const selected =
      "when deeper networks are able to start converging a degradation problem has been exposed";
    const paragraphText =
      "When deeper networks are able to start converging, a degradation problem has been exposed: " +
      "with the network depth increasing, accuracy gets saturated.";
    expect(textSupports(selected, paragraphText)).toBe(true);
  });

  it("rejects a figure's axis labels", () => {
    // The shape a real mis-drag produced: numeric ticks and an axis caption.
    const axis = "0 1 2 3 4 5 6 0 10 20 iter. (1e4) training error (%)";
    const paragraphText =
      "We adopt residual learning to solve the degradation problem in deep networks.";
    expect(textSupports(axis, paragraphText)).toBe(false);
  });

  it("rejects a short selection that does not appear at all", () => {
    expect(textSupports("quantum chromodynamics", "Residual learning reformulates it.")).toBe(false);
  });
});

describe("DS-QA-005 · the pane guard", () => {
  /** A page container inside a pane, with a selectable span. */
  function pane(testId: string, pageNumber: number, text: string) {
    const viewer = document.createElement("section");
    viewer.dataset.testid = testId;
    const container = document.createElement("div");
    container.dataset.testid = "pdf-page-container";
    container.dataset.pageNumber = String(pageNumber);
    const span = document.createElement("span");
    span.textContent = text;
    container.append(span);
    viewer.append(container);
    document.body.append(viewer);
    return span;
  }

  // jsdom has no layout, so a Range reports no client rects at all and the
  // reader would see nothing selected. A plausible fragment is enough here: what
  // this suite asks is *which pane* a selection is in, not where it is on the
  // page, and the geometry is covered by the suites above.
  const rects = Range.prototype.getClientRects;
  beforeAll(() => {
    Range.prototype.getClientRects = function getClientRects(this: Range) {
      return [
        {
          x: 100, y: 100, left: 100, top: 100, width: 50, height: 12,
          right: 150, bottom: 112, toJSON: () => ({}),
        },
      ] as unknown as DOMRectList;
    };
  });
  afterAll(() => {
    Range.prototype.getClientRects = rects;
  });

  afterEach(() => {
    document.body.replaceChildren();
    window.getSelection()?.removeAllRanges();
  });

  it("recognises a selection inside the original pane", () => {
    const span = pane("viewer-original", 3, "the left pane text");
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const dom = readDomSelection(selection);

    expect(dom.isCollapsed).toBe(false);
    expect(dom.translatedPane).toBe(false);
    expect(dom.byPage[0]?.page).toBe(3);
  });

  it("flags a selection inside the translated pane (AC-07)", () => {
    // The translated PDF is re-laid-out: its geometry is not the source's, and
    // there is no validated mapping between them. A selection here must never
    // become source Selection QA.
    const span = pane("viewer-translated", 3, "译文窗格中的文本");
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(readDomSelection(selection).translatedPane).toBe(true);
  });

  it("treats a collapsed selection as nothing selected (AC-06)", () => {
    expect(readDomSelection(window.getSelection()).isCollapsed).toBe(true);
    expect(readDomSelection(null).isCollapsed).toBe(true);
  });
});

describe("DS-QA-005 · geometry to paragraph", () => {
  const left = paragraph("p_left", 3, { ...LEFT_COLUMN, y0: 100, y1: 160 }, "The left column paragraph text.");
  const right = paragraph("p_right", 3, { ...RIGHT_COLUMN, y0: 100, y1: 160 }, "The right column paragraph text.");

  it("maps a selection inside one paragraph", () => {
    const mapping = matchParagraphs(
      new Map([[3, [rect(55, 105, 280, 118)]]]),
      [left, right],
      "left column",
    );

    expect(mapping.status).toBe("valid");
    expect(mapping.paragraphIds).toEqual(["p_left"]);
  });

  it("does not let a two-column neighbour cross-contaminate (AC-03)", () => {
    // The failure this rule exists for: a selection whose *overall* box would
    // span the gutter, but whose line fragments do not.
    const mapping = matchParagraphs(
      new Map([[3, [rect(55, 105, 280, 118)]]]),
      [left, right],
      "left column paragraph",
    );

    expect(mapping.paragraphIds).not.toContain("p_right");
  });

  it("maps a selection that genuinely spans two paragraphs", () => {
    const second = paragraph("p_second", 3, { ...LEFT_COLUMN, y0: 170, y1: 230 }, "A second paragraph follows.");
    const mapping = matchParagraphs(
      new Map([[3, [rect(55, 105, 280, 118), rect(55, 175, 280, 188)]]]),
      [left, second],
      "left column paragraph a second paragraph",
    );

    expect(mapping.paragraphIds).toEqual(["p_left", "p_second"]);
  });

  it("returns reading order whatever order the drag produced", () => {
    // A bottom-up drag reports its fragments bottom-first, and the ids must still
    // come back in the document's order rather than the browser's.
    const first = paragraph("p_a", 3, { ...LEFT_COLUMN, y0: 100, y1: 130 }, "Alpha paragraph text here.");
    const second = paragraph("p_b", 3, { ...LEFT_COLUMN, y0: 140, y1: 170 }, "Beta paragraph text here.");
    const mapping = matchParagraphs(
      new Map([[3, [rect(55, 145, 280, 158), rect(55, 105, 280, 118)]]]),
      [first, second],
      "Alpha paragraph text here. Beta paragraph text here.",
    );

    expect(mapping.paragraphIds).toEqual(["p_a", "p_b"]);
  });

  it("deduplicates an id touched by several line fragments", () => {
    const mapping = matchParagraphs(
      new Map([[3, [rect(55, 105, 280, 118), rect(55, 120, 280, 133), rect(55, 135, 280, 148)]]]),
      [left],
      "left column paragraph text",
    );

    expect(mapping.paragraphIds).toEqual(["p_left"]);
  });

  it("refuses a selection that only touches a figure", () => {
    const figure = paragraph("p_fig", 3, { ...LEFT_COLUMN, y0: 400, y1: 500 }, "");
    const mapping = matchParagraphs(
      new Map([[3, [rect(55, 410, 280, 423)]]]),
      [figure],
      "0 10 20 iter. (1e4)",
    );

    expect(mapping.status).toBe("non_prose");
    expect(mapping.paragraphIds).toEqual([]);
  });

  it("resolves the same text twice on a page by geometry, not by text", () => {
    // Identical paragraphs, different places. Text alone cannot choose.
    const upper = paragraph("p_up", 3, { ...LEFT_COLUMN, y0: 100, y1: 130 }, "We evaluate on ImageNet.");
    const lower = paragraph("p_low", 3, { ...LEFT_COLUMN, y0: 400, y1: 430 }, "We evaluate on ImageNet.");

    const mapping = matchParagraphs(
      new Map([[3, [rect(55, 405, 280, 418)]]]),
      [upper, lower],
      "We evaluate on ImageNet.",
    );

    expect(mapping.paragraphIds).toEqual(["p_low"]);
  });

  it("resolves identical text on different pages by page", () => {
    const onPage3 = paragraph("p_p3", 3, { ...LEFT_COLUMN, y0: 100, y1: 130 }, "We evaluate on ImageNet.");
    const onPage7 = paragraph("p_p7", 7, { ...LEFT_COLUMN, y0: 100, y1: 130 }, "We evaluate on ImageNet.");

    const mapping = matchParagraphs(
      new Map([[7, [rect(55, 105, 280, 118)]]]),
      [onPage3, onPage7],
      "We evaluate on ImageNet.",
    );

    expect(mapping.paragraphIds).toEqual(["p_p7"]);
  });

  it("caps a selection that covers most of the paper", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      paragraph(`p_${index}`, 3, { ...LEFT_COLUMN, y0: 10 + index * 15, y1: 22 + index * 15 },
        `Paragraph number ${index} of the paper text.`),
    );
    const rects = many.map((_, index) => rect(55, 12 + index * 15, 280, 20 + index * 15));

    const mapping = matchParagraphs(
      new Map([[3, rects]]),
      many,
      many.map((item) => item.text).join(" "),
    );

    expect(mapping.paragraphIds).toHaveLength(MAX_SELECTED_PARAGRAPHS);
    expect(mapping.truncated).toBe(true);
    expect(mapping.status).toBe("partial");
  });

  it("returns nothing for empty geometry", () => {
    const mapping = matchParagraphs(new Map(), [left], "some text");
    expect(mapping.paragraphIds).toEqual([]);
  });
});
