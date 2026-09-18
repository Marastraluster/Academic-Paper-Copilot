/**
 * DS-QA-011 — a selection that crosses a page boundary.
 *
 * Three things are tested here and they are separate claims:
 *
 *   1. `readDomSelection` splits a two-page Range into page-local fragments
 *      with page-local geometry.
 *   2. `matchParagraphs` maps each page's own rects to that page's paragraphs.
 *   3. `buildAnnotationTargets` emits targets in canonical document order with
 *      each target's rects on its own page — regardless of which way the drag
 *      went.
 *
 * jsdom has no layout, so every span carries its own rectangle in
 * `data-rect` and `Range.getClientRects` is stubbed to read it. That is not a
 * stand-in for measurement — the real geometry was measured in a browser and is
 * recorded in `.agent/results/crosspage/probe.json`. What it buys is a
 * *deterministic* two-page DOM, which the browser cannot give: identical
 * fixtures, identical coordinates, every run.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { buildAnnotationTargets } from "@/notes/targets";
import { captureSelection } from "@/qa/session";
import {
  matchParagraphs,
  measurableChars,
  readDomSelection,
  toPdfRects,
  type PdfRect,
} from "@/qa/selection";
import { useWorkspaceStore } from "@/stores/workspace";
import { seedDocument } from "@/tests/fixtures";
import type { DocumentIr, IrPage, IrParagraph } from "@/api/ir";

const SCALE = 2;

/** A span whose text is `text` and whose client rect is `rect`. */
function span(page: HTMLElement, text: string, rect: [number, number, number, number]): Text {
  const element = document.createElement("span");
  element.dataset.rect = JSON.stringify(rect);
  const node = document.createTextNode(text);
  element.appendChild(node);
  page.querySelector(".textLayer")!.appendChild(element);
  return node;
}

/** A page container with a text layer, as `PdfPage` renders one. */
function pageElement(pageNumber: number, translation = false, scale = SCALE): HTMLElement {
  const container = document.createElement("div");
  container.dataset.testid = "pdf-page-container";
  container.dataset.pageNumber = String(pageNumber);
  container.dataset.pageScale = String(scale);
  const layer = document.createElement("div");
  layer.className = "textLayer";
  container.appendChild(layer);
  if (translation) {
    const pane = document.createElement("div");
    pane.dataset.testid = "viewer-translated";
    pane.appendChild(container);
    document.body.appendChild(pane);
  } else {
    document.body.appendChild(container);
  }
  return container;
}

function selectRange(start: Node, startOffset: number, end: Node, endOffset: number): Selection {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

/**
 * A selection whose **anchor is later in the document than its focus** — what a
 * drag upward produces.
 *
 * `setBaseAndExtent` is the only way to express it: a `Range` is always
 * normalised to start ≤ end, so building one "backwards" with `setStart` after
 * `setEnd` just collapses it, which is how an earlier version of this test
 * measured nothing at all.
 */
function selectBackward(start: Node, startOffset: number, end: Node, endOffset: number): Selection {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.setBaseAndExtent(end, endOffset, start, startOffset);
  return selection;
}

/**
 * Stub `getClientRects` to return the span's declared rectangle.
 *
 * Only the *clamped* range is asked, and its start container is the text node
 * whose span holds the rectangle — which is exactly the property the real
 * implementation relies on.
 */
const originalRects = Range.prototype.getClientRects;
beforeAll(() => {
  Range.prototype.getClientRects = function getClientRects(this: Range) {
    const node = this.startContainer;
    const spanElement = node instanceof Element ? node : node.parentElement;
    const declared = spanElement instanceof HTMLElement ? spanElement.dataset.rect : undefined;
    if (!declared) return { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] } as never;
    const [left, top, width, height] = JSON.parse(declared) as [number, number, number, number];
    const rect = {
      left, top, width, height, x: left, y: top, right: left + width, bottom: top + height,
      toJSON: () => ({}),
    };
    return [rect] as unknown as DOMRectList;
  };
});

