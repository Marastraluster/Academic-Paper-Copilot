/**
 * Where a reader should start, decided from the paper's own outline.
 *
 * The tempting version of this hardcodes the sections of a machine-learning
 * paper: Introduction, then Method, then Experiments. It works on the papers it
 * was written against and quietly lies on every other one — and measured on the
 * real ResNet extraction, there **is no section called "Method" or
 * "Experiments"**: the outline reads `Abstract`, `1. Introduction`,
 * `2. Related Work`, `3. Deep Residual Learning`, `3.1. Residual Learning`, …
 *
 * So nothing here matches a title it expects to find. What it does instead is
 * describe a *shape* — front matter, then the body — and let the paper's own
 * headings say where the body begins.
 */
import type { QaSection } from "@/stores/workspace";

/**
 * Headings that are front matter rather than the paper's substance.
 *
 * Matching is by **shape**, not by an exact title, and it is deliberately
 * strict: the heading must *be* the phrase, optionally with a colon and a
 * subtitle. `Related Work on Graphs` is a section of the paper's own and not the
 * literature review a reader skips, and `Introduction and Motivation` — which a
 * looser rule would catch — is left alone too.
 *
 * **The asymmetry is chosen, not accidental.** Skipping a real body section
 * hides content from the reader; recommending a front-matter section costs them
 * one scroll. When a title is ambiguous this errs toward recommending it, and a
 * paper whose introduction is titled unusually simply gets its introduction
 * recommended — which is where they should have started anyway.
 */
const PHRASE = [
  // English, with an optional section number in either Arabic or Roman form —
  // `1. Introduction`, `I. INTRODUCTION` and plain `Abstract` are all the same
  // thing, and a rule that knew only the first would fail on most IEEE papers.
  /^(?:\d+[.)]|[IVXLC]+[.)])?\s*(?:abstract|introduction|related\s+work|background|preliminaries|preliminary)\s*(?:[:：].*)?$/i,
  // The same headings in Chinese, because the interface is Chinese and a paper
  // may be too.
  /^(?:摘要|引言|绪论|背景|相关工作|预备知识)\s*(?:[:：].*)?$/,
];

export function isFrontMatter(title: string): boolean {
  const trimmed = title.trim();
  return PHRASE.some((pattern) => pattern.test(trimmed));
}

export interface ReadingTarget {
  /** The section to open, or `null` when the paper has no usable outline. */
  section: QaSection | null;
  /** Why this section, in the reader's terms. Never an internal rule name. */
  reason: string;
}

/**
 * The section to read first.
 *
 * The ladder, in order:
 *
 *   1. the first top-level section that is not front matter — the paper's own
 *      idea of where its substance starts;
 *   2. failing that, the first top-level section after the abstract, so a paper
 *      whose introduction is titled unconventionally still gets somewhere;
 *   3. failing that, nothing, said plainly.
 *
 * **Level 1 only.** A paper's `3.1.` is a subsection of its `3.`, and opening a
 * reader at a subsection of an idea they have not met yet is worse than opening
 * them at the idea.
 */
export function firstReadingTarget(sections: readonly QaSection[]): ReadingTarget {
  const top = sections.filter((section) => section.level === 1 || section.level === null);
  if (top.length === 0) {
    return {
      section: null,
      reason: "这篇论文没有可用的章节结构，请从第 1 页开始阅读。",
    };
  }

  const body = top.find((section) => !isFrontMatter(section.title));
  if (body) {
    return { section: body, reason: `从正文第一章开始：${body.title}` };
  }

  // Everything top-level looks like front matter. A paper with only an abstract
  // and an introduction is a paper whose structure has not been extracted, and
  // naming the second one is still better than naming none.
  const afterAbstract = top.find((section) => !/abstract/i.test(section.title));
  if (afterAbstract) {
    return { section: afterAbstract, reason: `从第一章开始：${afterAbstract.title}` };
  }

  return {
    section: null,
    reason: "这篇论文没有可用的章节结构，请从第 1 页开始阅读。",
  };
}
