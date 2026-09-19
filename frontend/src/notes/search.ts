/**
 * Finding a note the reader wrote, without asking the paper anything.
 *
 * This is **annotation search**, and the boundary with Paper QA is not a
 * technicality: a reader typing "interesting idea" here is looking through their
 * own marginalia, not asking what the paper says. Nothing in this module touches
 * `search.db`, the retrieval pipeline, or a provider. It runs over the list the
 * panel already has.
 *
 * ## Why substring, and why not FTS5
 *
 * Measured before choosing, in `.agent/results/notes/fts_probe.txt`. SQLite's
 * `unicode61` tokeniser matches **none** of `残差`, `退化`, `网络`, `退化问题` or
 * `残差网络`; `trigram` fixes the four-character cases but cannot match a
 * two-character query, which is the most common length a Chinese reader types.
 * Both raise a raw `OperationalError: no such column: 50` on `ResNet-50` — FTS5
 * reads the hyphen as NOT and `50` as a column reference.
 *
 * Normalised substring matching passed every case, at 0.35 ms per query over
 * 1000 rows. The simple thing is also the correct thing here, so there is no
 * index, no migration and no second source of truth to keep in step.
 *
 * ## Normalisation never reaches storage
 *
 * Case folding and Unicode normalisation exist to make a *query* comparable to a
 * *haystack*. They are applied to a copy. The note the reader typed is what is
 * stored, displayed and exported, down to its whitespace.
 */
import type { AnnotationView } from "@/api/annotations";

/**
 * The comparable form of a piece of text.
 *
 * `NFKC` folds compatibility characters — full-width Latin, ligatures, the
 * typographic quotes a PDF's text layer produces — so that a reader who types a
 * normal letter finds the one the paper rendered. Then case folding, then
 * whitespace collapse, because the text layer and a human disagree about how
 * many spaces belong between two words.
 *
 * Digits and hyphens are **not** touched: `ResNet-50`, `CIFAR-10` and `Eq. 4`
 * are things a reader searches for by name, and stripping the punctuation that
 * makes them identifiable would be normalisation destroying the query.
 */
export function normalizeForSearch(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Every field a query may match, as one comparable string.
 *
 * The user's own words first, then the text they marked. Per-target quotes are
 * included and `annotation.quote` is not a duplicate of them: the annotation's
 * quote is the whole span the reader dragged across, while a target's quote is
 * the canonical paragraph text — so on a cross-page selection the two differ, and
 * either can be the thing the reader remembers.
 *
 * Document and section titles are deliberately absent. Searching "ResNet" in a
 * note panel and being handed every note in the ResNet paper is not a search
 * result, it is the whole list.
 */
export function searchableText(annotation: AnnotationView): string {
  const parts = [annotation.comment ?? "", annotation.quote];
  for (const target of annotation.targets) parts.push(target.quote);
  return normalizeForSearch(parts.join("\n"));
}

/** The query as separate words. One word for most queries; two or more rarely. */
export function termsOf(normalizedQuery: string): string[] {
  return normalizedQuery.split(" ").filter(Boolean);
}

/** Does this text contain the query as one unbroken substring? */
export function matchesPhrase(haystack: string, normalizedQuery: string): boolean {
  return normalizedQuery === "" || haystack.includes(normalizedQuery);
}

/** Does this text contain every word of the query, in any order? */
export function matchesAllTerms(haystack: string, terms: readonly string[]): boolean {
  return terms.every((term) => haystack.includes(term));
}

/**
 * Does this annotation answer the query? Phrase first, then every word.
 *
 * **Exposed for a single annotation, but the fallback only makes sense for a
 * whole list** — see `filterAnnotations`, which is what the panel calls. On its
 * own this answers the per-annotation question and cannot know whether any note
 * contains the phrase.
 */
export function matchesQuery(haystack: string, normalizedQuery: string): boolean {
  if (matchesPhrase(haystack, normalizedQuery)) return true;
  const terms = termsOf(normalizedQuery);
  return terms.length >= 2 && matchesAllTerms(haystack, terms);
}

/**
 * The comparable forms of a list, computed once per list.
 *
 * Normalising on every keystroke would do the expensive half of the work five
 * hundred times to answer one question — the corpus does not change while the
 * reader types. Keyed by annotation id, and rebuilt only when the list itself is
 * replaced by a create, edit or delete.
 */
export function buildSearchIndex(
  annotations: readonly AnnotationView[],
): Map<string, string> {
  const index = new Map<string, string>();
  for (const annotation of annotations) {
    index.set(annotation.id, searchableText(annotation));
  }
  return index;
}

/**
 * The annotations matching a query, in the order they were given.
 *
 * Order is never changed here. The panel sorts by source position — the paper's
 * order — and a filter that reordered its input would silently become a second
 * ordering rule.
 *
 * ## The two passes, and why the fallback is decided for the list
 *
 * A reader can put a space in a query for two quite different reasons:
 *
 *   `Algorithm 1` — one identifier. They want the notes containing that phrase
 *                   and nothing else, and a search that also returned notes
 *                   merely containing "algorithm" and "1" somewhere would be
 *                   answering a question they did not ask.
 *   `ResNet 退化` — two requirements in two scripts. **No note contains that
 *                   literal string**, and answering "no notes" would tell the
 *                   reader their note is missing when it is right there.
 *
 * So the phrase pass runs first and, if *any* annotation contains it, that is the
 * whole answer — which is what keeps `Algorithm 1` exact. Only when no
 * annotation anywhere contains the phrase do the words become separate
 * requirements. Deciding that per annotation instead would silently widen every
 * phrase query, which is the failure this shape avoids.
 *
 * Still no ranking: the result is always a subset of the catalogue order.
 */
export function filterAnnotations(
  annotations: readonly AnnotationView[],
  index: Map<string, string>,
  query: string,
): AnnotationView[] {
  const normalized = normalizeForSearch(query);
  if (normalized === "") return [...annotations];

  const haystackOf = (annotation: AnnotationView) =>
    index.get(annotation.id) ?? searchableText(annotation);

  const phrase = annotations.filter((a) => haystackOf(a).includes(normalized));
  if (phrase.length > 0) return phrase;

  const terms = termsOf(normalized);
  if (terms.length < 2) return [];
  return annotations.filter((a) => matchesAllTerms(haystackOf(a), terms));
}