afterAll(() => {
  Range.prototype.getClientRects = originalRects;
});

afterEach(() => {
  document.body.replaceChildren();
  window.getSelection()?.removeAllRanges();
});

// --- canonical source fixture ------------------------------------------------

/** A4 at scale 2. Client coordinates are PDF points × 2. */
const A4 = { width_pt: 595, height_pt: 842 };

function irPage(page_number: number, rotation = 0): IrPage {
  return { page_number, ...A4, rotation, blocks: [] };
}

function irParagraph(
  id: string,
  page_number: number,
  bbox: [number, number, number, number],
  text: string,
): IrParagraph {
  return {
    id, source_anchor_id: `anchor_${id}`, section_id: null, text,
    page_number, page_range: [page_number, page_number],
    block_ids: [], bboxes: [bbox],
  };
}

function irWith(paragraphs: IrParagraph[], pages = [1, 2, 3]): DocumentIr {
  return {
    document_id: "doc_crosspage", content_hash: "hash", page_count: pages.length,
    paragraphs, pages: pages.map((n) => irPage(n)),
  };
}

/** PDF points → the client rectangle a span at that position reports. */
function clientRect(
  bbox: [number, number, number, number],
  pageTopClient: number,
  pageLeftClient: number,
): [number, number, number, number] {
  return [
    pageLeftClient + bbox[0] * SCALE,
    pageTopClient + bbox[1] * SCALE,
    (bbox[2] - bbox[0]) * SCALE,
    (bbox[3] - bbox[1]) * SCALE,
  ];
}

// Page 1 is drawn first, page 2 below it, as the reading stack is.
const PAGE1_TOP = 0;
const PAGE2_TOP = A4.height_pt * SCALE + 32;
const PAGE_LEFT = 100;

const TAIL_OF_P1: [number, number, number, number] = [72, 700, 500, 714];
const HEAD_OF_P2: [number, number, number, number] = [72, 50, 520, 64];

describe("DS-QA-011 · a two-page Range becomes page-local fragments", () => {
  function twoPageSelection() {
    const page1 = pageElement(1);
    const page2 = pageElement(2);
    const tail = span(page1, "the last line of page one", clientRect(TAIL_OF_P1, PAGE1_TOP, PAGE_LEFT));
    const head = span(page2, "the first line of page two", clientRect(HEAD_OF_P2, PAGE2_TOP, PAGE_LEFT));
    return { page1, page2, tail, head };
  }

  it("groups fragments by page and never merges them", () => {
    const { tail, head } = twoPageSelection();
    const dom = readDomSelection(
      selectRange(tail, 0, head, head.nodeValue!.length),
    );

    expect(dom.byPage.map((entry) => entry.page)).toEqual([1, 2]);
    expect(dom.crossPage).toBe(true);
    // One fragment per page, and each page's fragment is its own rectangle —
    // not one envelope spanning both pages.
    expect(dom.byPage[0]!.rects).toHaveLength(1);
    expect(dom.byPage[1]!.rects).toHaveLength(1);
    expect(dom.byPage[0]!.rects[0]!.top).toBe(PAGE1_TOP + TAIL_OF_P1[1] * SCALE);
    expect(dom.byPage[1]!.rects[0]!.top).toBe(PAGE2_TOP + HEAD_OF_P2[1] * SCALE);
  });

  it("keeps each page's own text, so the split is text as well as geometry", () => {
    const { tail, head } = twoPageSelection();
    const dom = readDomSelection(selectRange(tail, 0, head, head.nodeValue!.length));

    expect(dom.byPage[0]!.text).toContain("page one");
    expect(dom.byPage[0]!.text).not.toContain("page two");
    expect(dom.byPage[1]!.text).toContain("page two");
  });

  it("reports every character it measured, so an honest selection is complete", () => {
    const { tail, head } = twoPageSelection();
    const dom = readDomSelection(selectRange(tail, 0, head, head.nodeValue!.length));

    expect(dom.measuredChars).toBe(dom.reportedChars);
    expect(dom.measuredChars).toBe(
      measurableChars("the last line of page one" + "the first line of page two"),
    );
  });

  it("drops a page whose text layer was removed, instead of borrowing it", () => {
    /* The measured browser failure this exists for: a drag auto-scrolls, the
       virtualiser removes the page the selection started on, and the gesture
       ends. What survives is page 2 — and page 2 alone is what may be measured.

       **jsdom cannot reproduce the other half of it.** A real browser computes
       `Range.toString()` from node references, so the removed page's text is
       still reported (measured: 6388 characters against a first page that could
       no longer be measured at all). jsdom re-derives `toString()` from the live
       tree and quietly drops it, which is why the count comparison is asserted
       in `captureSelection`'s tests below rather than here. */
    const { page1, tail, head } = twoPageSelection();
    const selection = selectRange(tail, 0, head, head.nodeValue!.length);

    page1.querySelector(".textLayer")!.remove();

    const dom = readDomSelection(selection);
    expect(dom.byPage.map((entry) => entry.page)).toEqual([2]);
    expect(dom.byPage[0]!.text).toContain("page two");
  });

  it("never flags the translated pane for a source selection", () => {
    const page1 = pageElement(1);
    const page2 = pageElement(2);
    const tail = span(page1, "source text one", clientRect(TAIL_OF_P1, PAGE1_TOP, PAGE_LEFT));
    const head = span(page2, "source text two", clientRect(HEAD_OF_P2, PAGE2_TOP, PAGE_LEFT));

    expect(readDomSelection(selectRange(tail, 0, head, head.nodeValue!.length)).translatedPane)
      .toBe(false);
  });
});

