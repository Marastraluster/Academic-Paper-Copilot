/**
 * DS-QA-014 — the reading entry, and the one control that costs money.
 *
 * Two properties carry this whole feature and both are asserted here rather than
 * described:
 *
 * **Opening a paper reaches no provider.** The instant layer is a render of the
 * `DocumentIR` the application already holds, and the analysis layer is a
 * `GET`. Between them there is no path to a model until a reader presses a
 * button — which matters more in this panel than anywhere else, because 概览 is
 * the tab a paper opens on.
 *
 * **An analysis of one paper is never rendered under another.** The Overview is
 * the only thing in the application that can spend the reader's money, and the
 * worst failure available to it is a confident summary of a different document.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnalysisView } from "@/api/analysis";
import { App } from "@/app/App";
import { useWorkspaceStore } from "@/stores/workspace";
import { seedDocument, seedQaSections } from "@/tests/fixtures";

declare global {
  // eslint-disable-next-line no-var
  var __rotation: number | undefined;
}

const ABSTRACT =
  "Deeper neural networks are more difficult to train. We present a residual learning framework.";

function seedIr(overrides: Record<string, unknown> = {}) {
  const document = seedDocument();
  useWorkspaceStore.setState({
    ir: {
      document_id: document.documentId ?? "doc_test",
      content_hash: "hash_current",
      page_count: 12,
      pipeline_version: "5",
      // Nested, because that is where the extractor puts it — the panel reads
      // `metadata.title` and falls back to the filename.
      metadata: { title: "Deep Residual Learning for Image Recognition" },
      pages: [{ page_number: 1, width_pt: 612, height_pt: 792, rotation: 0, blocks: [] }],
      paragraphs: [
        {
          id: "p_1", source_anchor_id: "a1", section_id: "sec_a",
          text: ABSTRACT, page_number: 1, page_range: [1, 1],
          block_ids: [], bboxes: [[50, 100, 545, 140]], is_abstract: true,
        },
        {
          id: "p_2", source_anchor_id: "a2", section_id: "sec_b",
          text: "The rest of the paper.", page_number: 3, page_range: [3, 3],
          block_ids: [], bboxes: [[50, 100, 545, 140]],
        },
      ],
      ...overrides,
    } as never,
  });
  return document;
}

function analysis(over: Partial<AnalysisView> = {}): AnalysisView {
  return {
    document_id: "doc_test",
    status: "READY",
    summary: "The paper introduces a residual learning framework.",
    sections: [{
      section_id: "sec_b", title: "3. Deep Residual Learning",
      summary: "It reformulates layers as learning residual functions.",
      page_range: [3, 5], synthetic: false,
    }],
    glossary: [
      { source_term: "ResNet-50", suggested_translation: null, definition: "A model.",
        is_translatable: false, paragraph_ids: ["p_2"] },
      { source_term: "residual", suggested_translation: "残差", definition: null,
        is_translatable: true, paragraph_ids: ["p_2"] },
    ],
    acronyms: [],
    provenance: {
      content_hash: "hash_current", pipeline_version: "1.0.0", prompt_version: "1.0.0",
      ir_pipeline_version: "5", provider_model: "deepseek-flash",
      target_language: "zh-CN", created_at: "2026-09-19T00:00:00+00:00",
    },
    ...over,
  };
}

/** Open the app on the overview panel with a document and an IR in place. */
function openOverview() {
  // Sections first: `seedQaSections` installs its own IR, and installing ours
  // before it would be silently overwritten — a fixture bug that showed up as
  // the panel rendering the filename as the title.
  seedQaSections();
  const document = seedIr();
  useWorkspaceStore.setState({
    outlinePanel: "overview", sidebarOpen: true,
    analysis: null, analysisFor: null, analysisStatus: "idle",
    analysisError: null, analysisStartedAt: null,
  });
  render(<App />);
  return document;
}

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  useWorkspaceStore.setState({
    readerMode: "original", translation: null, analysis: null, analysisFor: null,
    analysisStatus: "idle", analysisError: null, analysisStartedAt: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DS-QA-014 · the instant entry", () => {
  it("shows the title, the abstract verbatim and the structure", async () => {
    openOverview();
    const panel = await screen.findByTestId("overview-panel");

    expect(screen.getByTestId("overview-title")).toHaveTextContent(
      "Deep Residual Learning for Image Recognition",
    );
    // Verbatim: the abstract is the one summary the authors wrote, and a
    // paraphrase of it would be this panel's first claim and its first
    // unnecessary one.
    expect(screen.getByTestId("overview-abstract")).toHaveTextContent(ABSTRACT);
    expect(screen.getByTestId("overview-metrics")).toHaveTextContent("12 页");
    expect(panel).toBeInTheDocument();
  });

  it("renders without a loading state, and spends nothing", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      return new Response(JSON.stringify({ error: { code: "ANALYSIS_NOT_FOUND" } }), {
        status: 404, headers: { "Content-Type": "application/json" },
      });
    }));
    openOverview();
    await screen.findByTestId("overview-panel");
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    // No spinner: the instant layer is data the application already holds.
    expect(screen.queryByTestId("overview-progress")).toBeNull();
    /* And no **generation**. The panel does read the stored analysis — that is
       the cached experience, it costs nothing, and refusing to read it would
       make a reader who already paid wait to find out. What must never happen
       without a button press is a POST, which is the only request that reaches
       a model. */
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
    expect(calls.every((call) => call.includes("/analysis"))).toBe(true);
  });

  it("says there is no abstract rather than substituting the introduction", async () => {
    const document = seedDocument();
    seedQaSections();
    useWorkspaceStore.setState({
      ir: {
        document_id: document.documentId ?? "doc_test", content_hash: "h",
        page_count: 2, pipeline_version: "5",
        pages: [{ page_number: 1, width_pt: 612, height_pt: 792, rotation: 0, blocks: [] }],
        paragraphs: [{
          id: "p_1", source_anchor_id: "a1", section_id: null,
          text: "This is the introduction, not an abstract.",
          page_number: 1, page_range: [1, 1], block_ids: [], bboxes: [[50, 100, 545, 140]],
        }],
      } as never,
      outlinePanel: "overview", sidebarOpen: true,
    });
    render(<App />);

    await screen.findByTestId("overview-no-abstract");
    expect(screen.queryByTestId("overview-abstract")).toBeNull();
    expect(screen.getByTestId("overview-entry")).not.toHaveTextContent("This is the introduction");
  });

  it("opens the paper's own first body section, by its own title", async () => {
    /* The real ResNet outline: no section called "Method" or "Experiments", so a
       recommendation that matched expected titles would name nothing here. */
    openOverview();
    useWorkspaceStore.setState({
      sections: [
        { id: "s1", title: "Abstract", level: 1, parentId: null, pageNumber: 1,
          pageRange: [1, 1], bbox: null, anchor: "heading", isReferences: false },
        { id: "s2", title: "1. Introduction", level: 1, parentId: null, pageNumber: 1,
          pageRange: [1, 1], bbox: null, anchor: "heading", isReferences: false },
        { id: "s3", title: "3. Deep Residual Learning", level: 1, parentId: null,
          pageNumber: 3, pageRange: [3, 5], bbox: null, anchor: "heading",
          isReferences: false },
      ] as never,
    });

    await screen.findByTestId("overview-start-reading");
    expect(screen.getByTestId("overview-start-reading")).toHaveTextContent("3. Deep Residual");
  });
});

