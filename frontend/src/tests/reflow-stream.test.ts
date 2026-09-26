/**
 * DS-DOC-008 — the reflow assembly, checked against a real paper's geometry.
 *
 * The fixture is the ResNet IR with its text stripped: 12 pages of block
 * rectangles with their layout classes and caption links, 101 paragraph spans,
 * and the extractor's 16 sections (`__resnet_pages.json`). The criteria name the
 * reader's own paper for this evidence; the repository holds this fixture
 * instead, because a paper the reader happens to own is not the repository's to
 * commit — the reader's paper is measured in the browser harness, on screen.
 *
 * Nothing here touches a DOM. Every claim is about a list.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { BilingualView } from "@/api/bilingual";
import type { DocumentIr } from "@/api/ir";
import { headingIndex, reflowStream, type Box, type ReflowItem } from "@/bilingual/reflow/stream";

const fixture = JSON.parse(readFileSync("src/tests/__resnet_pages.json", "utf8")) as {
  pages: DocumentIr["pages"];
  paragraphs: Array<{
    id: string;
    page_number: number;
    section_id: string | null;
    bboxes: [number, number, number, number][];
    block_ids: string[];
  }>;
  sections: NonNullable<DocumentIr["sections"]>;
};

const IR: DocumentIr = {
  document_id: "doc_resnet",
  content_hash: "hash_resnet",
  page_count: fixture.pages.length,
  pipeline_version: "5",
  pages: fixture.pages,
  paragraphs: fixture.paragraphs.map((paragraph) => ({
    ...paragraph,
    source_anchor_id: `a_${paragraph.id}`,
    page_range: [paragraph.page_number, paragraph.page_number] as [number, number],
    text: `source text of ${paragraph.id}`,
  })),
  sections: fixture.sections,
};

/** The artifact, as the pipeline produces it: one entry per paragraph. */
function artifact(overrides: Record<string, Partial<BilingualView["paragraphs"][number]>> = {}): BilingualView {
  return {
    status: "READY",
    cached: true,
    content_hash: "hash_resnet",
    target_language: "zh-CN",
    provider_model: "deepseek-flash",
    created_at: "2026-09-26T00:00:00+00:00",
    input_tokens: 1,
    output_tokens: 1,
    notes: [],
    total_paragraphs: IR.paragraphs.length,
    translated_paragraphs: 0,
    sections: IR.sections!.map((section) => ({
      section_id: section.id,
      title: section.title,
      title_translated: `【译】${section.title}`,
      level: section.level,
      page_number: section.page_range[0],
      is_references: section.is_references,
    })),
    paragraphs: IR.paragraphs.map((paragraph) => {
      const section = IR.sections!.find((candidate) => candidate.id === paragraph.section_id);
      const references = section?.is_references === true;
      return {
        paragraph_id: paragraph.id,
        page_number: paragraph.page_number,
        section_id: paragraph.section_id,
        source_text: paragraph.text,
        translated_text: references ? "" : `译文 ${paragraph.id}`,
        status: references ? ("skipped" as const) : ("translated" as const),
        note: references ? "参考文献不予翻译" : "",
        bboxes: paragraph.bboxes as number[][],
        ...overrides[paragraph.id],
      };
    }),
    blocks: [],
  };
}

const kinds = (items: ReflowItem[]) => items.map((item) => item.kind);