describe("DS-QA-011 · each page is converted with its own transform", () => {
  it("converts a page-2 rect with page 2's viewport, not page 1's", () => {
    /* The defect this guards: one scale and one origin for the whole selection.
       Page 2 is 32 px lower on screen, so using page 1's origin would place its
       highlight 16 PDF points too high — and on a paper where the paragraph
       boundary happens to fall there, the note attaches to the wrong text. */
    const page2Rect = clientRect(HEAD_OF_P2, PAGE2_TOP, PAGE_LEFT);
    const converted = toPdfRects(
      [{ left: page2Rect[0], top: page2Rect[1], width: page2Rect[2], height: page2Rect[3] }],
      { left: PAGE_LEFT, top: PAGE2_TOP },
      SCALE,
      irPage(2),
    );

    expect(converted).toHaveLength(1);
    expect(converted[0]!.x0).toBeCloseTo(HEAD_OF_P2[0], 6);
    expect(converted[0]!.y0).toBeCloseTo(HEAD_OF_P2[1], 6);
    expect(converted[0]!.x1).toBeCloseTo(HEAD_OF_P2[2], 6);
    expect(converted[0]!.y1).toBeCloseTo(HEAD_OF_P2[3], 6);
  });

  it("is unchanged by zoom, because the scale is the only thing that moves", () => {
    const paragraph = irParagraph("p_0002", 2, HEAD_OF_P2, "the first line of page two");
    const atOne = toPdfRects(
      [{ left: 244, top: 250, width: 896, height: 28 }],
      { left: 100, top: 150 },
      2,
      irPage(2),
    );
    const atHalf = toPdfRects(
      [{ left: 172, top: 200, width: 448, height: 14 }],
      { left: 100, top: 150 },
      1,
      irPage(2),
    );
    expect(atOne).toEqual(atHalf);
    expect(atOne[0]!.y0).toBeCloseTo(HEAD_OF_P2[1], 6);
    // ...and both map to the same paragraph.
    const one = matchParagraphs(new Map([[2, atOne]]), [paragraph], paragraph.text);
    const half = matchParagraphs(new Map([[2, atHalf]]), [paragraph], paragraph.text);
    expect(one.paragraphIds).toEqual(["p_0002"]);
    expect(half.paragraphIds).toEqual(one.paragraphIds);
  });

  it("returns nothing for a rotated page rather than guessing", () => {
    const rects = toPdfRects(
      [{ left: 172, top: 182, width: 896, height: 28 }],
      { left: 100, top: 150 },
      2,
      irPage(2, 90),
    );
    expect(rects).toEqual([]);
  });
});

