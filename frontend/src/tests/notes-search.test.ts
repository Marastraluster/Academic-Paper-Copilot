/**
 * DS-QA-012 — searching the reader's own annotations.
 *
 * The corpus is the one the task names, and the queries are the ones that
 * decided the architecture: they are the cases SQLite's tokenisers were measured
 * to lose (`.agent/results/notes/fts_probe.txt`). A test suite that only searched
 * for English words would have passed against an FTS index that cannot find a
 * Chinese note at all.
 */
import { describe, expect, it } from "vitest";

import type { AnnotationView, ResolvedTarget } from "@/api/annotations";
import {
  buildSearchIndex,
  filterAnnotations,
  matchesQuery,
  normalizeForSearch,
  searchableText,
} from "@/notes/search";

function target(quote: string, page = 1, state: ResolvedTarget["state"] = "EXACT"): ResolvedTarget {
  return {
    order: 0, page_number: page, rects: [[72, 100, 400, 114]], quote, state,
    resolved_paragraph_id: state === "ORPHANED" ? null : "p_0001", detail: "",
    showable: true, amenable_to_jump: true,
  };
}

function annotation(over: Partial<AnnotationView> = {}): AnnotationView {
  return {
    id: over.id ?? "ann_1",
    kind: over.kind ?? "note",
    color: "yellow",
    quote: over.quote ?? "the degradation problem",
    comment: over.comment ?? null,
    created_at: "2026-09-19T00:00:00+00:00",
    updated_at: "2026-09-19T00:00:00+00:00",
    targets: over.targets ?? [target(over.quote ?? "the degradation problem")],
  };
}

const CORPUS: AnnotationView[] = [
  annotation({
    id: "n1", comment: "这个地方解释了残差网络为什么不会因为加深而退化",
    quote: "degradation with depth",
  }),
  annotation({
    id: "n2", comment: "degrades with depth: the degradation problem",
    quote: "plain networks",
  }),
  annotation({
    id: "n3", comment: null,
    quote: "ResNet-50 on CIFAR-10, see Algorithm 1 and Eq. 4", kind: "highlight",
  }),
  annotation({
    id: "n4", comment: "残差连接解决退化问题",
    quote: "residual connections ease optimisation",
  }),
  annotation({
    // The only note holding both a Latin model name and the Chinese term for
    // what it introduced — which is what makes a mixed-script query testable.
    id: "n5", comment: "ResNet 的残差连接很关键", quote: "identity mappings",
  }),
];

/** Ids matching a query, in corpus order. */
function ids(query: string): string[] {
  return filterAnnotations(CORPUS, buildSearchIndex(CORPUS), query).map((a) => a.id);
}

describe("DS-QA-012 · normalization", () => {
  it("folds case so a query finds the paper's spelling", () => {
    expect(normalizeForSearch("ResNet")).toBe(normalizeForSearch("resnet"));
  });

  it("folds compatibility characters, so a full-width query finds ASCII", () => {
    /* A reader typing on a Chinese IME produces full-width Latin; the PDF's text
       layer holds ASCII. NFKC is what makes those the same query. */
    expect(normalizeForSearch("ＲｅｓＮｅｔ")).toBe("resnet");
  });

  it("collapses whitespace without touching digits or hyphens", () => {
    expect(normalizeForSearch("  Algorithm   1  ")).toBe("algorithm 1");
    // The characters that make an identifier identifiable are not normalised away.
    expect(normalizeForSearch("ResNet-50")).toBe("resnet-50");
    expect(normalizeForSearch("CIFAR-10")).toBe("cifar-10");
  });
});