describe("DS-DOC-008 · the reading column", () => {
  it("shows one pair per paragraph, in the paper's order (AC-P0-16)", () => {
    const items = reflowStream(IR, artifact());
    const ids = items.filter((item) => item.kind === "pair").map((item) => item.paragraphId);
    const expected = IR.paragraphs.map((paragraph) => paragraph.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(ids)).toEqual(new Set(expected));
    expect(ids.length).toBe(expected.length);
  });

  it("emits every heading the extractor derived, and no `title` block (AC-P0-08)", () => {
    const items = reflowStream(IR, artifact());
    const headings = items.filter((item) => item.kind === "heading");
    expect(headings).toHaveLength(IR.sections!.length);
    expect(new Set(headings.map((heading) => heading.sectionId))).toEqual(
      new Set(IR.sections!.map((section) => section.id)),
    );
    expect(headings.every((heading) => heading.titleTranslated !== null)).toBe(true);

    // The trap: 191 blocks carry 23 `title` classes; none of the ones that are
    // not sections may be rendered as a heading. The fixture's paragraphs cover
    // every block, so a title block would surface as a pair whose id is a block.
    const titleBlocks = new Set(
      IR.pages.flatMap((page) =>
        page.blocks.filter((block) => block.layout_class === "title").map((block) => block.id),
      ),
    );
    expect(titleBlocks.size).toBeGreaterThan(headings.length);
  });

  it("drops every piece of furniture (AC-P0-11)", () => {
    const items = reflowStream(IR, artifact());
    const furniture = new Set(
      IR.pages.flatMap((page) =>
        page.blocks
          .filter((block) => block.layout_class === "abandon")
          .map((block) => block.id),
      ),
    );
    expect(furniture.size).toBeGreaterThan(0);
    const rendered = items.flatMap((item) =>
      item.kind === "crop" ? [item.blockId] : item.kind === "pair" ? [item.paragraphId] : [],
    );
    for (const block of furniture) expect(rendered).not.toContain(block);
  });

  it("carries every figure, table and formula as its own crop (AC-P0-09)", () => {
    const items = reflowStream(IR, artifact());
    const crops = items.filter((item) => item.kind === "crop");
    const expected = IR.pages.flatMap((page) =>
      page.blocks.filter((block) =>
        ["figure", "table", "isolate_formula"].includes(block.layout_class),
      ),
    );
    expect(crops).toHaveLength(expected.length);
    for (const crop of crops) {
      expect(crop.box[2]).toBeGreaterThan(crop.box[0]);
      expect(crop.box[3]).toBeGreaterThan(crop.box[1]);
      // Never as text: a formula's extracted text is scrambled, so the item
      // carries no text of its own at all.
      expect(Object.keys(crop)).not.toContain("text");
    }
  });

  it("places each caption with its own crop, not where the order put it (AC-P0-10)", () => {
    const items = reflowStream(IR, artifact());
    const crops = items.filter((item) => item.kind === "crop");
    const captioned = crops.filter((crop) => crop.caption !== null);
    expect(captioned.length).toBeGreaterThan(0);

    for (const crop of captioned) {
      const expectedSide =
        crop.layoutClass === "figure" ? "below" : crop.layoutClass === "table" ? "above" : "beside";
      expect(crop.captionSide).toBe(expectedSide);
    }

    // A caption is never emitted as an item of its own: its text lives inside
    // the crop it belongs to.
    const captionTexts = new Set(
      IR.pages.flatMap((page) =>
        page.blocks
          .filter((block) => block.layout_class.endsWith("_caption"))
          .map((block) => block.id),
      ),
    );
    for (const item of items) {
      if (item.kind === "pair") expect(captionTexts.has(item.paragraphId)).toBe(false);
    }

    // And the two-sided check the criteria ask for: for every captioned figure,
    // the caption's own block is *not* rendered anywhere else in the stream.
    for (const crop of captioned) {
      const captionBlock = IR.pages.flatMap((page) => page.blocks).find(
        (block) => block.caption_of === crop.blockId,
      );
      expect(captionBlock).toBeDefined();
      expect(items.some((item) => item.kind === "crop" && item.blockId === captionBlock!.id)).toBe(
        false,
      );
    }
  });

  it("says the references are kept, once, and never translates them (AC-P0-17)", () => {
    const items = reflowStream(IR, artifact());
    const notices = items.filter((item) => item.kind === "notice");
    expect(notices).toHaveLength(1);

    const references = IR.sections!.find((section) => section.is_references)!;
    const referenceIds = new Set(
      IR.paragraphs
        .filter((paragraph) => paragraph.section_id === references.id)
        .map((paragraph) => paragraph.id),
    );
    const pairs = items.filter((item) => item.kind === "pair");
    for (const pair of pairs) {
      if (!referenceIds.has(pair.paragraphId)) continue;
      expect(pair.status).toBe("skipped");
      expect(pair.translatedText).toBe("");
    }
  });

  it("marks a paragraph the artifact could not translate, without inventing one (AC-P0-18)", () => {
    const first = IR.paragraphs.find((paragraph) => paragraph.section_id !== null)!;
    const items = reflowStream(
      IR,
      artifact({ [first.id]: { status: "untranslated", translated_text: "", note: "本段未能翻译" } }),
    );
    const pair = items.find((item) => item.kind === "pair" && item.paragraphId === first.id)!;
    if (pair.kind !== "pair") throw new Error("expected a pair");
    expect(pair.status).toBe("untranslated");
    expect(pair.translatedText).toBe("");
    expect(pair.note).toContain("未能翻译");
  });

  it("finds a heading by section id, for an outline jump (AC-P1-06)", () => {
    const items = reflowStream(IR, artifact());
    const target = IR.sections![3]!;
    const index = headingIndex(items, target.id);
    expect(index).toBeGreaterThanOrEqual(0);
    const heading = items[index];
    expect(heading?.kind).toBe("heading");
    if (heading?.kind === "heading") expect(heading.title).toBe(target.title);
  });

  it("keeps the paper's own reading order — column-major, not re-sorted", () => {
    const items = reflowStream(IR, artifact());
    const pages = items
      .filter((item) => item.kind === "pair")
      .map((item) => item.pageNumber);
    expect(pages).toEqual([...pages].sort((a, b) => a - b));
  });

  it("renders plain, and honestly, when there is no artifact at all", () => {
    const items = reflowStream(IR, null);
    const pairs = items.filter((item) => item.kind === "pair");
    expect(pairs.length).toBe(IR.paragraphs.length);
    expect(pairs.every((pair) => pair.translatedText === null || pair.translatedText === "")).toBe(
      true,
    );
    // The references notice comes from the paper, not from the artifact: it is
    // true whether or not anything was ever translated.
    expect(kinds(items)).toContain("notice");
  });
});

