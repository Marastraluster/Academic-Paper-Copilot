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
import {
  useWorkspaceStore,
  type OpenDocument,
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
