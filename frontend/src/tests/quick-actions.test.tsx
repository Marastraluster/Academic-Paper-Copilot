import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getDocument = vi.fn();

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
import { QUICK_ACTIONS } from "@/stores/workspace";
import { useWorkspaceStore } from "@/stores/workspace";
import { seedDocument, seedQaProvider, seedQaSections } from "@/tests/fixtures";

/**
 * AC-35 / AC-06, rewritten for DS-QA-003.
 *
 * DS-FE-001 specified the sidebar's *shape* — six quick actions, a scope
 * selector, a conversation area, a composer — around a placeholder that replied
 * with a canned notice. The shape survives; the placeholder does not. These
 * assertions now check the same requirements against the real behaviour, and
 * they deliberately do not assert the old canned reply, because the feature it
 * stood in for exists.
 */

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function replyWith(body: unknown): void {
  fetchMock.mockImplementation(async () => jsonResponse(body));
}

const ANSWER = {
  document_id: "doc_test",
  question: "q",
  status: "answered",
  answer: "Residual learning reformulates the mapping. [E1]",
  citations: [
    {
      citation_id: "E1",
      paragraph_id: "p_0001",
      section_id: "sec_1",
      section_title: "1. Introduction",
      page_number: 2,
      page_range: [2, 2],
      block_ids: ["b_1"],
      bboxes: [[72, 100, 540, 130]],
      snippet: "Residual learning reformulates the mapping.",
      is_caption: false,
    },
  ],
  unanswered_aspects: [],
  missing_evidence_rationale: null,
  diagnostics: { code: "SUCCESS", suggest_scope_expansion: false },
};

beforeEach(() => {
  getDocument.mockReset();
  getDocument.mockReturnValue({
    promise: Promise.resolve({
      numPages: 6,
      getPage: vi.fn(async () => ({
        getViewport: ({ scale }: { scale: number }) => ({
          width: 600 * scale,
          height: 800 * scale,
          rotation: 0,
        }),
        render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
        streamTextContent: () => ({}),
      })),
    }),
    destroy: vi.fn(async () => undefined),
  });
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("DS-FE-001 · AC-35 quick actions", () => {
  it("renders all six required quick actions (AC-06)", () => {
    render(<App />);

    expect(QUICK_ACTIONS).toHaveLength(6);
    for (const action of QUICK_ACTIONS) {
      expect(screen.getByTestId(`quick-action-${action.label}`)).toBeInTheDocument();
    }
  });

  it("disables every quick action until a paper is registered (AC-01)", () => {
    render(<App />);

    for (const action of QUICK_ACTIONS) {
      expect(screen.getByTestId(`quick-action-${action.label}`)).toBeDisabled();
    }
  });

  it("asks a real, scoped question when one is used (AC-P1-04)", async () => {
    const user = userEvent.setup();
    seedDocument();
    seedQaProvider();
    seedQaSections();
    replyWith(ANSWER);
    render(<App />);

    await user.click(screen.getByTestId("quick-action-总结方法"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body.question).toContain("方法");
    expect(body.scope).toEqual({ type: "whole_paper" });

    // The scope it actually used is on the card, not just implied by the button.
    await waitFor(() => expect(screen.getByTestId("reference-list")).toBeInTheDocument());
    expect(screen.getByTestId(/qa-turn-/)).toHaveTextContent("整篇论文");
  });

  it("keeps the selection action disabled while it has no implementation (AC-P1-04)", () => {
    seedDocument();
    seedQaProvider();
    render(<App />);

    expect(screen.getByTestId("quick-action-解释选中内容")).toBeDisabled();
  });

  it("renders the scope selector, conversation area and composer (AC-06)", () => {
    render(<App />);

    expect(screen.getByTestId("scope-selector")).toBeInTheDocument();
    expect(screen.getByTestId("conversation-area")).toBeInTheDocument();
    expect(screen.getByLabelText("向论文提问")).toBeInTheDocument();
    expect(screen.getByTestId("composer-send")).toBeInTheDocument();
  });

  it("changes scope through the selector, in the backend's vocabulary (AC-06)", async () => {
    const user = userEvent.setup();
    seedDocument();
    seedQaProvider();
    seedQaSections();
    render(<App />);

    const select = screen.getByTestId("scope-selector");
    await user.selectOptions(select, "page");

    // The store holds the API's word, not the old UI-only "document"/"page" pair.
    expect(useWorkspaceStore.getState().scope).toBe("page");
    expect(select).toHaveValue("page");
  });
});

describe("DS-FE-001 · AC-18 composer validation", () => {
  it("disables send for an empty composer", () => {
    render(<App />);

    expect(screen.getByTestId("composer-send")).toBeDisabled();
  });

  it("ignores whitespace-only submissions (AC-18)", async () => {
    const user = userEvent.setup();
    seedDocument();
    seedQaProvider();
    render(<App />);

    const input = screen.getByLabelText("向论文提问");
    await user.type(input, "   ");
    expect(screen.getByTestId("composer-send")).toBeDisabled();

    await user.keyboard("{Enter}");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(within(screen.getByTestId("conversation-area")).queryByTestId(/qa-turn-/))
      .not.toBeInTheDocument();
  });

  it("sends a real question and clears the composer (AC-18)", async () => {
    const user = userEvent.setup();
    seedDocument();
    seedQaProvider();
    replyWith(ANSWER);
    render(<App />);

    const input = screen.getByLabelText("向论文提问");
    await user.type(input, "什么是退化问题？");
    await user.click(screen.getByTestId("composer-send"));

    await waitFor(() => expect(screen.getByTestId("reference-list")).toBeInTheDocument());
    expect(screen.getByTestId(/qa-turn-/)).toHaveTextContent("什么是退化问题？");
    expect(input).toHaveValue("");
  });
});
