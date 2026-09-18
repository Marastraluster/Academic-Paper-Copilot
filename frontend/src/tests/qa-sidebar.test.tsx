import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getDocument = vi.fn();

/** Same reasoning as the viewer suite: real PDF.js in jsdom proves nothing. */
vi.mock("@/pdf/pdfjs", () => {
  const STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0];
  const module = {
    getDocument: (...args: unknown[]) => getDocument(...args),
    TextLayer: class {
      render() {
        return Promise.resolve();
      }
      cancel() {}
    },
    setLayerDimensions: () => {},
    GlobalWorkerOptions: {},
  };
  return {
    loadPdfjs: () => Promise.resolve(module),
    ZOOM_STEPS: STEPS,
    MIN_ZOOM: STEPS[0],
    MAX_ZOOM: STEPS[STEPS.length - 1],
    FIT_WIDTH_PADDING_PX: 32,
    RENDER_BUFFER_MARGIN_PX: 300,
    clampZoom: (s: number) => Math.min(3, Math.max(0.5, s)),
    zoomIn: (s: number) => STEPS.find((x) => x > s + 1e-6) ?? 3,
    zoomOut: (s: number) => [...STEPS].reverse().find((x) => x < s - 1e-6) ?? 0.5,
  };
});

import { App } from "@/app/App";
import {
  useWorkspaceStore,
  type QaScopeType,
  type QaSection,
} from "@/stores/workspace";
import type { MappingStatus } from "@/qa/selection";
import {
  seedDocument,
  seedQaProvider,
  seedQaSections,
  seedSelection,
} from "@/tests/fixtures";

/* ------------------------------------------------------------------ *
 * Backend doubles
 * ------------------------------------------------------------------ */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

const fetchMock = vi.fn();

/** Every answer request gets this body. */
function replyWith(body: unknown, status = 200): void {
  fetchMock.mockImplementation(async () => jsonResponse(body, status));
}

function deniedAnswer(code: string, message: string): void {
  fetchMock.mockImplementation(async () =>
    jsonResponse({ error: { code, message, detail: {} } }, 502),
  );
}

function fakeDocument(pageCount = 12) {
  return {
    numPages: pageCount,
    getPage: vi.fn(async () => ({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
        rotation: 0,
      }),
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
      streamTextContent: () => ({}),
    })),
  };
}

const citation = (overrides: Record<string, unknown> = {}) => ({
  citation_id: "E1",
  paragraph_id: "p_0001",
  section_id: "sec_2",
  section_title: "2. Method",
  page_number: 3,
  page_range: [3, 3],
  block_ids: ["b_0001"],
  bboxes: [[72, 100, 540, 130]],
  snippet: "We adopt residual learning to solve the degradation problem.",
  is_caption: false,
  ...overrides,
});

const answered = (overrides: Record<string, unknown> = {}) => ({
  document_id: "doc_test",
  question: "q",
  status: "answered",
  answer: "Residual learning reformulates the mapping. [E1]",
  citations: [citation()],
  unanswered_aspects: [],
  missing_evidence_rationale: null,
  diagnostics: { code: "SUCCESS", suggest_scope_expansion: false },
  ...overrides,
});

/**
 * Render the app with a registered paper, a provider, and an outline.
 *
 * Everything is seeded *before* render. Updating the store afterwards leaves
 * React to reconcile a change made outside its own event, which is both a
 * warning and a real difference from how the app is used — a reader is on a page
 * before they ask about it, not after.
 */
function setupScene(
  options: {
    page?: number;
    /** `undefined` seeds a normal outline; `[]` is a paper with none. */
    outline?: QaSection[] | null;
    scope?: QaScopeType;
    /** Paragraph ids a drag resolved to, or a refusal status instead. */
    selection?: string[] | { status: MappingStatus };
  } = {},
) {
  const document = seedDocument();
  seedQaProvider();
  if (options.outline === undefined) seedQaSections();
  else useWorkspaceStore.getState().setSections(options.outline);
  if (options.page !== undefined) useWorkspaceStore.getState().setActivePage(options.page);
  if (options.scope !== undefined) useWorkspaceStore.getState().setScope(options.scope);
  if (Array.isArray(options.selection)) seedSelection(options.selection);
  else if (options.selection) {
    useWorkspaceStore.setState({
      selection: null,
      selectionStatus: options.selection.status,
    });
  }
  render(<App />);
  return document;
}