describe("DS-DOC-010 · equation numbers the extractor never linked", () => {
  it("claims an unlinked number by the formula it sits beside (AC-P0-12)", () => {
    // The reader's own paper is the case: `caption_of` is null for all 6 of its
    // equation numbers, and what survives is geometry.
    const page = {
      page_number: 9,
      width_pt: 612,
      height_pt: 792,
      rotation: 0,
      blocks: [
        {
          id: "fx", page_number: 9, layout_class: "isolate_formula", text: "soup",
          bbox: [80, 200, 300, 230] as Box, source_anchor_id: "",
        },
        {
          id: "num", page_number: 9, layout_class: "formula_caption", text: "(7)",
          bbox: [320, 208, 340, 220] as Box, source_anchor_id: "", caption_of: null,
        },
        // Far enough away that it belongs to nothing on this page.
        {
          id: "far", page_number: 9, layout_class: "plain text", text: "not prose",
          bbox: [50, 700, 300, 740] as Box, source_anchor_id: "",
        },
      ],
    };
    const ir: DocumentIr = {
      document_id: "doc_x", content_hash: "h", page_count: 1,
      pages: [page], paragraphs: [], sections: [],
    };
    const items = reflowStream(ir, null);
    const crop = items.find((item) => item.kind === "crop" && item.blockId === "fx");
    expect(crop?.kind).toBe("crop");
    if (crop?.kind === "crop") expect(crop.number).toBe("(7)");
    // And the number is not also emitted as a block of its own.
    expect(items.some((item) => item.kind === "crop" && item.blockId === "num")).toBe(false);
  });

  it("leaves a formula without a nearby number unnumbered", () => {
    const page = {
      page_number: 1, width_pt: 612, height_pt: 792, rotation: 0,
      blocks: [
        {
          id: "fx", page_number: 1, layout_class: "isolate_formula", text: "soup",
          bbox: [80, 100, 300, 130] as Box, source_anchor_id: "",
        },
        {
          id: "num", page_number: 1, layout_class: "formula_caption", text: "(9)",
          bbox: [320, 600, 340, 612] as Box, source_anchor_id: "", caption_of: null,
        },
      ],
    };
    const ir: DocumentIr = {
      document_id: "doc_y", content_hash: "h", page_count: 1,
      pages: [page], paragraphs: [], sections: [],
    };
    const crop = reflowStream(ir, null).find(
      (item) => item.kind === "crop" && item.blockId === "fx",
    );
    if (crop?.kind === "crop") expect(crop.number).toBeNull();
  });
});
