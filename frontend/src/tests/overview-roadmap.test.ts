/**
 * DS-QA-014 — where a reader should start, from the paper's own outline.
 *
 * The whole reason this is a module with tests rather than one line inside the
 * panel is the measurement it is written against: on the real ResNet extraction
 * there **is no section called "Method" or "Experiments"**. The outline reads
 * `Abstract`, `1. Introduction`, `2. Related Work`, `3. Deep Residual Learning`.
 * A recommendation that matched the titles it expected would work on the papers
 * it was written against and quietly recommend nothing on every other one.
 */
import { describe, expect, it } from "vitest";

import { firstReadingTarget, isFrontMatter } from "@/overview/roadmap";
import type { QaSection } from "@/stores/workspace";

function section(title: string, level: number | null, page = 1): QaSection {
  return {
    id: `sec_${title}`, title, level, parentId: null,
    pageNumber: page, pageRange: [page, page], bbox: null,
    anchor: "heading", isReferences: false,
  };
}

/** The real ResNet outline, as the extraction produced it. */
const RESNET = [
  section("Abstract", 1),
  section("1. Introduction", 1),
  section("2. Related Work", 1),
  section("3. Deep Residual Learning", 1),
  section("3.1. Residual Learning", 2),
  section("3.2. Identity Mapping by Shortcuts", 2),
  section("4. Experiments", 1),
];

describe("DS-QA-014 · front matter", () => {
  it("recognises the headings a reader skips past", () => {
    for (const title of [
      "Abstract", "1. Introduction", "2. Related Work",
      "I. INTRODUCTION", "1. Background", "Preliminaries", "摘要", "相关工作",
      "2. Related Work: A Survey",
    ]) {
      expect(isFrontMatter(title), title).toBe(true);
    }
  });

  it("does not swallow a body section that merely starts with the same words", () => {
    /* `Related Work on Graphs` is a section of the paper's own, not the
       literature review a reader skips. An unanchored substring match would
       recommend skipping it. */
    expect(isFrontMatter("Related Work on Graphs")).toBe(false);
    expect(isFrontMatter("3. Deep Residual Learning")).toBe(false);
    expect(isFrontMatter("Background Subtraction Networks")).toBe(false);
    /* And an ambiguous title is deliberately left alone. Matching it would be
       right more often than not, and getting it wrong hides a section of the
       paper from the recommendation — the asymmetry is chosen. A reader who
       starts at "Introduction and Motivation" has lost one scroll; a reader
       whose method section was silently skipped has lost the paper. */
    expect(isFrontMatter("Introduction and Motivation")).toBe(false);
  });
});

describe("DS-QA-014 · the recommendation ladder", () => {
  it("names the paper's own first body section, not a title it expected", () => {
    const target = firstReadingTarget(RESNET);
    expect(target.section?.title).toBe("3. Deep Residual Learning");
    expect(target.reason).toContain("3. Deep Residual Learning");
  });

  it("recommends a level-1 section, never a subsection", () => {
    /* Opening a reader at `3.1. Residual Learning` is opening them at a
       consequence of an idea they have not met yet. */
    const target = firstReadingTarget(RESNET);
    expect(target.section?.level).toBe(1);
    expect(target.section?.title).not.toBe("3.1. Residual Learning");
  });

  it("recommends a section whose title it does not recognise, rather than skipping it", () => {
    /* The asymmetry in action. `Preamble` is not a heading this knows, so it is
       treated as substance and recommended. Matching it would have been right
       more often than not — and being wrong would have hidden a section of the
       paper from the one control whose whole job is to find the start of one. */
    const unknown = [section("Preamble", 1), section("Motivation", 1)];
    expect(firstReadingTarget(unknown).section?.title).toBe("Preamble");
  });

  it("falls through to the first section after an abstract when that is all there is", () => {
    /* A paper whose body sections were not extracted. Naming the introduction is
       a worse answer than a correct match and a far better one than nothing. */
    const stub = [section("Abstract", 1), section("1. Introduction", 1)];
    expect(firstReadingTarget(stub).section?.title).toBe("1. Introduction");
  });

  it("says so plainly when the paper has no usable outline", () => {
    /* Not a recommendation at all — and the reader is told why rather than left
       with a button that does nothing. */
    const target = firstReadingTarget([]);
    expect(target.section).toBeNull();
    expect(target.reason).toContain("第 1 页");
  });

  it("says so when an abstract is the only top-level section", () => {
    const onlyAbstract = [section("Abstract", 1)];
    const target = firstReadingTarget(onlyAbstract);
    expect(target.section).toBeNull();
    expect(target.reason).toContain("第 1 页");
  });

  it("treats an unlevelled section as top-level", () => {
    /* `SectionIR.level` is `None` when the heading carries no numbering and no
       reliable typographic signal — an honest gap, not a hierarchy. A section
       the extraction could not level is still a section a reader can start at. */
    const unlevelled = [section("Abstract", 1), section("Deep Learning", null)];
    expect(firstReadingTarget(unlevelled).section?.title).toBe("Deep Learning");
  });

  it("returns the same answer every time", () => {
    const first = firstReadingTarget(RESNET);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(firstReadingTarget(RESNET).section?.id).toBe(first.section?.id);
    }
  });
});