describe("DS-QA-012 · what a query matches", () => {
  it("finds a Chinese bigram inside a longer note", () => {
    expect(ids("残差")).toEqual(["n1", "n4", "n5"]);
    // n2 is English; it contains the word, not the characters.
    expect(ids("退化")).toEqual(["n1", "n4"]);
    // n5 has 残差连接 but not 网络, so a bigram inside a longer word is not a hit.
    expect(ids("网络")).toEqual(["n1"]);
  });

  it("finds a Chinese four-character phrase", () => {
    // n1 reads "...加深而退化" and has no 问题 after it.
    expect(ids("退化问题")).toEqual(["n4"]);
    expect(ids("残差网络")).toEqual(["n1"]);
  });

  it("finds English regardless of case", () => {
    expect(ids("DEGRADATION")).toEqual(["n1", "n2"]);
  });

  it("finds a hyphenated identifier without a query syntax error", () => {
    /* The case FTS5 raises `no such column: 50` on. There is no query language
       here to have syntax, which is the point. */
    expect(ids("ResNet-50")).toEqual(["n3"]);
    expect(ids("CIFAR-10")).toEqual(["n3"]);
    expect(ids("resnet-50")).toEqual(["n3"]);
  });

  it("finds an identifier containing a space as a phrase, not as loose words", () => {
    expect(ids("Algorithm 1")).toEqual(["n3"]);
  });

  it("treats an unmatched mixed-script query as separate terms", () => {
    /* No note contains the literal "resnet 残差", and answering "no notes" would
       tell the reader their note is missing when it is right there. Only n5 holds
       both halves; n1 and n4 have 残差 without ResNet, and n3 has ResNet without
       it, so the answer is one note and not three. */
    expect(ids("ResNet 残差")).toEqual(["n5"]);
  });

  it("takes the phrase as the whole answer when any note contains it", () => {
    /* The rule that keeps `Algorithm 1` exact. n3 has the phrase; no other note
       has "algorithm" anywhere, so the interesting shape is the mixed query
       below, which is why this is asserted at the list level. */
    expect(ids("Algorithm 1")).toEqual(["n3"]);

    const haystack = normalizeForSearch("the algorithm is simple, 1 of 3 runs");
    // Per annotation the fallback still applies — the list-level pass is what
    // decides whether the fallback is reached at all.
    expect(matchesQuery(haystack, normalizeForSearch("algorithm 1"))).toBe(true);
  });

  it("falls back to the quote, so a highlight with no note is still findable", () => {
    expect(ids("plain networks")).toEqual(["n2"]);
    expect(ids("residual connections")).toEqual(["n4"]);
  });

  it("searches per-target quotes, not only the annotation's own", () => {
    /* On a cross-page selection the two differ: the annotation's quote is the
       whole span the reader dragged, a target's quote is one paragraph of it. */
    const crossPage = annotation({
      id: "x1", comment: null, quote: "the full span the reader dragged",
      targets: [target("first paragraph text", 1), target("second paragraph text", 2)],
    });
    const list = [crossPage];
    const found = filterAnnotations(list, buildSearchIndex(list), "second paragraph");
    expect(found.map((a) => a.id)).toEqual(["x1"]);
  });

  it("returns a cross-page annotation once when either page matches", () => {
    const crossPage = annotation({
      id: "x1", comment: "spans the boundary",
      quote: "the full span", targets: [target("page one text", 1), target("page two text", 2)],
    });
    const list = [crossPage];
    const index = buildSearchIndex(list);

    expect(filterAnnotations(list, index, "page one").map((a) => a.id)).toEqual(["x1"]);
    expect(filterAnnotations(list, index, "page two").map((a) => a.id)).toEqual(["x1"]);
    expect(filterAnnotations(list, index, "spans the boundary").map((a) => a.id)).toEqual(["x1"]);
  });
});

describe("DS-QA-012 · query lifecycle", () => {
  it("returns everything for an empty or whitespace-only query", () => {
    expect(ids("")).toEqual(["n1", "n2", "n3", "n4", "n5"]);
    expect(ids("   ")).toEqual(["n1", "n2", "n3", "n4", "n5"]);
    expect(ids("\t\n")).toEqual(["n1", "n2", "n3", "n4", "n5"]);
  });

  it("returns nothing for a query nothing contains", () => {
    expect(ids("nonexistent_xyz")).toEqual([]);
  });

  it("does not match the document title, because there is no title here to match", () => {
    /* Stated as a test because it is a decision, not an omission: being handed
       every note in the ResNet paper when you search "ResNet" is not a result. */
    expect(ids("paper")).toEqual([]);
  });

  it("preserves catalogue order, never reordering by relevance", () => {
    // n1 and n2 both match; the answer is their order in the list, not a score.
    expect(ids("degradation")).toEqual(["n1", "n2"]);
  });

  it("keeps an unresolved note findable, because the note is still the reader's", () => {
    const orphaned = annotation({
      id: "o1", comment: "still my words", quote: "its paragraph moved",
      targets: [target("its paragraph moved", 1, "ORPHANED")],
    });
    const list = [orphaned];
    expect(
      filterAnnotations(list, buildSearchIndex(list), "still my words").map((a) => a.id),
    ).toEqual(["o1"]);
    expect(
      filterAnnotations(list, buildSearchIndex(list), "paragraph moved").map((a) => a.id),
    ).toEqual(["o1"]);
  });

  it("indexes what is stored, and does not rewrite it", () => {
    /* Normalisation is a query-time representation. The note the reader typed is
       what a search *matches*, and what an export writes out — including the
       whitespace a naive implementation would have collapsed in place. */
    const note = "  Two  spaces   and a\nnewline  ";
    const subject = annotation({ id: "s1", comment: note, quote: "x" });
    expect(subject.comment).toBe(note);
    expect(searchableText(subject)).toContain("two spaces and a newline");
  });
});

describe("DS-QA-012 · the index", () => {
  it("is keyed by annotation id and covers every annotation", () => {
    const index = buildSearchIndex(CORPUS);
    expect([...index.keys()]).toEqual(["n1", "n2", "n3", "n4", "n5"]);
  });

  it("reflects an edit, because it is rebuilt from the list", () => {
    const before = [annotation({ id: "a", comment: "first wording", quote: "q" })];
    expect(filterAnnotations(before, buildSearchIndex(before), "second wording")).toEqual([]);

    const after = [annotation({ id: "a", comment: "second wording", quote: "q" })];
    expect(
      filterAnnotations(after, buildSearchIndex(after), "second wording").map((a) => a.id),
    ).toEqual(["a"]);
  });

  it("stops answering for a deleted note, because it is gone from the list", () => {
    const list = [annotation({ id: "a", comment: "keep", quote: "q" })];
    const emptied = list.filter((item) => item.id !== "a");
    expect(
      filterAnnotations(emptied, buildSearchIndex(emptied), "keep"),
    ).toEqual([]);
  });
});