describe("DS-QA-011 · mapping and target order", () => {
  const p1 = irParagraph("p_0001", 1, TAIL_OF_P1, "the last line of page one");
  const p2 = irParagraph("p_0002", 2, HEAD_OF_P2, "the first line of page two");
  const p1Early = irParagraph("p_0000", 1, [72, 100, 500, 114], "an earlier line on page one");
  const ir = irWith([p1Early, p1, p2]);

  function rectsByPage(): Map<number, PdfRect[]> {
    return new Map([
      [1, toPdfRects(
        [{ left: clientRect(TAIL_OF_P1, PAGE1_TOP, PAGE_LEFT)[0],
           top: clientRect(TAIL_OF_P1, PAGE1_TOP, PAGE_LEFT)[1],
           width: clientRect(TAIL_OF_P1, PAGE1_TOP, PAGE_LEFT)[2],
           height: clientRect(TAIL_OF_P1, PAGE1_TOP, PAGE_LEFT)[3] }],
        { left: PAGE_LEFT, top: PAGE1_TOP }, SCALE, irPage(1))],
      [2, toPdfRects(
        [{ left: clientRect(HEAD_OF_P2, PAGE2_TOP, PAGE_LEFT)[0],
           top: clientRect(HEAD_OF_P2, PAGE2_TOP, PAGE_LEFT)[1],
           width: clientRect(HEAD_OF_P2, PAGE2_TOP, PAGE_LEFT)[2],
           height: clientRect(HEAD_OF_P2, PAGE2_TOP, PAGE_LEFT)[3] }],
        { left: PAGE_LEFT, top: PAGE2_TOP }, SCALE, irPage(2))],
    ]);
  }

  it("maps each page's rects to that page's own paragraph", () => {
    const mapping = matchParagraphs(
      rectsByPage(), ir.paragraphs,
      "the last line of page one the first line of page two",
    );
    expect(mapping.paragraphIds).toEqual(["p_0001", "p_0002"]);
    expect(mapping.pages).toEqual([1, 2]);
    expect(mapping.status).toBe("valid");
  });

  it("orders targets by canonical document order, not by drag direction", () => {
    /* The reader may drag upward. The annotation is still the same span, read
       the way the paper reads — page 1 before page 2. */
    const forward = buildAnnotationTargets(ir, matchParagraphs(
      rectsByPage(), ir.paragraphs,
      "the last line of page one the first line of page two",
    ));
    const reversed = buildAnnotationTargets(ir, matchParagraphs(
      new Map([...rectsByPage()].reverse()), ir.paragraphs,
      "the first line of page two the last line of page one",
    ));

    expect(forward.map((t) => t.pageNumber)).toEqual([1, 2]);
    expect(reversed.map((t) => t.pageNumber)).toEqual([1, 2]);
    expect(reversed.map((t) => t.quote)).toEqual(forward.map((t) => t.quote));
  });

  it("gives each target its own page's rects and its own anchor", () => {
    const targets = buildAnnotationTargets(ir, matchParagraphs(
      rectsByPage(), ir.paragraphs,
      "the last line of page one the first line of page two",
    ));

    expect(targets.map((t) => t.sourceAnchorId)).toEqual(["anchor_p_0001", "anchor_p_0002"]);

    /* Each target's rectangles lie inside the region the user actually covered
       **on that target's page** — the structural form of "no rectangle bridges
       the bottom of page 1 to the top of page 2". A bridging rectangle would
       have to fall outside one of these two envelopes. */
    const within = (bbox: [number, number, number, number], rect: number[]) =>
      rect[0]! >= bbox[0] && rect[1]! >= bbox[1] && rect[2]! <= bbox[2] && rect[3]! <= bbox[3];

    for (const target of targets) {
      const envelope = target.pageNumber === 1 ? TAIL_OF_P1 : HEAD_OF_P2;
      expect(target.rects.length).toBeGreaterThan(0);
      for (const rect of target.rects) expect(within(envelope, rect)).toBe(true);
    }
    // And the two sets are on different pages, so they cannot overlap in space.
    expect(targets[0]!.bbox).not.toEqual(targets[1]!.bbox);
  });

  it("disambiguates identical text on two pages by page, not by search", () => {
    /* The same sentence appears on both pages, as a running header would. The
       selection covers both. A mapping that searched for the text globally
       would attach both targets to whichever copy it found first. */
    const same = "adaptive control improves sample efficiency";
    const a = irParagraph("p_0001", 1, TAIL_OF_P1, same);
    const b = irParagraph("p_0002", 2, HEAD_OF_P2, same);
    const document = irWith([a, b]);

    const targets = buildAnnotationTargets(document, matchParagraphs(
      rectsByPage(), document.paragraphs, same,
    ));

    expect(targets.map((t) => [t.pageNumber, t.sourceAnchorId]))
      .toEqual([[1, "anchor_p_0001"], [2, "anchor_p_0002"]]);
  });

  it("keeps a three-page selection out of the two-page contract", () => {
    /* The bound is deliberate and stated: the viewer mounts two adjacent pages,
       so a gesture that reports three is reporting pages the reader could not
       have selected together. It maps nothing rather than approximating. */
    const mapping = matchParagraphs(
      new Map([...rectsByPage(), [3, rectsByPage().get(2)!]]),
      ir.paragraphs,
      "text",
    );
    expect(mapping.pages).toEqual([1, 2, 3]);
    expect(mapping.paragraphIds.length).toBeLessThanOrEqual(2);
  });
});

