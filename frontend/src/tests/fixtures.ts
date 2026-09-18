/**
 * Store seeding helpers for tests.
 *
 * DS-FE-003 made the reader modes real: `双语` and `译文` are disabled until a
 * translation exists, and the status bar reports only measured values. Tests
 * that need to exercise those views therefore have to establish the precondition
 * first, exactly as a user would by translating a document.
 *
 * `setup.ts` restores the store to its initial state after every test, so
 * anything seeded here is automatically undone.
 */
import type { SelectionMapping } from "@/qa/selection";
import {
  useWorkspaceStore,
  type OpenDocument,
  type SelectionState,
  type TranslationState,
} from "@/stores/workspace";

export function makePdfFile(name = "paper.pdf"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "application/pdf" });
}

export const TEST_SESSION = "open-test";
export const TEST_DOCUMENT_ID = "doc_test";

export function seedDocument(overrides: Partial<OpenDocument> = {}): OpenDocument {
  const document: OpenDocument = {
    sessionToken: TEST_SESSION,
    name: "paper.pdf",
    file: makePdfFile(),
    documentId: TEST_DOCUMENT_ID,
    registration: "ready",
    registrationError: null,
    backendPageCount: 18,
    ...overrides,
  };
  useWorkspaceStore.setState({ document });
  return document;
}

/**
 * Seed a completed translation for the open document.
 *
 * Defaults to a *successful* run with an artifact, which is the precondition for
 * the translated reader modes. Pass `overrides` to model another state.
 */
export function seedTranslation(
  overrides: Partial<TranslationState> = {},
): TranslationState {
  const document = useWorkspaceStore.getState().document;
  const translation: TranslationState = {
    documentId: document?.documentId ?? TEST_DOCUMENT_ID,
    sessionToken: document?.sessionToken ?? TEST_SESSION,
    taskId: "task_test",
    status: "success",
    progress: null,
    error: null,
    monoUrl: "blob:test-translated",
    monoPageCount: 18,
    degraded: false,
    ...overrides,
  };
  useWorkspaceStore.setState({ translation });
  return translation;
}

/** A document that has been translated and is ready to read in both panes. */
export function seedTranslatedDocument(
  document: Partial<OpenDocument> = {},
  translation: Partial<TranslationState> = {},
): { document: OpenDocument; translation: TranslationState } {
  const seeded = seedDocument(document);
  return { document: seeded, translation: seedTranslation(translation) };
}

/* ------------------------------------------------------------------ *
 * Paper QA (DS-QA-003)
 * ------------------------------------------------------------------ */

export const TEST_PROFILE_ID = "prof_qa";

/**
 * A provider profile, so the composer is usable.
 *
 * Paper QA cannot ask anything without one, and "no provider configured" is a
 * distinct state from "no document" — a test that forgets this measures the
 * wrong disabled state.
 */
export function seedQaProvider(id: string = TEST_PROFILE_ID): void {
  useWorkspaceStore.getState().setProfiles([
    {
      id,
      name: "Deepseek",
      base_url: "http://127.0.0.1:9/v1",
      model: "deepseek-flash",
      protocol: "auto",
      has_key: true,
      api_key_masked: "sk-••••••••test",
    },
  ]);
}

/** A document outline, so Section scope has a real identity. */
export function seedQaSections(): void {
  useWorkspaceStore.getState().setSections([
    {
      id: "sec_1", title: "1. Introduction", level: 1, parentId: null,
      pageNumber: 1, pageRange: [1, 2], bbox: [50, 70, 200, 84],
      anchor: "heading", isReferences: false,
    },
    {
      id: "sec_2", title: "2. Method", level: 1, parentId: null,
      pageNumber: 3, pageRange: [3, 6], bbox: [50, 70, 200, 84],
      anchor: "heading", isReferences: false,
    },
    {
      id: "sec_3", title: "3. Results", level: 1, parentId: null,
      pageNumber: 7, pageRange: [7, 8], bbox: [50, 70, 200, 84],
      anchor: "heading", isReferences: false,
    },
  ]);

  // The canonical geometry the reading position is resolved against. Seeded
  // because production always has it: `translation/session.ts` fetches the IR as
  // part of registration, so a document with sections but no IR is a state the
  // app never reaches. One block per page, each owned by the section whose page
  // range covers it — enough for the rule to resolve a page to a section.
  const owner = (page: number) =>
    page <= 2 ? "sec_1" : page <= 6 ? "sec_2" : "sec_3";
  const pages = Array.from({ length: 8 }, (_, index) => {
    const page = index + 1;
    return {
      page_number: page,
      width_pt: 595,
      height_pt: 842,
      rotation: 0,
      blocks: [
        {
          id: `b_p${page}`, page_number: page, layout_class: "plain text",
          bbox: [50, 70, 545, 700] as [number, number, number, number],
          text: `page ${page}`,
        },
      ],
    };
  });
  const paragraphs = Array.from({ length: 8 }, (_, index) => {
    const page = index + 1;
    return {
      id: `p_${page}`, section_id: owner(page), text: `page ${page}`,
      page_number: page, page_range: [page, page] as [number, number],
      block_ids: [`b_p${page}`], bboxes: [[50, 70, 545, 700] as [number, number, number, number]],
    };
  });
  useWorkspaceStore.getState().setIr({
    document_id: "doc_test",
    content_hash: "hash",
    page_count: 8,
    paragraphs,
    pages,
  } as never);
}

/** Everything needed to ask a question: a registered paper and a provider. */
export function seedQaReady(): OpenDocument {
  const document = seedDocument();
  seedQaProvider();
  return document;
}

/**
 * A resolved text selection, as `refreshSelection` would have stored it.
 *
 * Seeded rather than produced by a real drag: mapping a live browser Range in
 * jsdom measures nothing, and the mapping rules are covered directly in
 * `selection-mapping.test.ts`. What these fixtures exercise is everything
 * downstream — the scope selector, the payload, the invalidation.
 */
export function seedSelection(
  paragraphIds: string[] = ["p_0001"],
  overrides: Partial<SelectionMapping> = {},
): SelectionState {
  const document = useWorkspaceStore.getState().document;
  const state: SelectionState = {
    documentId: document?.documentId ?? TEST_DOCUMENT_ID,
    sessionToken: document?.sessionToken ?? TEST_SESSION,
    mapping: {
      status: "valid",
      paragraphIds,
      pages: [1],
      text: "Deeper neural networks are more difficult to train.",
      truncated: false,
      ...overrides,
    },
  };
  useWorkspaceStore.setState({ selection: state, selectionStatus: state.mapping.status });
  return state;
}