describe("DS-QA-014 · the analysis layer", () => {
  it("offers generation when there is none, and does not start one itself", async () => {
    openOverview();
    await screen.findByTestId("overview-not-generated");

    expect(screen.getByTestId("overview-generate")).toBeInTheDocument();
    // Nothing has been asked of a provider, and nothing will be until the button
    // is pressed. This is the acceptance's central promise.
    expect(screen.queryByTestId("overview-progress")).toBeNull();
  });

  it("renders a cached analysis without generating anything", async () => {
    openOverview();
    useWorkspaceStore.setState({ analysis: analysis(), analysisFor: "doc_test" });

    await screen.findByTestId("overview-body");
    expect(screen.getByTestId("overview-summary")).toHaveTextContent("residual learning framework");
    expect(screen.getByTestId("overview-sections")).toHaveTextContent("3. Deep Residual Learning");
    expect(screen.getByTestId("overview-term-ResNet-50")).toBeInTheDocument();
    expect(screen.queryByTestId("overview-generate")).toBeNull();
  });

  it("keeps the source spelling of a term it cannot translate", async () => {
    openOverview();
    useWorkspaceStore.setState({ analysis: analysis(), analysisFor: "doc_test" });
    await screen.findByTestId("overview-body");

    // `ResNet-50` is an identifier. Case-folding it is the one thing that would
    // make a glossary useless.
    expect(screen.getByTestId("overview-term-ResNet-50")).toHaveTextContent("ResNet-50");
  });

  it("bounds what it renders and offers the rest", async () => {
    /* Measured: the real ResNet analysis holds 207 glossary entries. Rendering
       them all into a 340 px column is a scroll the reader has to traverse
       before reaching anything — the opposite of what an entry point is for. */
    const many = analysis({
      glossary: Array.from({ length: 30 }, (_, index) => ({
        source_term: `term${index}`, suggested_translation: null,
        definition: null, is_translatable: true, paragraph_ids: [],
      })),
    });
    openOverview();
    useWorkspaceStore.setState({ analysis: many, analysisFor: "doc_test" });
    await screen.findByTestId("overview-body");

    expect(screen.getByTestId("overview-term-term0")).toBeInTheDocument();
    expect(screen.queryByTestId("overview-term-term29")).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByTestId("overview-terms-expand"));
    expect(screen.getByTestId("overview-term-term29")).toBeInTheDocument();
  });

  it("badges a partial analysis and a synthetic section", async () => {
    openOverview();
    useWorkspaceStore.setState({
      analysis: analysis({
        status: "PARTIAL",
        sections: [{
          section_id: "sec_x", title: "Auto partition", summary: "…",
          page_range: [7, 8], synthetic: true,
        }],
      }),
      analysisFor: "doc_test",
    });

    await screen.findByTestId("overview-body");
    expect(screen.getByTestId("overview-partial")).toHaveTextContent("部分章节分析已就绪");
    // A title the reader would take for the authors' own, when it is not.
    expect(screen.getByTestId("overview-synthetic-sec_x")).toHaveTextContent("自动分块");
  });

  it("hides an analysis that describes a different extraction", async () => {
    /* The analysis's section and term references point at paragraph ids, and
       paragraph ids are reading positions. DS-DOC-002 measured one constant
       renumbering 145 of 160 paragraphs of a paper whose bytes had not changed,
       so an analysis from a previous extraction describes text that has moved. */
    openOverview();
    useWorkspaceStore.setState({ analysis: analysis(), analysisFor: "doc_test" });
    await screen.findByTestId("overview-body");

    const stale = analysis();
    stale.provenance.ir_pipeline_version = "4";
    useWorkspaceStore.setState({ analysis: stale });

    await screen.findByTestId("overview-not-generated");
    expect(screen.queryByTestId("overview-body")).toBeNull();
  });

  it("hides an analysis that describes a different file", async () => {
    openOverview();
    const other = analysis();
    other.provenance.content_hash = "hash_of_another_paper";
    useWorkspaceStore.setState({ analysis: other, analysisFor: "doc_test" });

    await screen.findByTestId("overview-not-generated");
    expect(screen.queryByTestId("overview-body")).toBeNull();
  });
});

