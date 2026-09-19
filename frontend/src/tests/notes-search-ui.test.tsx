/**
 * DS-QA-012 — searching and exporting from the Notes panel.
 *
 * The unit tests in `notes-search.test.ts` prove the matching rules. This file
 * proves the panel actually uses them: that a keystroke changes what is on
 * screen, that the two empty states are different sentences, that export is
 * refused when there is nothing to export, and — the one that is easy to get
 * wrong and impossible to notice — that typing reaches no network.
 */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnnotationView, ResolvedTarget } from "@/api/annotations";
import { App } from "@/app/App";
import { useWorkspaceStore } from "@/stores/workspace";
import { seedDocument, seedQaSections } from "@/tests/fixtures";

declare global {
  // eslint-disable-next-line no-var
  var __rotation: number | undefined;
}

function annotation(over: Partial<AnnotationView>): AnnotationView {
  const quote = over.quote ?? "a source quote";
  const targets: ResolvedTarget[] = over.targets ?? [{
    order: 0, page_number: 1, rects: [[72, 100, 400, 114]], quote,
    state: "EXACT", resolved_paragraph_id: "p_0001", detail: "",
    showable: true, amenable_to_jump: true,
  }];
  return {
    id: over.id ?? "ann_1",
    kind: over.kind ?? "note",
    color: "yellow",
    quote,
    comment: over.comment ?? null,
    created_at: "2026-09-19T00:00:00+00:00",
    updated_at: "2026-09-19T00:00:00+00:00",
    targets,
  };
}

const NOTES: AnnotationView[] = [
  annotation({ id: "n1", comment: "这个地方解释了残差网络为什么不会退化", quote: "degradation with depth" }),
  annotation({ id: "n2", comment: "the degradation problem", quote: "plain networks" }),
  annotation({ id: "n3", comment: null, kind: "highlight", quote: "ResNet-50 on CIFAR-10" }),
  annotation({ id: "n4", comment: "残差连接解决退化问题", quote: "residual connections" }),
];

function openPanel(list: AnnotationView[] = NOTES) {
  const document = seedDocument();
  seedQaSections();
  useWorkspaceStore.setState({
    annotations: list,
    annotationsFor: document.documentId,
    outlinePanel: "notes",
    sidebarOpen: true,
  });
  render(<App />);
  return document;
}

/**
 * The ids of the rows currently rendered, in order.
 *
 * Read from the DOM rather than through a test-id pattern: a row is an `li`
 * whose test id starts with `note-`, and the controls *inside* a row start with
 * it too. Matching on the element type is exact where a pattern is not.
 */
function visibleRows(): string[] {
  return [...document.querySelectorAll('li[data-testid^="note-"]')].map((row) =>
    (row.getAttribute("data-testid") ?? "").replace(/^note-/, ""),
  );
}

async function search(text: string) {
  const user = userEvent.setup();
  const input = screen.getByTestId("notes-search-input");
  await user.clear(input);
  if (text !== "") await user.type(input, text);
  return user;
}

