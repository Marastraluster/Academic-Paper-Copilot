/**
 * The sidebar's view of Paper QA: whether it can be used, and how to ask.
 *
 * Pure derivation over the store — no fetching. Profiles and sections are loaded
 * once by the document session when registration completes, because four
 * components need to know whether a provider exists and four copies of that
 * question would be four requests.
 */
import { useCallback, useMemo } from "react";

import { askQa, retryTurn, scopeAvailability } from "@/qa/session";
import { activeSectionFor } from "@/stores/workspace";
import type { MappingStatus, SelectionMapping } from "@/qa/selection";
import {
  QUICK_ACTIONS,
  selectActiveSelection,
  selectActiveTurns,
  useWorkspaceStore,
  type QaScopeType,
  type QaTurn,
} from "@/stores/workspace";

export interface QaSession {
  /** Registration has finished and there is a document id to ask about. */
  ready: boolean;
  /** Why not, when not ready: `pending` while uploading, `failed` on error. */
  documentState: "none" | "pending" | "failed" | "ready";
  /** True when a provider is configured. `false` with `profiles === []`. */
  hasProfile: boolean;
  profileId: string;
  /** Set when the provider list itself could not be read. */
  profilesError: string | null;
  submitting: boolean;
  scope: QaScopeType;
  setScope: (scope: QaScopeType) => void;
  availability: Record<QaScopeType, boolean>;
  /** The resolved selection for the open document, or `null`. */
  selection: SelectionMapping | null;
  /** Why the last selection attempt was refused, if it was. */
  selectionStatus: MappingStatus | null;
  /** True when the composer's question could be sent right now. */
  canAsk: boolean;
  /**
   * True when a *prewritten* question could be sent right now.
   *
   * Separate from `canAsk` because a quick action brings its own question: tying
   * it to the composer's contents would disable every shortcut until the user
   * typed something, which is the opposite of what a shortcut is for.
   */
  canRunAction: boolean;
  turns: QaTurn[];
  ask: (questionOverride?: string) => Promise<void>;
  askQuickAction: (action: (typeof QUICK_ACTIONS)[number]) => Promise<void>;
  retry: (turnId: string) => Promise<void>;
  /** Ask the same question across the whole paper, after an abstention. */
  widen: (turnId: string) => Promise<void>;
}

export function useQaSession(): QaSession {
  const document = useWorkspaceStore((s) => s.document);
  const scope = useWorkspaceStore((s) => s.scope);
  const setScope = useWorkspaceStore((s) => s.setScope);
  const question = useWorkspaceStore((s) => s.question);
  const submitting = useWorkspaceStore((s) => s.submitting);
  const activePage = useWorkspaceStore((s) => s.activePage);
  const sections = useWorkspaceStore((s) => s.sections);
  const activeSectionId = useWorkspaceStore((s) => s.activeSectionId);
  const selectedSectionId = useWorkspaceStore((s) => s.selectedSectionId);
  const profilesError = useWorkspaceStore((s) => s.profilesError);
  const profileId = useWorkspaceStore((s) => s.profileId);
  // `selectActiveTurns` filters, so it returns a fresh array every call. Feeding
  // it to the store directly makes every render look like a state change and
  // React bails out with "maximum update depth exceeded". Selecting the raw list
  // and deriving here keeps the reference stable between renders.
  const allTurns = useWorkspaceStore((s) => s.turns);
  const selectionState = useWorkspaceStore((s) => s.selection);
  const selectionStatus = useWorkspaceStore((s) => s.selectionStatus);
  const turns = useMemo(
    () => selectActiveTurns({ document, turns: allTurns }),
    [document, allTurns],
  );

  const documentState: QaSession["documentState"] = !document
    ? "none"
    : document.registration === "ready" && document.documentId !== null
      ? "ready"
      : document.registration === "failed"
        ? "failed"
        : "pending";
  const ready = documentState === "ready";
  const hasProfile = profileId !== "";

  const selection = useMemo(
    () =>
      selectActiveSelection({ document, selection: selectionState })?.mapping ?? null,
    [document, selectionState],
  );

  // AC_CHANGE_REQUEST 4: the explicitly selected section wins and is sticky;
  // otherwise the one the reading position resolves to.
  const section = useMemo(
    () => activeSectionFor({ sections, activeSectionId, selectedSectionId }),
    [sections, activeSectionId, selectedSectionId],
  );

  const availability = useMemo(
    () => scopeAvailability(activePage, selection, section),
    [activePage, selection, section],
  );

  const ask = useCallback(
    async (questionOverride?: string) => {
      await askQa({
        question: questionOverride ?? useWorkspaceStore.getState().question,
        profileId: useWorkspaceStore.getState().profileId,
      });
    },
    [],
  );

  const askQuickAction = useCallback(
    async (action: (typeof QUICK_ACTIONS)[number]) => {
      if (!action.enabled) return;
      await askQa({
        question: action.question,
        profileId: useWorkspaceStore.getState().profileId,
        // The action's own scope, or whatever is selected when it does not
        // prescribe one. Never a silently different scope: the badge on the
        // resulting turn records which one was used.
        scopeOverride: action.scope ?? undefined,
        fromComposer: false,
      });
    },
    [],
  );

  const retry = useCallback(async (turnId: string) => {
    await retryTurn(turnId);
  }, []);

  const widen = useCallback(async (turnId: string) => {
    const turn = useWorkspaceStore.getState().turns.find((item) => item.id === turnId);
    if (!turn) return;
    await askQa({
      question: turn.question,
      profileId: useWorkspaceStore.getState().profileId,
      scopeOverride: "whole_paper",
      fromComposer: false,
    });
  }, []);

  return {
    ready,
    documentState,
    hasProfile,
    profileId,
    profilesError,
    submitting,
    scope,
    setScope,
    availability,
    selection,
    selectionStatus,
    // A question with nothing in it is not askable, and neither is one that
    // already has an answer on its way. Under a Selection an empty question *is*
    // askable — "explain what I highlighted" — because the selection is the
    // evidence and there is nothing to search for.
    canAsk:
      ready &&
      hasProfile &&
      !submitting &&
      (question.trim() !== "" || (scope === "selection" && availability.selection)),
    canRunAction: ready && hasProfile && !submitting,
    turns,
    ask,
    askQuickAction,
    retry,
    widen,
  };
}
