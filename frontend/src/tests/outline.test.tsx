import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/pdf/pdfjs", () => {
  const STEPS = [0.5, 1.0, 2.0];
  const module = {
    getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: () => Promise.resolve({ getViewport: () => ({ width: 595, height: 842, rotation: 0 }) }) }) }),
    TextLayer: class { render() { return Promise.resolve(); } cancel() {} },
    setLayerDimensions: () => {},
    GlobalWorkerOptions: {},
  };
  return {
    loadPdfjs: () => Promise.resolve(module),
    ZOOM_STEPS: STEPS, MIN_ZOOM: 0.5, MAX_ZOOM: 2,
    FIT_WIDTH_PADDING_PX: 32, RENDER_BUFFER_MARGIN_PX: 300,
    clampZoom: (s: number) => s, zoomIn: (s: number) => s, zoomOut: (s: number) => s,
  };
});

import type { DocumentIr } from "@/api/ir";
import { buildOutlineTree, ancestorsOf } from "@/outline/tree";
import { activeSection, blockSections } from "@/outline/currentSection";
import { useWorkspaceStore, type QaSection } from "@/stores/workspace";
import { seedDocument, seedQaProvider, seedQaSections } from "@/tests/fixtures";

function section(over: Partial<QaSection> & { id: string; title: string }): QaSection {
  return {
    level: 1, parentId: null, pageNumber: 1, pageRange: [1, 1],
    bbox: [50, 70, 200, 84], anchor: "heading", isReferences: false, ...over,
  };
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

describe("DS-QA-008 · outline tree", () => {
  it("nests by parent_id and never by title (AC-P1-03)", () => {
    const nodes = [
      section({ id: "a", title: "1. Introduction" }),
      section({ id: "b", title: "1.1 Background", level: 2, parentId: "a" }),
    ];
    const tree = buildOutlineTree(nodes);
    expect(tree.roots.map((n) => n.id)).toEqual(["a"]);
    expect(tree.childrenOf.get("a")?.map((n) => n.id)).toEqual(["b"]);
  });

  it("keys identity on the id, so duplicate titles stay distinct", () => {
    // Two headings may read identically; `id` is what distinguishes them, and a
    // tree keyed by title would collapse them into one node.
    const nodes = [
      section({ id: "x", title: "Ablation Study", pageNumber: 4 }),
      section({ id: "y", title: "Ablation Study", pageNumber: 9 }),
    ];
    const tree = buildOutlineTree(nodes);
    expect(tree.roots.map((n) => n.id)).toEqual(["x", "y"]);
    expect(tree.byId.get("x")?.pageNumber).toBe(4);
    expect(tree.byId.get("y")?.pageNumber).toBe(9);
  });

  it("promotes a node whose parent is missing rather than hiding it", () => {
    // A dropped heading must not make its child unreachable.
    const nodes = [section({ id: "orphan", title: "C.1 Details", level: 2, parentId: "gone" })];
    const tree = buildOutlineTree(nodes);
    expect(tree.roots.map((n) => n.id)).toEqual(["orphan"]);
  });

  it("orders siblings by their own numbering when reading order disagrees", () => {
    // The measured Diffusion Policy shape: the heading for `C.2` is printed
    // before `C.1`, so reading order alone would render them backwards.
    const nodes = [
      section({ id: "c", title: "C Realworld Task Details" }),
      section({ id: "c2", title: "C.2 Sauce Pouring", level: 2, parentId: "c" }),
      section({ id: "c1", title: "C.1 Push-T", level: 2, parentId: "c" }),
    ];
    const tree = buildOutlineTree(nodes);
    expect(tree.childrenOf.get("c")?.map((n) => n.id)).toEqual(["c1", "c2"]);
  });

  it("keeps unnumbered siblings in the order the document gave them", () => {
    const nodes = [
      section({ id: "a", title: "Abstract" }),
      section({ id: "b", title: "Acknowledgements" }),
    ];
    expect(buildOutlineTree(nodes).roots.map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("reports a node's ancestors, nearest first", () => {
    const nodes = [
      section({ id: "a", title: "1. Method" }),
      section({ id: "b", title: "1.1 Encoder", level: 2, parentId: "a" }),
      section({ id: "c", title: "1.1.1 Blocks", level: 3, parentId: "b" }),
    ];
    expect(ancestorsOf(buildOutlineTree(nodes), "c")).toEqual(["b", "a"]);
  });
});

// ---------------------------------------------------------------------------
// The current-section rule
// ---------------------------------------------------------------------------

function ir(over: Partial<DocumentIr> & Pick<DocumentIr, "pages" | "paragraphs">): DocumentIr {
  return {
    document_id: "doc_test", content_hash: "h", page_count: over.pages.length, ...over,
  } as DocumentIr;
}

/** A two-column page: left column first, then right — as ResNet page 3 measures. */
const twoColumn = ir({
  pages: [{
    page_number: 1, width_pt: 595, height_pt: 842, rotation: 0,
    blocks: [
      { id: "L1", page_number: 1, layout_class: "plain text", bbox: [50, 70, 290, 400], text: "" },
      { id: "L2", page_number: 1, layout_class: "plain text", bbox: [50, 410, 290, 740], text: "" },
      { id: "R1", page_number: 1, layout_class: "plain text", bbox: [305, 70, 545, 400], text: "" },
      { id: "R2", page_number: 1, layout_class: "plain text", bbox: [305, 410, 545, 740], text: "" },
    ],
  }],
  paragraphs: [
    { id: "p1", source_anchor_id: "a1", section_id: "sec_a", text: "", page_number: 1, page_range: [1, 1], block_ids: ["L1", "L2"], bboxes: [] },
    { id: "p2", source_anchor_id: "a2", section_id: "sec_b", text: "", page_number: 1, page_range: [1, 1], block_ids: ["R1", "R2"], bboxes: [] },
  ],
});

describe("DS-QA-008 · current section (AC-P0-07)", () => {
  const map = blockSections(twoColumn.paragraphs);

  it("follows reading order, not vertical position", () => {
    // The right column's `R1` sits at y=70, *above* the left column's `L2` at
    // y=410 — and still comes after it. A rule reading raw y would report the
    // right column for most of the page; this one cannot, because it walks the
    // canonical sequence.
    //
    // The ends are asserted, not the middle. Where exactly a two-column page
    // hands over depends on the content-progress model the rule documents, and
    // the case the criteria actually froze — ResNet page 3 — is checked against
    // the real paper in the browser run, not against this synthetic page.
    expect(activeSection(twoColumn, { pageNumber: 1, offsetPt: 0 }, map)).toBe("sec_a");
    expect(activeSection(twoColumn, { pageNumber: 1, offsetPt: 842 }, map)).toBe("sec_b");
  });

  it("advances monotonically down a two-column page", () => {
    const seen: (string | null)[] = [];
    for (let offset = 0; offset <= 842; offset += 20) {
      const value = activeSection(twoColumn, { pageNumber: 1, offsetPt: offset }, map);
      if (value !== seen[seen.length - 1]) seen.push(value);
    }
    // One transition, in one direction: no flicker back to a previous section.
    expect(seen).toEqual(["sec_a", "sec_b"]);
  });

  it("returns null for a page with no mapped prose", () => {
    const bare = ir({
      pages: [{
        page_number: 1, width_pt: 595, height_pt: 842, rotation: 0,
        blocks: [{ id: "z", page_number: 1, layout_class: "figure", bbox: [0, 0, 10, 10], text: "" }],
      }],
      paragraphs: [],
    });
    expect(activeSection(bare, { pageNumber: 1, offsetPt: 5 }, new Map())).toBeNull();
  });

  it("falls back to the nearest earlier page that can answer", () => {
    const multi = ir({
      pages: [
        { page_number: 1, width_pt: 595, height_pt: 842, rotation: 0, blocks: [{ id: "a", page_number: 1, layout_class: "plain text", bbox: [0, 0, 100, 800], text: "" }] },
        { page_number: 2, width_pt: 595, height_pt: 842, rotation: 0, blocks: [{ id: "b", page_number: 2, layout_class: "figure", bbox: [0, 0, 100, 800], text: "" }] },
      ],
      paragraphs: [{ id: "p", source_anchor_id: "a", section_id: "sec_a", text: "", page_number: 1, page_range: [1, 1], block_ids: ["a"], bboxes: [] }],
    });
    // Page 2 maps to nothing; the reader was last in `sec_a`, and looking
    // *forwards* would name a section they have not reached.
    expect(activeSection(multi, { pageNumber: 2, offsetPt: 0 }, blockSections(multi.paragraphs))).toBe("sec_a");
  });
});

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

describe("DS-QA-008 · outline panel", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    useWorkspaceStore.setState({
      sections: null, activeSectionId: null, selectedSectionId: null,
      expandedSectionIds: [], outlinePanel: "outline", sidebarOpen: true,
      readerMode: "original", translation: null, turns: [],
    });
  });

  it("shows an empty state with no document", async () => {
    const { OutlinePanel } = await import("@/outline/OutlinePanel");
    useWorkspaceStore.setState({ document: null });
    render(<OutlinePanel />);
    expect(screen.getByTestId("outline-empty-state")).toBeInTheDocument();
  });

  it("says so when the paper has no structure, rather than inventing one", async () => {
    const { OutlinePanel } = await import("@/outline/OutlinePanel");
    seedDocument();
    useWorkspaceStore.setState({ sections: [] });
    render(<OutlinePanel />);
    expect(screen.getByTestId("outline-no-structure")).toBeInTheDocument();
  });

  it("renders the hierarchy and collapses a parent's children", async () => {
    const { OutlinePanel } = await import("@/outline/OutlinePanel");
    seedDocument();
    useWorkspaceStore.setState({
      sections: [
        section({ id: "a", title: "1. Method" }),
        section({ id: "b", title: "1.1 Encoder", level: 2, parentId: "a" }),
      ],
    });
    render(<OutlinePanel />);
    expect(screen.getByTestId("outline-node-a")).toBeInTheDocument();
    // Top level visible, deeper levels collapsed — the default Phase 23 asks for,
    // and the one that keeps a 50-section paper usable without a click.
    expect(screen.queryByTestId("outline-node-b")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("outline-toggle-a"));
    expect(screen.getByTestId("outline-node-b")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("outline-toggle-a"));
    expect(screen.queryByTestId("outline-node-b")).not.toBeInTheDocument();
  });

  it("marks the active node with aria-current, not colour alone", async () => {
    const { OutlinePanel } = await import("@/outline/OutlinePanel");
    seedDocument();
    useWorkspaceStore.setState({
      sections: [section({ id: "a", title: "1. Method" })],
      activeSectionId: "a",
    });
    render(<OutlinePanel />);
    expect(screen.getByTestId("outline-node-a")).toHaveAttribute("aria-current", "location");
  });

  it("sends a click to the reader with the heading's page and box", async () => {
    const { OutlinePanel } = await import("@/outline/OutlinePanel");
    seedDocument();
    useWorkspaceStore.setState({
      sections: [section({ id: "a", title: "1. Method", pageNumber: 3, bbox: [50, 120, 200, 134] })],
    });
    render(<OutlinePanel />);
    await userEvent.click(screen.getByTestId("outline-jump-a"));

    const request = useWorkspaceStore.getState().jumpRequest;
    expect(request?.pageNumber).toBe(3);
    expect(request?.bboxes).toEqual([[50, 120, 200, 134]]);
    // The offset is what puts the heading at the top rather than the page.
    expect(request?.offsetPt).toBe(120);
  });

  it("degrades to a page jump when the ladder could not resolve a box", async () => {
    const { OutlinePanel } = await import("@/outline/OutlinePanel");
    seedDocument();
    useWorkspaceStore.setState({
      sections: [
        section({ id: "a", title: "1. Method", pageNumber: 3, bbox: null, anchor: "page" }),
      ],
    });
    render(<OutlinePanel />);
    await userEvent.click(screen.getByTestId("outline-jump-a"));

    const request = useWorkspaceStore.getState().jumpRequest;
    expect(request?.pageNumber).toBe(3);
    expect(request?.bboxes).toEqual([]);
    expect(request?.offsetPt).toBeNull();
  });

  it("hands a section to QA by canonical id, and asks nothing", async () => {
    const { OutlinePanel } = await import("@/outline/OutlinePanel");
    seedDocument();
    seedQaProvider();
    useWorkspaceStore.setState({ sections: [section({ id: "sec_9", title: "9. Results" })] });
    render(<OutlinePanel />);

    await userEvent.click(screen.getByTestId("outline-ask-sec_9"));

    const state = useWorkspaceStore.getState();
    expect(state.selectedSectionId).toBe("sec_9");
    expect(state.scope).toBe("section");
    expect(state.outlinePanel).toBe("qa");
    // AC-P0-14: selecting a section spends no model call.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opening the outline makes no provider call (AC-P0-14)", async () => {
    const { OutlinePanel } = await import("@/outline/OutlinePanel");
    seedDocument();
    seedQaSections();
    seedQaProvider();
    render(<OutlinePanel />);
    await waitFor(() => expect(screen.getByTestId("outline-panel")).toBeInTheDocument());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves translation mode, and says why, when a section is clicked (AC-P0-09)", async () => {
    // The clause cannot be reached in the browser fixture: `selectEffectiveMode`
    // only returns "translation" when a translated artifact exists, and producing
    // one is a full translation run. Verified here against the real
    // `jumpToSection` and the real mode resolution rather than declared NOT RUN.
    const document = seedDocument();
    seedQaSections();
    useWorkspaceStore.setState({
      readerMode: "translation",
      translation: {
        documentId: document.documentId!, sessionToken: document.sessionToken,
        taskId: null, status: "success", progress: null, error: null,
        monoUrl: "blob:translated", monoPageCount: 12, degraded: false,
      },
    });
    const { jumpToSection } = await import("@/outline/navigate");
    const target = useWorkspaceStore.getState().sections![1];

    jumpToSection(target);

    const after = useWorkspaceStore.getState();
    expect(after.readerMode).toBe("original");
    expect(after.notice).toContain("已切换至原文");
    // The source heading box travels with the jump, because in Original mode the
    // geometry on screen is the geometry the box was measured against.
    expect(after.jumpRequest?.bboxes).toHaveLength(1);
    expect(after.jumpRequest?.pageNumber).toBe(target.pageNumber);
  });

  it("moves both panes in bilingual mode, and boxes only the original (AC-P0-09)", async () => {
    const document = seedDocument();
    seedQaSections();
    useWorkspaceStore.setState({
      readerMode: "bilingual",
      translation: {
        documentId: document.documentId!, sessionToken: document.sessionToken,
        taskId: null, status: "success", progress: null, error: null,
        monoUrl: "blob:translated", monoPageCount: 12, degraded: false,
      },
    });
    const { jumpToSection } = await import("@/outline/navigate");
    const target = useWorkspaceStore.getState().sections![1];

    jumpToSection(target);

    const after = useWorkspaceStore.getState();
    expect(after.readerMode).toBe("bilingual");
    expect(after.jumpRequest?.bboxes).toHaveLength(1);
    expect(after.translatedJump?.pageNumber).toBe(target.pageNumber);
    // Source geometry describes the original artifact and nothing else, so the
    // translated channel carries no boxes at all — there is no field for one.
    expect(Object.keys(after.translatedJump ?? {}).sort()).toEqual(["nonce", "pageNumber"]);
  });

  it("clears the outline when another paper is opened (AC-P0-13)", async () => {
    const { teardownQa } = await import("@/qa/session");
    seedDocument();
    seedQaSections();
    useWorkspaceStore.setState({
      activeSectionId: "sec_3", selectedSectionId: "sec_3",
      expandedSectionIds: ["sec_1"], outlinePanel: "outline",
    });

    teardownQa();

    const state = useWorkspaceStore.getState();
    expect(state.sections).toBeNull();
    expect(state.activeSectionId).toBeNull();
    expect(state.selectedSectionId).toBeNull();
    expect(state.expandedSectionIds).toEqual([]);
    // A section scope built now has no identity to stand on, so no question can
    // be sent naming a section of the paper that was closed.
    const { activeSectionFor } = await import("@/stores/workspace");
    expect(activeSectionFor(state)).toBeNull();
  });

  it("answers Section scope from the reading position (AC-P0-07)", async () => {
    seedDocument();
    seedQaSections();
    // Page 8 of the seeded IR is covered by `sec_3` (pages 7–8).
    useWorkspaceStore.getState().setActivePage(8);
    const { activeSectionFor } = await import("@/stores/workspace");
    const state = useWorkspaceStore.getState();
    expect(activeSectionFor({ ...state, activeSectionId: "sec_3" })?.id).toBe("sec_3");
  });
});
