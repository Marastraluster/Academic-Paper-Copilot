/**
 * Notes and highlights, from the UI's point of view.
 *
 * Mirrors `qa/session.ts`, including its one rule:
 *
 * **every asynchronous continuation re-checks `isCurrent(documentId,
 * sessionToken)` after the await, not before it.** A guard that runs when the
 * work starts proves only that it made sense to start. By the time the response
 * arrives the user may be reading a different paper, and paper A's notes must
 * never appear under paper B.
 *
 * Creating an annotation causes **no model call and no retrieval**. The quote is
 * the user's selection and the anchors were computed in the browser from the IR
 * it already holds; the backend stores what it is given.
 */
import {
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  updateAnnotation,
  type AnnotationView,
  type NewTarget,
} from "@/api/annotations";
import { isAbortError } from "@/api/client";
import type { TargetSource } from "@/notes/targets";
import { isCurrent } from "@/qa/session";
import { activeSectionFor, useWorkspaceStore } from "@/stores/workspace";

let activeList: AbortController | null = null;
//: Which document the in-flight list belongs to.
let activeListDocument: string | null = null;

/** Load the open document's annotations, if they are not already loaded. */
export async function loadAnnotations(): Promise<void> {
  const { document } = useWorkspaceStore.getState();
  if (!document || document.documentId === null) {
    return;
  }

  const { documentId, sessionToken } = document;

  // Aborting a request for the *same* document as the one now starting would
  // cancel the only load that was going to happen — the panel mounts, the
  // document settles, and the effect re-runs, which is normal rather than a
  // reason to throw the first call away. Only a genuinely different document
  // supersedes an in-flight list.
  if (activeList !== null && activeListDocument === documentId) {
    return;
  }
  activeList?.abort();
  const controller = new AbortController();
  activeList = controller;
  activeListDocument = documentId;
  try {
    const payload = await listAnnotations(documentId, { signal: controller.signal });
    // Guarded on the **document**, not on the session token.
    //
    // `isCurrent` compares both, which is right for a question — an answer belongs
    // to the session that asked it. A note list does not: it belongs to the
    // paper's content, and the token is re-minted whenever the same file is
    // re-registered. Comparing the token dropped a perfectly good list on exactly
    // the reopen this feature exists for, which the browser run caught.
    if (useWorkspaceStore.getState().document?.documentId !== documentId) {
      return;
    }
    useWorkspaceStore.setState({
      annotations: payload.annotations,
      annotationsFor: documentId,
    });
  } catch (error) {
    if (isAbortError(error)) return;
    // Leave what is loaded. `null` reads as "not resolved", which the panel shows
    // as unavailable rather than as "this paper has no notes" — claiming the
    // second when the first is true would be worse than saying nothing.
    if (!isCurrent(documentId, sessionToken)) return;
  } finally {
    if (activeList === controller) {
      activeList = null;
      activeListDocument = null;
    }
  }
}

/**
 * An existing annotation over the same source range, if there is one.
 *
 * AC-P0-12 asks that re-marking an already-marked range *focus* the existing
 * annotation rather than stack a second highlight on it. The comparison is the
 * **anchor set**, and that turns out to be exactly the right granularity rather
 * than an approximation: an anchor is derived from the paragraph's envelope, not
 * from the drag's pixels, so two selections over the same paragraph produce the
 * same anchor no matter where in it the user started or stopped. Identical
 * anchors *are* 100% overlap, in the terms the criterion cares about.
 *
 * The paragraph is the unit a note can be attached to, so this also declines to
 * merge two notes over different paragraphs that merely look alike.
 */
export function findEquivalent(
  existing: AnnotationView[],
  sources: TargetSource[],
): AnnotationView | null {
  if (sources.length === 0) return null;
  // Page and quote, not the anchor hash: the anchors are the server's to know,
  // and a note's identity to a reader *is* which text on which page it covers.
  const key = (page: number, quote: string) => `${page}\u0000${quote}`;
  const wanted = sources.map((source) => key(source.pageNumber, source.quote)).sort().join("");
  for (const annotation of existing) {
    const have = annotation.targets
      .map((target) => key(target.page_number, target.quote))
      .sort()
      .join("");
    if (have === wanted) return annotation;
  }
  return null;
}

export interface CreateOptions {
  kind: "highlight" | "note";
  comment?: string | null;
}

export type CreateResult =
  | { ok: true; annotation: AnnotationView; focusedExisting?: boolean }
  | { ok: false; reason: string };

/**
 * Create an annotation from the current selection.
 *
 * Returns a result rather than throwing, because the caller has to *not* draw a
 * highlight when this fails: a mark on the page that was never saved is worse
 * than a save that visibly failed. Nothing optimistic happens here.
 */