describe("DS-QA-011 · captureSelection across a boundary", () => {
  /**
   * Scale 1, so a client coordinate is the PDF point itself and the assertions
   * read in the same units as the IR. jsdom reports every element's client rect
   * as the origin, which is what makes that true.
   */
  const TAIL: [number, number, number, number] = [72, 690, 500, 704];
  const HEAD: [number, number, number, number] = [72, 100, 520, 114];

  const PAGE1_TEXT =
    "the last line of page one describes the reward shaping used by the learned controller";
  const PAGE2_TEXT =
    "the first line of page two reports the mean success rate across five seeds";

  function seedIr(rotation = 0) {
    const document = seedDocument();
    const paragraphs: IrParagraph[] = [
      irParagraph("p_0001", 1, TAIL, PAGE1_TEXT),
      irParagraph("p_0002", 2, HEAD, PAGE2_TEXT),
    ];
    useWorkspaceStore.getState().setIr({
      document_id: document.documentId ?? "doc_test",
      content_hash: "hash",
      page_count: 2,
      paragraphs,
      pages: [1, 2].map((number) => irPage(number, number === 2 ? rotation : 0)),
    });
    return document;
  }

  /** Two mounted pages, scale 1, each with one selectable line. */
  function domTwoPages(text1 = PAGE1_TEXT, text2 = PAGE2_TEXT, rotation = 0) {
    seedIr(rotation);
    const page1 = pageElement(1, false, 1);
    const page2 = pageElement(2, false, 1);
    return {
      tail: span(page1, text1, TAIL),
      head: span(page2, text2, HEAD),
      page2,
    };
  }

  it("maps a forward selection to both pages, in reading order", () => {
    const { tail, head } = domTwoPages();
    selectRange(tail, 0, head, head.nodeValue!.length);

    const mapping = captureSelection();
    expect(mapping?.status).toBe("valid");
    expect(mapping?.paragraphIds).toEqual(["p_0001", "p_0002"]);
    expect(mapping?.pages).toEqual([1, 2]);
    expect(Object.keys(mapping?.rects ?? {})).toEqual(["1", "2"]);
  });

  it("maps a backward selection to the same pages in the same order", () => {
    /* A reader may drag upward. Canonical order is the paper's, not the drag's. */
    const { tail, head } = domTwoPages();
    const selection = selectBackward(tail, 0, head, head.nodeValue!.length);
    expect(selection.anchorNode).toBe(head);
    expect(selection.focusNode).toBe(tail);

    const mapping = captureSelection();
    expect(mapping?.status).toBe("valid");
    expect(mapping?.paragraphIds).toEqual(["p_0001", "p_0002"]);
    expect(mapping?.pages).toEqual([1, 2]);
  });

  it("refuses when the browser reports text no page could measure", () => {
    /* The measured browser behaviour, reproduced at the boundary that consumes
       it: `Range.toString()` is computed from node references and keeps
       reporting a page the virtualiser removed mid-drag, while that page
       contributes no geometry. jsdom re-derives its own `toString()` from the
       live tree, so the primitive is stubbed here — with the shape the browser
       was measured to produce (6388 characters reported against a first page
       that could not be measured at all).

       Without this refusal the mapping is silently a shorter span than the one
       the reader can still see highlighted. */
    const { tail, head } = domTwoPages();
    const selection = selectRange(tail, 0, head, head.nodeValue!.length);

    /* The stub is on `Selection.toString`, not `Range.toString`: jsdom's
       `Selection` does not delegate to the Range method, and the reported text
       is a property of the selection anyway. Everything else — the clamping,
       the per-page rects, the measured text — runs for real. */
    const real = Selection.prototype.toString;
    vi.spyOn(Selection.prototype, "toString").mockImplementation(function (this: Selection) {
      return `${real.call(this)} ${PAGE1_TEXT}`;
    });
    try {
      const dom = readDomSelection(selection);
      expect(dom.reportedChars).toBeGreaterThan(dom.measuredChars);
      // The measured side is the real one: both pages were walked and clamped.
      expect(dom.byPage.map((entry) => entry.page)).toEqual([1, 2]);

      const mapping = captureSelection();
      expect(mapping?.status).toBe("unmeasurable");
      expect(mapping?.paragraphIds).toEqual([]);
      expect(mapping?.reason).toContain("无法测量");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("refuses a span of three mounted pages rather than taking two of them", () => {
    /* The stated bound. The viewer mounts adjacent pages, so a gesture claiming
       three is claiming pages the reader could not have selected together — and
       saving two of them would be an annotation over a span they did not
       choose. */
    domTwoPages();
    const page3 = pageElement(3, false, 1);
    const page1 = document.querySelector<HTMLElement>('[data-page-number="1"]')!;
    const start = span(page1, "start of the span", TAIL);
    const middle = span(
      document.querySelector<HTMLElement>('[data-page-number="2"]')!,
      "middle of the span", HEAD,
    );
    const end = span(page3, "end of the span", HEAD);
    selectRange(start, 0, end, end.nodeValue!.length);

    const mapping = captureSelection();
    expect(mapping?.status).toBe("cross_page_refused");
    expect(mapping?.paragraphIds).toEqual([]);
    expect(mapping?.reason).toContain("相邻");
    expect(middle).toBeTruthy();
  });

  it("refuses when a touched page is rotated, rather than keeping the other half", () => {
    const { tail, head } = domTwoPages(PAGE1_TEXT, PAGE2_TEXT, 90);
    selectRange(tail, 0, head, head.nodeValue!.length);

    const mapping = captureSelection();
    expect(mapping?.status).toBe("cross_page_refused");
    expect(mapping?.paragraphIds).toEqual([]);
    expect(mapping?.reason).toContain("旋转");
  });

  it("still maps a single-page selection exactly as before", () => {
    /* The regression that matters most: cross-page must not have changed what a
       one-page drag does. */
    const { tail, head } = domTwoPages();
    expect(head).toBeTruthy();
    selectRange(tail, 0, tail, tail.nodeValue!.length);

    const mapping = captureSelection();
    expect(mapping?.status).toBe("valid");
    expect(mapping?.paragraphIds).toEqual(["p_0001"]);
    expect(mapping?.pages).toEqual([1]);
  });
});