async function ask(user: ReturnType<typeof userEvent.setup>, text = "什么是退化问题？") {
  await user.type(screen.getByTestId("qa-composer"), text);
  await user.click(screen.getByTestId("composer-send"));
}

beforeEach(() => {
  getDocument.mockReset();
  getDocument.mockReturnValue({
    promise: Promise.resolve(fakeDocument()),
    destroy: vi.fn(async () => undefined),
  });
  fetchMock.mockReset();
  // `vi.unstubAllGlobals()` must not be used here: `setup.ts` installs the
  // IntersectionObserver and ResizeObserver stubs the PDF viewer needs through
  // the same mechanism, and unstubbing would remove them for every later test in
  // this file — which showed up as the whole shell crashing with
  // "IntersectionObserver is not defined".
  vi.stubGlobal("fetch", fetchMock);
});

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

describe("DS-QA-003 · sidebar lifecycle", () => {
  it("disables everything and explains itself when no paper is open (AC-P0-01)", () => {
    render(<App />);

    expect(screen.getByTestId("qa-composer")).toBeDisabled();
    expect(screen.getByTestId("scope-selector")).toBeDisabled();
    // Scoped to the sidebar: the top bar also says "未打开文档".
    expect(
      within(screen.getByTestId("conversation-area")).getByText("未打开文档"),
    ).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("waits for backend registration before enabling a question (AC-P0-02)", () => {
    seedQaProvider();
    useWorkspaceStore.setState({
      document: {
        sessionToken: "open-1",
        name: "paper.pdf",
        file: new File([new Uint8Array([1])], "paper.pdf"),
        documentId: null,
        registration: "pending",
        registrationError: null,
        backendPageCount: null,
      },
    });
    render(<App />);

    expect(screen.getByTestId("qa-composer")).toBeDisabled();
    // Honest about what is happening: it is an upload, not an index build.
    expect(screen.getByText("正在把文档注册到后端…")).toBeInTheDocument();
  });

  it("says the registration failed rather than blaming the question (AC-P0-02)", () => {
    useWorkspaceStore.setState({
      document: {
        sessionToken: "open-1",
        name: "paper.pdf",
        file: new File([new Uint8Array([1])], "paper.pdf"),
        documentId: null,
        registration: "failed",
        registrationError: { title: "x", detail: "y", code: "Z", retryable: false },
        backendPageCount: null,
      },
    });
    render(<App />);

    expect(screen.getByText("文档注册失败")).toBeInTheDocument();
    expect(screen.getByTestId("qa-composer")).toBeDisabled();
  });

  it("names the command that configures a provider when none exists (AC-P0-08)", async () => {
    seedDocument();
    render(<App />);

    expect(screen.getByTestId("qa-no-profiles")).toBeInTheDocument();
    expect(screen.getByTestId("composer-send")).toBeDisabled();
    expect(screen.getByText(/configure_provider\.py/)).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Scopes
 * ------------------------------------------------------------------ */

describe("DS-QA-003 · scopes", () => {
  it("offers the four scopes and disables the ones without an identity (AC-P0-04)", () => {
    setupScene();
    const select = screen.getByTestId("scope-selector");

    const options = within(select)
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).textContent);

    expect(options[0]).toBe("当前论文");
    expect(options[1]).toBe("当前页（第 1 页）");
    expect(options[2]).toBe("当前章节");
    // DS-QA-005 implemented Selection, so it is no longer "not yet supported" —
    // it is disabled because nothing is selected, which is a different sentence
    // and a different fix. It must still be disabled and say so rather than
    // answering the whole paper under a Selection label.
    expect(options[3]).toBe("选中内容（未选择）");
    expect(
      within(select).getByRole("option", { name: "选中内容（未选择）" }),
    ).toBeDisabled();
  });

  it("labels an outline-less paper honestly instead of claiming a section (AC-P0-04)", () => {
    setupScene({ outline: [] });

    expect(screen.getByText("当前章节（无目录结构）")).toBeInTheDocument();
  });

  it("sends whole_paper, never the UI's old word for it (AC-P0-05)", async () => {
    const user = userEvent.setup();
    setupScene();
    replyWith(answered());

    await ask(user);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.scope).toEqual({ type: "whole_paper" });
    expect(body.profile_id).toBe("prof_qa");
  });

  it("sends the page the original viewer is on, 1-based and unshifted (AC-P0-15)", async () => {
    const user = userEvent.setup();
    setupScene({ page: 4, scope: "page" });
    replyWith(answered());

    await ask(user);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.scope).toEqual({ type: "page", page: 4 });
  });

  it("resolves the section governing the current page (AC-P0-04)", async () => {
    const user = userEvent.setup();
    setupScene({ page: 8, scope: "section" });
    replyWith(answered());

    await ask(user);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    // Page 8 is inside "3. Results" (page 7), not "2. Method" (page 3).
    expect(body.scope).toEqual({ type: "section", section_id: "sec_3" });
  });

  it("refuses to send a section scope it cannot resolve (AC-P0-05)", async () => {
    const user = userEvent.setup();
    setupScene({ outline: [], scope: "section" });
    replyWith(answered());

    await ask(user);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the scope a past answer was asked in, even after the selector moves (AC-P0-19)", async () => {
    const user = userEvent.setup();
    setupScene();
    replyWith(answered());

    await ask(user);
    await waitFor(() => expect(screen.getByTestId("reference-list")).toBeInTheDocument());

    // The selector moves *after* the answer; the card must not follow it.
    useWorkspaceStore.getState().setScope("page");

    // The card records what was searched, not what is selected now.
    const card = screen.getByTestId(/qa-turn-/);
    expect(within(card).getByText("整篇论文")).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * The question box
 * ------------------------------------------------------------------ */

describe("DS-QA-003 · composer", () => {
  it("does not submit Enter while a Chinese IME composition is open (AC-P0-06)", async () => {
    const user = userEvent.setup();
    setupScene();
    replyWith(answered());

    const composer = screen.getByTestId("qa-composer");
    await user.type(composer, "退化");

    // Confirm a Pinyin candidate: Enter during composition must not send.
    await user.click(composer);
    composer.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    await user.keyboard("{Enter}");
    expect(fetchMock).not.toHaveBeenCalled();

    // Composition closed, and now Enter is a submit.
    composer.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await user.keyboard("{Enter}");

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it("refuses a whitespace-only question (AC-P0-07)", async () => {
    const user = userEvent.setup();
    setupScene();

    await user.type(screen.getByTestId("qa-composer"), "   ");

    expect(screen.getByTestId("composer-send")).toBeDisabled();
    await user.keyboard("{Enter}");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cannot start a second question while one is in flight (AC-P0-07)", async () => {
    const user = userEvent.setup();
    setupScene();
    let release: (value: Response) => void = () => {};
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );

    await ask(user);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect(screen.getByTestId("composer-send")).toBeDisabled();
    await user.click(screen.getByTestId("composer-send"));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release(jsonResponse(answered()));
    await waitFor(() => expect(screen.queryByTestId("qa-pending")).not.toBeInTheDocument());
  });

  it("allows the same question to be asked again once it has finished (AC-P0-42)", async () => {
    const user = userEvent.setup();
    setupScene();
    replyWith(answered());

    await ask(user, "同一个问题");
    await waitFor(() => expect(screen.getByTestId("reference-list")).toBeInTheDocument());

    await ask(user, "同一个问题");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

/* ------------------------------------------------------------------ *
 * The four semantic states, and the two that are not answers
 * ------------------------------------------------------------------ */

describe("DS-QA-003 · answer states", () => {
  it("renders a grounded answer with numbered chips and no raw evidence id (AC-P0-10)", async () => {
    const user = userEvent.setup();
    setupScene();
    replyWith(answered());

    await ask(user);
    await waitFor(() => expect(screen.getByTestId("qa-answer-body")).toBeInTheDocument());

    expect(screen.getByTestId("citation-chip-1")).toHaveTextContent("1");
    expect(screen.getByTestId("reference-list")).toHaveTextContent("第 3 页");
    expect(screen.getByTestId("reference-list")).toHaveTextContent("2. Method");
    // The internal marker never reaches the reader.
    expect(screen.getByTestId("qa-answer-body")).not.toHaveTextContent("E1");
  });

  it("renders a partial answer with what the evidence could not settle (AC-P0-11)", async () => {
    const user = userEvent.setup();
    setupScene();
    replyWith(
      answered({
        status: "partial",
        answer: "The paper evaluates on CIFAR-10. [E1]",
        unanswered_aspects: ["the optimizer"],
      }),
    );

    await ask(user);
    await waitFor(() => expect(screen.getByTestId("qa-partial-notice")).toBeInTheDocument());

    expect(screen.getByTestId("qa-partial-notice")).toHaveTextContent("the optimizer");
    expect(screen.getByTestId("reference-list")).toBeInTheDocument();
  });

  it("presents an abstention as a grounded outcome, not a failure (AC-P0-12)", async () => {
    const user = userEvent.setup();
    setupScene();
    replyWith(
      answered({
        status: "insufficient_evidence",
        answer: "",
        citations: [],
        missing_evidence_rationale: "The evidence does not name an optimizer.",
      }),
    );

    await ask(user);
    await waitFor(() => expect(screen.getByTestId("qa-insufficient")).toBeInTheDocument());

    expect(screen.getByTestId("qa-insufficient")).toHaveTextContent("未找到充分证据");
    expect(screen.getByTestId("qa-insufficient")).toHaveTextContent("optimizer");
    // Not an error: no failure styling and no retry affordance.
    expect(screen.queryByTestId("qa-error")).not.toBeInTheDocument();
  });

  it("offers to widen the scope, but only when the backend says it would help (AC-P0-12)", async () => {
    const user = userEvent.setup();
    setupScene({ page: 4, scope: "page" });
    replyWith(
      answered({
        status: "insufficient_evidence",
        answer: "",
        citations: [],
        missing_evidence_rationale: "nothing here",
        diagnostics: { code: "SUCCESS", suggest_scope_expansion: true },
      }),
    );

    await ask(user);
    await waitFor(() => expect(screen.getByTestId(/qa-widen-/)).toBeInTheDocument());

    const widen = screen.getByTestId(/qa-widen-/);
    await user.click(widen);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
    expect(body.scope).toEqual({ type: "whole_paper" });
  });

  it("shows a provider failure as a failure, with its own words (AC-P0-13)", async () => {
    const user = userEvent.setup();
    setupScene();
    deniedAnswer("LLM_AUTHENTICATION_ERROR", "bad key");

    await ask(user);
    await waitFor(() => expect(screen.getByTestId("qa-error")).toBeInTheDocument());

    expect(screen.getByTestId("qa-error")).toHaveTextContent("模型服务认证失败");
    expect(screen.getByTestId("qa-error")).toHaveTextContent("API Key");
    // Nothing about the paper was learned, so nothing pretends otherwise.
    expect(screen.queryByTestId("qa-insufficient")).not.toBeInTheDocument();
  });

  it("retries the same question from the failure card (AC-P0-13)", async () => {
    const user = userEvent.setup();
    setupScene();
    deniedAnswer("LLM_RATE_LIMIT", "slow down");

    await ask(user);
    await waitFor(() => expect(screen.getByTestId(/qa-retry-/)).toBeInTheDocument());

    replyWith(answered());
    await user.click(screen.getByTestId(/qa-retry-/));

    await waitFor(() => expect(screen.getByTestId("reference-list")).toBeInTheDocument());
  });

  it("never presents an unrecognised status as an answer (AC-P0-14)", async () => {
    const user = userEvent.setup();
    setupScene();
    replyWith(answered({ status: "hedged" }));

    await ask(user);
    await waitFor(() => expect(screen.getByTestId("qa-unknown-status")).toBeInTheDocument());

    const card = screen.getByTestId("qa-unknown-status");
    expect(card).toHaveTextContent("hedged");
    // Still readable, and still cited — but inside a card that says so.
    expect(card).toHaveTextContent("未经确认");
    expect(within(card).getByTestId("qa-answer-body")).toBeInTheDocument();
    // And never in a card claiming the answer is grounded.
    expect(screen.getByTestId(/qa-turn-/)).toHaveAttribute("data-state", "unknown_status");
  });

  it("survives a body that is not an answer at all (AC-P0-14)", async () => {
    const user = userEvent.setup();
    setupScene();
    replyWith({ unexpected: true });

    await ask(user);
    await waitFor(() => expect(screen.getByTestId("qa-malformed")).toBeInTheDocument());
  });
});

/* ------------------------------------------------------------------ *
 * Citations
 * ------------------------------------------------------------------ */

describe("DS-QA-003 · citations", () => {
  it("keeps the answer's citation order rather than sorting by page (AC-P0-10)", async () => {
    const user = userEvent.setup();
    setupScene();
    replyWith(
      answered({
        answer: "First claim. [E2] Second claim. [E1]",
        citations: [
          citation({ citation_id: "E2", page_number: 9, section_title: "5. Later" }),
          citation({ citation_id: "E1", page_number: 3 }),
        ],
      }),
    );

    await ask(user);
    await waitFor(() => expect(screen.getByTestId("reference-list")).toBeInTheDocument());

    const cards = screen.getAllByTestId(/reference-card-/);
    expect(cards[0]).toHaveTextContent("第 9 页");
    expect(cards[1]).toHaveTextContent("第 3 页");
  });

  it("shows the real source excerpt in the reference card (AC-P0-10)", async () => {
    const user = userEvent.setup();
    setupScene();
    replyWith(answered());

    await ask(user);
    await waitFor(() => expect(screen.getByTestId("reference-list")).toBeInTheDocument());

    expect(screen.getByTestId("reference-list")).toHaveTextContent(
      "We adopt residual learning",
    );
  });

  it("labels a citation with its page and section for assistive technology (AC-P0-06)", async () => {
    const user = userEvent.setup();
    setupScene();
    replyWith(answered());

    await ask(user);
    await waitFor(() => expect(screen.getByTestId("citation-chip-1")).toBeInTheDocument());

    expect(screen.getByTestId("citation-chip-1")).toHaveAttribute(
      "aria-label",
      "引用 1，第 3 页，2. Method",
    );
  });

  it("keeps a citation it cannot navigate to, without a jump (AC-P0-37)", async () => {
    const user = userEvent.setup();
    setupScene();
    replyWith(answered({ citations: [{ ...citation(), page_number: null }] }));

    await ask(user);
    await waitFor(() => expect(screen.getByTestId("citation-chip-1")).toBeInTheDocument());

    expect(screen.getByTestId("citation-chip-1")).toBeDisabled();
    expect(screen.getByTestId("reference-list")).toHaveTextContent("第 ? 页");
  });
});

/* ------------------------------------------------------------------ *
 * Jumping, and the reader modes it has to respect
 * ------------------------------------------------------------------ */

describe("DS-QA-003 · citation jumping", () => {
  /** The store is the seam: the viewer's scroll is asserted through it. */
  const jump = () => useWorkspaceStore.getState().jumpRequest;

  it("requests the citation's page verbatim, with no off-by-one (AC-P0-16)", async () => {
    const user = userEvent.setup();
    setupScene();
    replyWith(answered());

    await ask(user);
    await waitFor(() => expect(screen.getByTestId("citation-chip-1")).toBeInTheDocument());
    await user.click(screen.getByTestId("citation-chip-1"));

    expect(jump()?.pageNumber).toBe(3);
    expect(jump()?.bboxes).toEqual([[72, 100, 540, 130]]);
  });

  it("stays in original mode and moves the original pane (AC-P0-16)", async () => {
    const user = userEvent.setup();
    setupScene();
    replyWith(answered());

    await ask(user);
    await waitFor(() => expect(screen.getByTestId("citation-chip-1")).toBeInTheDocument());
    await user.click(screen.getByTestId("citation-chip-1"));

    expect(useWorkspaceStore.getState().readerMode).toBe("original");
    expect(useWorkspaceStore.getState().notice).toBeNull();
  });

  it("switches out of translation mode, and says why it moved (AC-P0-18)", async () => {
    const user = userEvent.setup();
    const document = setupScene();
    useWorkspaceStore.setState({
      readerMode: "translation",
      translation: {
        documentId: document.documentId!,
        sessionToken: document.sessionToken,
        taskId: "task_1",
        status: "success",
        progress: null,
        error: null,
        monoUrl: "blob:test-translated",
        monoPageCount: 12,
        degraded: false,
      },
    });
    replyWith(answered());

    await ask(user);
    await waitFor(() => expect(screen.getByTestId("citation-chip-1")).toBeInTheDocument());
    await user.click(screen.getByTestId("citation-chip-1"));

    // A source page number and a source box mean nothing on a re-laid-out PDF.
    expect(useWorkspaceStore.getState().readerMode).toBe("original");
    expect(useWorkspaceStore.getState().notice).toContain("第 3 页");

    // The original pane was unmounted while the translation was showing, so this
    // is a *remount*. The highlight has to survive it: an effect that clears the
    // mark on a new document runs after the jump effect on mount, and a
    // separate one declared later wiped the mark the click had just asked for.
    await waitFor(() =>
      expect(screen.getByTestId("pdf-highlight-box")).toBeInTheDocument(),
    );
  });

  it("moves only the original pane in bilingual mode (AC-P0-17)", async () => {
    const user = userEvent.setup();
    const document = setupScene();
    useWorkspaceStore.setState({
      readerMode: "bilingual",
      translation: {
        documentId: document.documentId!,
        sessionToken: document.sessionToken,
        taskId: "task_1",
        status: "success",
        progress: null,
        error: null,
        monoUrl: "blob:test-translated",
        monoPageCount: 12,
        degraded: false,
      },
    });
    replyWith(answered());

    await ask(user);
    await waitFor(() => expect(screen.getByTestId("citation-chip-1")).toBeInTheDocument());
    await user.click(screen.getByTestId("citation-chip-1"));

    // The mode is untouched — both panes stay on screen, and only the original
    // was asked to move. The translated pane receives no jump and no boxes.
    expect(useWorkspaceStore.getState().readerMode).toBe("bilingual");
    expect(jump()?.pageNumber).toBe(3);
    expect(
      within(screen.getByTestId("viewer-translated")).queryByTestId("pdf-highlight-layer"),
    ).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------ *
 * Selection scope (DS-QA-005)
 * ------------------------------------------------------------------ */

describe("DS-QA-005 · selection scope", () => {
  it("keeps Selection disabled while nothing is selected (AC-11)", () => {
    setupScene();

    expect(
      within(screen.getByTestId("scope-selector")).getByRole("option", {
        name: "选中内容（未选择）",
      }),
    ).toBeDisabled();
  });

  it("enables Selection once a drag resolves, and previews it (AC-11)", () => {
    setupScene({ selection: ["p_0001", "p_0002"] });

    expect(
      within(screen.getByTestId("scope-selector")).getByRole("option", { name: "选中内容" }),
    ).toBeEnabled();
    const preview = screen.getByTestId("selection-preview");
    expect(preview).toHaveTextContent("已选 2 个段落");
    expect(preview).toHaveTextContent("Deeper neural networks");
  });

  it("enables it without silently changing the chosen scope (AC_CHANGE_REQUEST 2)", () => {
    // A reader highlighting a sentence to copy it must not have their scope
    // replaced. The mapping makes Selection available; choosing it is a user act.
    setupScene({ scope: "whole_paper", selection: ["p_0001"] });

    expect(useWorkspaceStore.getState().scope).toBe("whole_paper");
  });

  it("says which refusal it was, not just that it failed (AC-05, AC-06)", () => {
    setupScene({ selection: { status: "cross_page" } });

    expect(screen.getByTestId("selection-refusal")).toHaveTextContent("跨页");
  });

  it("sends the canonical paragraph ids and nothing else (AC-09)", async () => {
    const user = userEvent.setup();
    setupScene({ scope: "selection", selection: ["p_0007", "p_0008"] });
    replyWith(answered());

    await ask(user, "what does this say?");

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.scope).toEqual({
      type: "selection",
      paragraph_ids: ["p_0007", "p_0008"],
    });
    // `extra="forbid"`: anything else here is a 422, not a silent ignore.
    expect(Object.keys(body.scope)).toEqual(["type", "paragraph_ids"]);
  });

  it("never sends an empty selection as a whole-paper search (AC-09)", async () => {
    const user = userEvent.setup();
    setupScene({ scope: "selection" });
    replyWith(answered());

    await ask(user, "what does this say?");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks an empty question under a Selection — the highlight itself (AC-10)", async () => {
    const user = userEvent.setup();
    setupScene({ scope: "selection", selection: ["p_0001"] });
    replyWith(answered());

    // No question typed: "explain what I highlighted" is the whole request.
    await user.click(screen.getByTestId("composer-send"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.question).toBe("");
    expect(body.scope.type).toBe("selection");
  });

  it("still refuses an empty question outside a Selection (AC-P0-07)", async () => {
    const user = userEvent.setup();
    setupScene();
    replyWith(answered());

    expect(screen.getByTestId("composer-send")).toBeDisabled();
    await user.click(screen.getByTestId("composer-send"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("disables Selection in translation mode and offers the switch (AC-07)", async () => {
    const user = userEvent.setup();
    const document = setupScene({ selection: ["p_0001"] });
    useWorkspaceStore.setState({
      readerMode: "translation",
      translation: {
        documentId: document.documentId!,
        sessionToken: document.sessionToken,
        taskId: "t1",
        status: "success",
        progress: null,
        error: null,
        monoUrl: "blob:test-translated",
        monoPageCount: 12,
        degraded: false,
      },
    });

    // The mode was set after render, so React has to reconcile it first.
    await waitFor(() =>
      expect(
        within(screen.getByTestId("scope-selector")).getByRole("option", {
          name: "选中内容（译文模式不可用）",
        }),
      ).toBeDisabled(),
    );

    await user.click(screen.getByTestId("selection-translation-hint"));
    expect(useWorkspaceStore.getState().readerMode).toBe("original");
  });

  it("clears the selection when another paper is opened (AC-12)", async () => {
    setupScene({ selection: ["p_0001"] });

    const { openDocument } = await import("@/translation/session");
    openDocument(new File([new Uint8Array([1])], "b.pdf", { type: "application/pdf" }));

    // Paper A's paragraph ids are unreachable from paper B, not merely hidden.
    expect(useWorkspaceStore.getState().selection).toBeNull();
    expect(useWorkspaceStore.getState().ir).toBeNull();
  });

  it("does not let a stale selection be sent against another paper (AC-12)", async () => {
    const user = userEvent.setup();
    setupScene({ scope: "selection", selection: ["p_0001"] });

    // Without the document identity matching, the selector resolves to nothing —
    // so the request is refused rather than sent with paper A's ids.
    useWorkspaceStore.setState({
      selection: {
        documentId: "doc_somewhere_else",
        sessionToken: "open-9",
        mapping: {
          status: "valid",
          paragraphIds: ["p_0001"],
          pages: [1],
          rects: {},
          text: "stale",
          truncated: false,
        },
      },
    });
    replyWith(answered());

    await ask(user, "what does this say?");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * Races
 * ------------------------------------------------------------------ */

describe("DS-QA-003 · stale results", () => {
  it("drops an answer that arrives after the user opened another paper (AC-P0-19)", async () => {
    const user = userEvent.setup();
    setupScene();
    let release: (value: Response) => void = () => {};
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => (release = resolve)),
    );

    await ask(user, "问题属于论文 A");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Open paper B while A's answer is still in flight.
    const { openDocument } = await import("@/translation/session");
    openDocument(new File([new Uint8Array([1])], "b.pdf", { type: "application/pdf" }));

    release(jsonResponse(answered({ answer: "A 的答案 [E1]" })));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Paper A's answer is unreachable from paper B, not merely ignored.
    expect(screen.queryByTestId("qa-answer-body")).not.toBeInTheDocument();
    expect(screen.queryByText(/A 的答案/)).not.toBeInTheDocument();
    expect(useWorkspaceStore.getState().turns).toHaveLength(0);
  });
});