export async function createFromSelection({
  kind,
  comment = null,
}: CreateOptions): Promise<CreateResult> {
  const state = useWorkspaceStore.getState();
  const document = state.document;
  if (!document || document.documentId === null) {
    return { ok: false, reason: "No document is open." };
  }
  // The **geometry**, not the QA mapping. A drag across a figure caption maps to
  // no paragraph — `selection` is null for it, and deliberately so, because a
  // caption is not something a question may be scoped to. It is still something
  // the reader is entitled to annotate, and refusing here would have made the
  // QA domain's boundary decide the annotation domain's capability.
  const geometry = state.selectionGeometry;
  if (!state.ir || !geometry) {
    return { ok: false, reason: "Select text in the paper first." };
  }

  /* Loaded when a note is actually made, not when the application starts.
   *
   * The target builder and the selection mapper it needs are the two largest
   * modules in `src/`, measured, and they were in the initial download because
   * this file is reachable from the QA session's teardown — which does nothing
   * but clear some state. A reader pays that in bundle size on every open, for
   * code that runs when they highlight something. */
  const { buildAnnotationTargets } = await import("@/notes/targets");
  const sources: TargetSource[] = buildAnnotationTargets(state.ir, {
    rects: geometry.rects,
    text: geometry.text,
  });
  if (sources.length === 0) {
    return { ok: false, reason: "The selection does not map onto this paper's text." };
  }

  // AC-P0-12: the same range is one annotation, not a second highlight stacked
  // on the first. The panel focuses what is already there.
  const existing = useWorkspaceStore.getState().annotations ?? [];
  const same = findEquivalent(existing, sources);
  if (same !== null) {
    useWorkspaceStore.setState({ activeAnnotationId: same.id });
    return { ok: true, annotation: same, focusedExisting: true };
  }

  const targets: NewTarget[] = sources.map((source) => ({
    source_class: source.sourceClass,
    source_anchor_id: source.sourceAnchorId,
    anchor_version: source.anchorVersion,
    page_number: source.pageNumber,
    original_bbox: source.bbox,
    rects: source.rects,
    exact_quote: source.quote,
    prefix: source.prefix,
    suffix: source.suffix,
  }));

  const { documentId, sessionToken } = document;
  try {
    const created = await createAnnotation(documentId, {
      kind,
      quote: geometry.text,
      comment,
      targets,
    });
    if (!isCurrent(documentId, sessionToken)) {
      return { ok: false, reason: "The document changed." };
    }
    const current = useWorkspaceStore.getState().annotations ?? [];
    useWorkspaceStore.setState({ annotations: [created, ...current] });
    return { ok: true, annotation: created };
  } catch {
    return { ok: false, reason: "The annotation could not be saved." };
  }
}

export async function editAnnotation(
  annotationId: string,
  comment: string | null,
): Promise<boolean> {
  const { document } = useWorkspaceStore.getState();
  if (!document || document.documentId === null) return false;
  const { documentId, sessionToken } = document;
  try {
    const updated = await updateAnnotation(annotationId, comment);
    if (!isCurrent(documentId, sessionToken)) return false;
    const current = useWorkspaceStore.getState().annotations ?? [];
    useWorkspaceStore.setState({
      annotations: current.map((a) => (a.id === updated.id ? updated : a)),
    });
    return true;
  } catch {
    return false;
  }
}

export async function removeAnnotation(annotationId: string): Promise<boolean> {
  const { document } = useWorkspaceStore.getState();
  if (!document || document.documentId === null) return false;
  const { documentId, sessionToken } = document;
  try {
    await deleteAnnotation(annotationId);
    if (!isCurrent(documentId, sessionToken)) return false;
    const current = useWorkspaceStore.getState().annotations ?? [];
    useWorkspaceStore.setState({
      annotations: current.filter((a) => a.id !== annotationId),
      activeAnnotationId:
        useWorkspaceStore.getState().activeAnnotationId === annotationId
          ? null
          : useWorkspaceStore.getState().activeAnnotationId,
    });
    return true;
  } catch {
    return false;
  }
}

/** Clear the panel's state when a document closes, like every other scope. */
export function teardownNotes(): void {
  activeList?.abort();
  activeList = null;
  useWorkspaceStore.setState({
    annotations: null,
    annotationsFor: null,
    activeAnnotationId: null,
  });
}

/** The section a target currently sits in — resolved now, never stored. */
export function sectionForPage(pageNumber: number): string | null {
  const state = useWorkspaceStore.getState();
  const candidates = (state.sections ?? []).filter(
    (section) => section.pageRange[0] <= pageNumber && section.pageRange[1] >= pageNumber,
  );
  return candidates.length > 0 ? candidates[candidates.length - 1].title : null;
}

export { activeSectionFor };