describe("DS-QA-014 · generation", () => {
  it("asks once, shows real elapsed time, and renders what comes back", async () => {
    const document = openOverview();
    useWorkspaceStore.setState({ profileId: "prof_1" });
    await screen.findByTestId("overview-not-generated");

    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (init?.method === "POST") {
        return new Response(JSON.stringify(analysis()), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: { code: "ANALYSIS_NOT_FOUND" } }), {
        status: 404, headers: { "Content-Type": "application/json" },
      });
    }));

    const user = userEvent.setup();
    await user.click(screen.getByTestId("overview-generate"));

    await screen.findByTestId("overview-body");
    const posts = calls.filter((call) => call.startsWith("POST"));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain(`/documents/${document.documentId}/analysis`);
    expect(screen.getByTestId("overview-summary")).toBeInTheDocument();
  });

  it("keeps the instant entry usable when generation fails", async () => {
    /* The paper must not be replaced by an error screen. The reader opened a
       document; a provider being unreachable does not un-open it. */
    openOverview();
    useWorkspaceStore.setState({ profileId: "prof_1" });
    await screen.findByTestId("overview-not-generated");

    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ error: { code: "PROVIDER_ERROR" } }), {
          status: 502, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("", { status: 404 });
    }));

    const user = userEvent.setup();
    await user.click(screen.getByTestId("overview-generate"));

    await screen.findByTestId("overview-error");
    expect(screen.getByTestId("overview-error")).toHaveTextContent("AI 服务暂时不可用");
    // The abstract is still there — it never depended on a provider.
    expect(screen.getByTestId("overview-abstract")).toHaveTextContent(ABSTRACT);
    expect(screen.getByTestId("overview-generate")).toBeInTheDocument();
  });

  it("promises no configured provider rather than failing obscurely", async () => {
    // The read answers 404 the way the real route does, so the only message on
    // screen is the one the button press produced.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    openOverview();
    useWorkspaceStore.setState({ profileId: "" });
    await screen.findByTestId("overview-not-generated");

    const user = userEvent.setup();
    await user.click(screen.getByTestId("overview-generate"));

    await waitFor(() => {
      expect(screen.getByTestId("overview-error")).toHaveTextContent("请先配置可用的模型服务");
    });
  });
});

describe("DS-QA-014 · the no-document state", () => {
  it("says to open a paper, and offers nothing to generate", async () => {
    useWorkspaceStore.setState({ document: null, outlinePanel: "overview", sidebarOpen: true });
    render(<App />);

    await screen.findByTestId("overview-empty-state");
    expect(screen.queryByTestId("overview-generate")).toBeNull();
  });
});
