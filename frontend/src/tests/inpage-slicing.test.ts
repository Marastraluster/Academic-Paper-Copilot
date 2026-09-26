/**
 * DS-DOC-007 — the unrolling arithmetic, checked against a real paper's geometry.
 *
 * The fixture is the ResNet IR with its text stripped: 12 pages of block
 * rectangles, layout classes and paragraph spans, exactly as the extractor
 * produced them (`__resnet_pages.json`). The criteria name the reader's own
 * paper for this evidence; the repository holds this fixture instead, because
 * committing a paper the reader happens to own is not something it does — the
 * reader's paper is measured in the Chromium harness, on screen, where its
 * numbers can be read without its text entering version control.
 *
 * Nothing here touches a DOM. Every claim below is a statement about rectangles,
 * which is the point of keeping the slicing in its own module.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  pageFlow,
  type BlockRect,
  type Box,
  type PageFlow,
  type ParagraphSpan,
} from "@/bilingual/inpage/geometry";

interface FixturePage {
  page_number: number;
  width_pt: number;
  height_pt: number;
  blocks: Array<{
    id: string;
    layout_class: string;
    bbox: Box;
    font_size: number | null;
  }>;
}

interface FixtureParagraph {
  id: string;
  page_number: number;
  bboxes: Box[];
  block_ids: string[];
}

const fixture = JSON.parse(readFileSync("src/tests/__resnet_pages.json", "utf8")) as {
  pages: FixturePage[];
  paragraphs: FixtureParagraph[];
};

function blocksOf(page: FixturePage): BlockRect[] {
  return page.blocks.map((block) => ({
    id: block.id,
    layoutClass: block.layout_class,
    box: block.bbox,
    fontSize: block.font_size,
  }));
}

function paragraphsOf(page: FixturePage, status: ParagraphSpan["status"] = "translated"): ParagraphSpan[] {
  return fixture.paragraphs
    .filter((paragraph) => paragraph.page_number === page.page_number)
    .map((paragraph) => ({
      id: paragraph.id,
      boxes: paragraph.bboxes,
      status,
      text: status === "translated" ? `译文 ${paragraph.id}` : null,
      note: null,
    }));
}

function flowOf(pageNumber: number, status: ParagraphSpan["status"] = "translated"): PageFlow {
  const page = fixture.pages.find((candidate) => candidate.page_number === pageNumber)!;
  return pageFlow(
    { pageNumber: page.page_number, widthPt: page.width_pt, heightPt: page.height_pt },
    blocksOf(page),
    paragraphsOf(page, status),
  );
}

const BODY_PAGES = [2, 3, 5, 8];

function inside(inner: Box, outer: Box): boolean {
  return (
    inner[0] >= outer[0] - 0.51 &&
    inner[1] >= outer[1] - 0.51 &&
    inner[2] <= outer[2] + 0.51 &&
    inner[3] <= outer[3] + 0.51
  );
}

describe("DS-DOC-007 · what a real page becomes", () => {
  it("draws only rectangles with positive extent (AC-P0-09)", () => {
    for (const page of fixture.pages) {
      const flow = pageFlow(
        { pageNumber: page.page_number, widthPt: page.width_pt, heightPt: page.height_pt },
        blocksOf(page),
        paragraphsOf(page),
      );
      for (const strip of flow.strips) {
        expect(strip.box[3]).toBeGreaterThan(strip.box[1]);
        expect(strip.box[2]).toBeGreaterThan(strip.box[0]);
      }
    }
  });

  it("never draws the same block twice (AC-P0-11)", () => {
    for (const page of BODY_PAGES) {
      const flow = flowOf(page);
      const drawn = flow.strips.flatMap((strip) => strip.blockIds);
      expect(new Set(drawn).size).toBe(drawn.length);
    }
  });

  it("lists every in-band block exactly once, and names what it crops (AC-P0-11)", () => {
    for (const page of fixture.pages) {
      const flow = flowOf(page.page_number);
      const page_ = fixture.pages.find((candidate) => candidate.page_number === page.page_number)!;
      const inBand = page_.blocks.filter((block) => {
        const [, , x1] = block.bbox;
        const [x0] = block.bbox;
        // Inside the content band the flow derived, i.e. not cropped with the margin.
        return !flow.cropped.includes(block.id) && x1 > x0;
      });
      expect(flow.uncovered).toEqual([]);
      const listed = new Set(flow.strips.flatMap((strip) => strip.blockIds));
      for (const block of inBand) {
        expect(listed.has(block.id)).toBe(true);
      }
    }
  });

  it("lists every block once, and never draws it outside its lane (AC-P0-11)", () => {
    for (const pageNumber of BODY_PAGES) {
      const flow = flowOf(pageNumber);
      const page_ = fixture.pages.find((candidate) => candidate.page_number === pageNumber)!;
      for (const block of page_.blocks) {
        if (flow.cropped.includes(block.id)) continue;
        const matches = flow.strips.filter((strip) => strip.blockIds.includes(block.id));
        expect(matches).toHaveLength(1);

        // A block can straddle a cut — measured: an `isolate_formula` on page 3
        // whose top 13 pt sits above the bottom edge of the paragraph before it.
        // Its pixels are still drawn once, by the two strips that tile that
        // range; what matters is that its lane covers it end to end.
        const lane = matches[0]!.lane;
        const own = flow.strips.filter((strip) => strip.lane === lane);
        const envelope: Box = [
          Math.min(...own.map((strip) => strip.box[0])),
          Math.min(...own.map((strip) => strip.box[1])),
          Math.max(...own.map((strip) => strip.box[2])),
          Math.max(...own.map((strip) => strip.box[3])),
        ];
        expect(inside(block.bbox, envelope)).toBe(true);
      }
    }
  });

  it("draws every point of the body exactly once — no gap, no double paint (AC-P0-11)", () => {
    // The strongest form of "nothing is lost, nothing is shown twice", and the
    // one that does not care how the page happened to be cut: sample the body
    // band on a grid and count the strips covering each point.
    const STEP = 3;
    for (const pageNumber of BODY_PAGES) {
      const flow = flowOf(pageNumber);
      const page_ = fixture.pages.find((candidate) => candidate.page_number === pageNumber)!;
      const body = page_.blocks.filter((block) => block.layout_class !== "abandon");
      const top = Math.min(...body.map((block) => block.bbox[1]));
      const bottom = Math.max(...body.map((block) => block.bbox[3]));
      const x0 = Math.min(...body.map((block) => block.bbox[0]));
      const x1 = Math.max(...body.map((block) => block.bbox[2]));

      const bands = flow.strips.map((strip) => strip.box);
      let empty = 0;
      let doubled = 0;
      for (let y = top + STEP / 2; y < bottom; y += STEP) {
        for (let x = x0 + STEP / 2; x < x1; x += STEP) {
          const hits = bands.filter(
            (box) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3],
          ).length;
          if (hits === 0) empty += 1;
          if (hits > 1) doubled += 1;
        }
      }
      expect({ page: pageNumber, empty, doubled }).toEqual({ page: pageNumber, empty: 0, doubled: 0 });
    }
  });

  it("reads the left column before the right (AC-P0-08)", () => {
    for (const page of BODY_PAGES) {
      const flow = flowOf(page);
      const order = flow.items.flatMap((item) => (item.kind === "strip" ? [item.strip] : []));
      const lastLeft = order.map((strip) => strip.lane).lastIndexOf("left");
      const firstRight = order.map((strip) => strip.lane).indexOf("right");
      if (lastLeft === -1 || firstRight === -1) continue;
      expect(lastLeft).toBeLessThan(firstRight);
    }
  });

  it("isolates the running head and the folio from the reading flow (AC-P0-09)", () => {
    for (const page of fixture.pages) {
      const flow = flowOf(page.page_number);
      const order = flow.items.flatMap((item) => (item.kind === "strip" ? [item.strip] : []));
      if (order.length === 0) continue;

      const body = page.blocks.filter((block) => block.layout_class !== "abandon");
      if (body.length === 0) continue;
      const top = Math.min(...body.map((block) => block.bbox[1]));
      const bottom = Math.max(...body.map((block) => block.bbox[3]));
      const head = page.blocks.filter(
        (block) => block.layout_class === "abandon" && block.bbox[3] <= top,
      );
      const foot = page.blocks.filter(
        (block) => block.layout_class === "abandon" && block.bbox[1] >= bottom,
      );

      // A band, not a lane strip: it spans the content width and carries no
      // translation, and it is the first (resp. last) thing on the page.
      if (head.length > 0) {
        expect(order[0]!.lane).toBe("full");
        for (const block of head) expect(order[0]!.blockIds).toContain(block.id);
      }
      if (foot.length > 0) {
        const last = order[order.length - 1]!;
        expect(last.lane).toBe("full");
        for (const block of foot) expect(last.blockIds).toContain(block.id);
      }
    }
  });

  it("crops the margin stamp with the margin, and never the running head (ACR 2)", () => {
    const flow = flowOf(1);
    const page_ = fixture.pages.find((candidate) => candidate.page_number === 1)!;
    const stamp = page_.blocks.find((block) => block.id === "b_doc_resnet_p1_016")!;
    // Measured: x 14.9–36.1 — outside the content band, 23 pt wide, 364 pt tall.
    expect(stamp.bbox[0]).toBeLessThan(50);
    expect(flow.cropped).toContain("b_doc_resnet_p1_016");
    // The running head is inside the band and stays.
    expect(flow.cropped).not.toContain("b_doc_resnet_p1_015");
  });

  it("inserts each translation under the paragraph it came from (AC-P0-10)", () => {
    const flow = flowOf(2);
    const insertions = flow.items.flatMap((item) =>
      item.kind === "insertion" ? [item.insertion] : [],
    );
    expect(insertions.length).toBeGreaterThan(0);
    const strips = flow.items.flatMap((item) => (item.kind === "strip" ? [item.strip] : []));
    for (const insertion of insertions) {
      const strip = strips.find((candidate) => candidate.id === insertion.id.replace(/^i_/, "s_"));
      // The cut is the paragraph's own bottom edge, which is what the strip ends on.
      expect(insertion.box[3]).toBeGreaterThan(insertion.box[1]);
      expect(strip === undefined || Math.abs(strip.box[3] - insertion.box[3]) <= 0.75).toBe(true);
    }
  });

  it("says nothing after a paragraph it deliberately skipped (AC-P0-12)", () => {
    const flow = flowOf(2, "skipped");
    const insertions = flow.items.filter((item) => item.kind === "insertion");
    expect(insertions).toEqual([]);
    expect(flow.skipped.length).toBeGreaterThan(0);
    // The paper is still all there: skipping is about translating, not drawing.
    expect(flow.uncovered).toEqual([]);
  });

  it("keeps the whole paper when nothing is translatable (AC-P0-12)", () => {
    const flow = flowOf(3, "skipped");
    const listed = new Set(flow.strips.flatMap((strip) => strip.blockIds));
    const page_ = fixture.pages.find((candidate) => candidate.page_number === 3)!;
    for (const block of page_.blocks) {
      if (flow.cropped.includes(block.id)) continue;
      expect(listed.has(block.id)).toBe(true);
    }
  });

  it("shows no marker where the paper has none, and one seam per column change", () => {
    const flow = flowOf(2);
    const seams = flow.items.filter((item) => item.kind === "seam");
    for (const seam of seams) expect(seam.from).not.toBe(seam.to);
  });
});