beforeEach(() => {
  // jsdom has no canvas, and the reader mounts a PDF viewer behind the panel.
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  useWorkspaceStore.setState({
    annotations: null, annotationsFor: null, activeAnnotationId: null,
    readerMode: "original", translation: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DS-QA-012 · searching in the panel", () => {
  it("shows every note when the query is empty", async () => {
    openPanel();
    await screen.findByTestId("notes-list");
    expect(visibleRows()).toEqual(["n1", "n2", "n3", "n4"]);
  });

  it("narrows to the notes matching a Chinese query", async () => {
    openPanel();
    await screen.findByTestId("notes-list");
    await search("残差");
    expect(visibleRows()).toEqual(["n1", "n4"]);
  });

  it("finds an English word in a note and in a source quote", async () => {
    openPanel();
    await screen.findByTestId("notes-list");

    await search("degradation");
    // n1 has it in its quote, n2 in its comment.
    expect(visibleRows()).toEqual(["n1", "n2"]);

    await search("plain networks");
    // n3 is a highlight with no comment; only its quote can answer.
    expect(visibleRows()).toEqual(["n2"]);
  });

  it("finds a highlight that has no note of its own", async () => {
    openPanel();
    await screen.findByTestId("notes-list");
    await search("ResNet-50");
    expect(visibleRows()).toEqual(["n3"]);
  });

  it("clears back to the full list from the clear button", async () => {
    openPanel();
    await screen.findByTestId("notes-list");

    const user = await search("残差");
    expect(screen.queryByTestId("notes-search-clear")).not.toBeNull();

    await user.click(screen.getByTestId("notes-search-clear"));
    expect(screen.getByTestId<HTMLInputElement>("notes-search-input").value).toBe("");
    expect(visibleRows()).toEqual(["n1", "n2", "n3", "n4"]);
  });

  it("shows no clear button while the query is empty", async () => {
    openPanel();
    await screen.findByTestId("notes-list");
    expect(screen.queryByTestId("notes-search-clear")).toBeNull();
  });

  it("says 'nothing matches' rather than 'you have no notes'", async () => {
    /* Two different situations, two different sentences. "You have not written
       anything" and "nothing matches what you typed" call for different next
       actions, and one sentence for both teaches the reader nothing. */
    openPanel();
    await screen.findByTestId("notes-list");
    await search("nonexistent_xyz");

    expect(screen.getByTestId("notes-search-empty")).toHaveTextContent("未找到匹配");
    expect(screen.queryByTestId("notes-none")).toBeNull();
    expect(screen.queryByTestId("notes-list")).toBeNull();
    // And the box stays usable, so the reader can undo what they typed.
    expect(screen.getByTestId("notes-search-input")).toBeInTheDocument();
  });

  it("says 'you have no notes' when there are none, not 'nothing matches'", async () => {
    openPanel([]);
    await screen.findByTestId("notes-none");
    expect(screen.queryByTestId("notes-search-empty")).toBeNull();
  });

  it("touches no network while typing", async () => {
    /* The search runs over the list the panel already has. A keystroke that
       reached the backend would be a round trip per character for data that is
       already in memory — and on the notes path a round trip is the thing
       DS-QA-010-FIX-001 exists to have removed. */
    openPanel();
    await screen.findByTestId("notes-list");

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await search("残差");
    await search("ResNet");

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("starts a new paper with an empty query", async () => {
    /* A filter carried across documents would show the new paper's notes already
       reduced, with the reason sitting in a box the reader has to notice — an
       empty-looking panel for a paper that has notes. */
    openPanel();
    await screen.findByTestId("notes-list");
    await search("残差");
    expect(screen.getByTestId<HTMLInputElement>("notes-search-input").value).toBe("残差");

    // A genuinely different paper. `seedDocument` reuses one id by default, and
    // an effect keyed on an id that never changed would appear to pass.
    const next = seedDocument({ documentId: "doc_somewhere_else" });
    useWorkspaceStore.setState({
      annotations: [annotation({ id: "other", comment: "a different note" })],
      annotationsFor: next.documentId,
    });

    const input = await screen.findByTestId<HTMLInputElement>("notes-search-input");
    expect(input.value).toBe("");
  });

  it("reflects an edit without a second search", async () => {
    openPanel();
    await screen.findByTestId("notes-list");
    await search("wording");

    const before = useWorkspaceStore.getState().annotations ?? [];
    useWorkspaceStore.setState({
      annotations: before.map((item) =>
        item.id === "n2" ? { ...item, comment: "a new wording" } : item,
      ),
    });

    await screen.findByTestId("notes-list");
    expect(visibleRows()).toEqual(["n2"]);
  });

  it("stops showing a note once it is deleted", async () => {
    openPanel();
    await screen.findByTestId("notes-list");
    await search("degradation");
    expect(visibleRows()).toEqual(["n1", "n2"]);

    const remaining = (useWorkspaceStore.getState().annotations ?? []).filter(
      (item) => item.id !== "n2",
    );
    useWorkspaceStore.setState({ annotations: remaining });

    await screen.findByTestId("notes-list");
    expect(visibleRows()).toEqual(["n1"]);
  });

  it("returns one row for a cross-page note, not one per page", async () => {
    openPanel([
      annotation({
        id: "x1", comment: "spans the boundary", quote: "the whole span",
        targets: [
          { order: 0, page_number: 1, rects: [[72, 100, 400, 114]], quote: "page one text",
            state: "EXACT", resolved_paragraph_id: "p_1", detail: "", showable: true,
            amenable_to_jump: true },
          { order: 1, page_number: 2, rects: [[72, 100, 400, 114]], quote: "page two text",
            state: "EXACT", resolved_paragraph_id: "p_2", detail: "", showable: true,
            amenable_to_jump: true },
        ],
      }),
    ]);
    await screen.findByTestId("notes-list");

    await search("page two");
    expect(visibleRows()).toEqual(["x1"]);
  });

  it("keeps a note whose position could not be resolved", async () => {
    openPanel([
      annotation({
        id: "o1", comment: "still my words", quote: "its paragraph moved",
        targets: [{
          order: 0, page_number: 1, rects: [[72, 100, 400, 114]], quote: "its paragraph moved",
          state: "ORPHANED", resolved_paragraph_id: null, detail: "", showable: true,
          amenable_to_jump: true,
        }],
      }),
    ]);
    await screen.findByTestId("notes-list");

    await search("still my words");
    expect(visibleRows()).toEqual(["o1"]);
    expect(screen.getByTestId("note-state-o1")).toBeInTheDocument();
  });
});

describe("DS-QA-012 · exporting from the panel", () => {
  it("offers both formats as backend downloads", async () => {
    const document = openPanel();
    await screen.findByTestId("notes-list");

    const markdown = screen.getByTestId("export-notes-markdown");
    const json = screen.getByTestId("export-notes-json");

    // The file is generated by the backend, which is the only place that holds
    // the stable source anchors the archive exists to preserve.
    expect(markdown.getAttribute("href")).toContain(
      `/api/documents/${document.documentId}/export/notes.md`,
    );
    expect(json.getAttribute("href")).toContain(
      `/api/documents/${document.documentId}/export/notes.json`,
    );
    expect(markdown.getAttribute("aria-disabled")).toBe("false");
  });

  it("refuses to export a document with no notes, and says why", async () => {
    openPanel([]);
    await screen.findByTestId("notes-none");

    for (const id of ["export-notes-markdown", "export-notes-json"]) {
      const link = screen.getByTestId(id);
      expect(link.getAttribute("aria-disabled")).toBe("true");
      expect(link.getAttribute("title")).toBe("当前文档暂无笔记可导出");
    }
  });

  it("enables export as soon as there is one note", async () => {
    openPanel([]);
    await screen.findByTestId("notes-none");
    expect(screen.getByTestId("export-notes-markdown").getAttribute("aria-disabled"))
      .toBe("true");

    useWorkspaceStore.setState({
      annotations: [annotation({ id: "a", comment: "mine", quote: "q" })],
    });

    await screen.findByTestId("notes-list");
    expect(screen.getByTestId("export-notes-markdown").getAttribute("aria-disabled"))
      .toBe("false");
  });

  it("exports every note, not the ones a search happens to be showing", async () => {
    /* A download that silently honoured the filter would be an incomplete backup
       the reader believes is complete — and they would only find out by opening
       the file. The count is shown beside the links so the scope is visible. */
    openPanel();
    await screen.findByTestId("notes-list");
    await search("残差");

    expect(visibleRows()).toEqual(["n1", "n4"]);
    expect(screen.getByTestId("notes-export-scope")).toHaveTextContent("全部 4 条");
  });

  it("shows no scope hint when nothing is filtered", async () => {
    openPanel();
    await screen.findByTestId("notes-list");
    expect(screen.queryByTestId("notes-export-scope")).toBeNull();
  });

  it("keeps the panel inside its column", async () => {
    openPanel();
    await screen.findByTestId("notes-list");
    const tools = screen.getByTestId("notes-tools");
    expect(within(tools).getByTestId("notes-search-input")).toBeInTheDocument();
  });
});
