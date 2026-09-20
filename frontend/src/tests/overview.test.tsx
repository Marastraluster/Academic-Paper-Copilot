/**
 * DS-QA-015 — the reading entry, and the one control that costs money.
 *
 * The panel was rewired in DS-QA-015-FIX-001. It used to read `DocumentAnalysis`
 * — the artifact the *translation* pipeline produces — which, measured, summed up
 * the bibliography and said things like *"It is useful for preserving author
 * names and affiliation spelling during translation"* to a person deciding
 * whether to read a paper. These tests are about the reader artifact instead, and
 * about the two properties that carry the whole feature:
 *
 * **Opening a paper reaches no provider.** The instant layer renders from the IR
 * the application already holds and the overview layer is a GET. Between them
 * there is no path to a model until a reader presses a button — which matters
 * most in this panel, because 概览 is the tab a paper opens on.
 *
 * **An overview of one paper is never rendered under another.**
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OverviewView } from "@/api/overview";
import { App } from "@/app/App";
import { useWorkspaceStore } from "@/stores/workspace";
import { seedDocument, seedQaSections } from "@/tests/fixtures";

declare global {
  // eslint-disable-next-line no-var
  var __rotation: number | undefined;
}

const ABSTRACT =
  "Deeper neural networks are more difficult to train. We present a residual learning framework.";
const CONTENT_HASH = "hash_current";

function seedIr() {
  const document = seedDocument();
  useWorkspaceStore.setState({
    ir: {
      document_id: document.documentId ?? "doc_test",
      content_hash: CONTENT_HASH,
      page_count: 12,
      pipeline_version: "5",
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
    } as never,
  });
  return document;
}

function overview(over: Partial<OverviewView> = {}): OverviewView {
  return {
    status: "READY",
    cached: true,
    content_hash: CONTENT_HASH,
    target_language: "zh-CN",
    provider_model: "deepseek-flash",
    created_at: "2026-09-19T00:00:00+00:00",
    source_sections: ["Abstract", "1. Introduction"],
    notes: [],
    items: [
      { category: "research_question", text: "论文解决深度网络的退化问题。",
        inferred: false, partial: false, evidence: [{ page_number: 1 }] },
      { category: "core_idea", text: "让堆叠层拟合残差映射 F(x) = H(x) − x。",
        inferred: false, partial: false, evidence: [{ page_number: 2 }] },
      { category: "contributions", text: "提出 residual learning framework。",
        inferred: true, partial: false, evidence: [{ page_number: 1 }] },
    ],
    key_terms: [
      { term: "ResNet-50", definition: "一种深层残差网络。", evidence: [{ page_number: 3 }] },
      { term: "CIFAR-10", definition: "一个图像分类数据集。", evidence: [{ page_number: 7 }] },
    ],
    ...over,
  };
}

function openOverview() {
  // Sections first: `seedQaSections` installs its own IR, and ours would be
  // silently overwritten — a fixture bug that showed up as the panel rendering
  // the filename as the title.
  seedQaSections();
  const document = seedIr();
  useWorkspaceStore.setState({
    outlinePanel: "overview", sidebarOpen: true,
    overview: null, overviewFor: null, overviewStatus: "idle",
    overviewError: null, overviewStartedAt: null,
  });
  render(<App />);
  return document;
}

/** Answer every request the way the real routes do. */
function backend(options: { overview?: OverviewView | null; onPost?: () => Response } = {}) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    if (init?.method === "POST") {
      return options.onPost ? options.onPost() : jsonResponse(overview({ cached: false }));
    }
    if (String(url).includes("/overview")) {
      return options.overview
        ? jsonResponse(options.overview)
        : new Response("", { status: 404 });
    }
    return new Response("", { status: 404 });
  }));
  return calls;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  useWorkspaceStore.setState({
    readerMode: "original", translation: null,
    overview: null, overviewFor: null, overviewStatus: "idle",
    overviewError: null, overviewStartedAt: null,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DS-QA-015 · the instant entry", () => {
  it("shows the title, the abstract verbatim and the structure", async () => {
    backend();
    openOverview();
    await screen.findByTestId("overview-panel");

    expect(screen.getByTestId("overview-title")).toHaveTextContent(
      "Deep Residual Learning for Image Recognition",
    );
    // Verbatim: the abstract is the one summary the authors wrote, and a
    // paraphrase of it would be this panel's first claim and its first
    // unnecessary one.
    expect(screen.getByTestId("overview-abstract")).toHaveTextContent(ABSTRACT);
    expect(screen.getByTestId("overview-metrics")).toHaveTextContent("12 页");
  });

  it("renders synchronously, without a spinner, before the cache read returns", async () => {
    backend();
    openOverview();
    // No `await` on purpose: the entry must be there on the first paint.
    expect(screen.getByTestId("overview-title")).toBeInTheDocument();
    expect(screen.queryByTestId("overview-progress")).toBeNull();
  });

  it("says the paper is still being read rather than claiming it has no abstract", async () => {
    /* Two different statements, and the panel can only make the second one after
       it has looked. Found by a browser harness that waited for exactly this
       notice and got it before the extraction had finished. */
    seedQaSections();
    seedDocument();
    useWorkspaceStore.setState({ ir: null, outlinePanel: "overview", sidebarOpen: true });
    backend();
    render(<App />);

    await screen.findByTestId("overview-no-ir");
    expect(screen.queryByTestId("overview-no-abstract")).toBeNull();
  });

  it("says there is no abstract rather than substituting the introduction", async () => {
    seedQaSections();
    const document = seedDocument();
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
    backend();
    render(<App />);

    await screen.findByTestId("overview-no-abstract");
    expect(screen.queryByTestId("overview-abstract")).toBeNull();
    expect(screen.getByTestId("overview-entry")).not.toHaveTextContent("This is the introduction");
  });
});

describe("DS-QA-015 · reading the cache", () => {
  it("asks once, spends nothing, and renders the stored overview", async () => {
    const calls = backend({ overview: overview() });
    openOverview();

    await screen.findByTestId("overview-body");
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    // No POST: the only request that reaches a provider must never happen
    // because the panel appeared.
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
    expect(calls.every((call) => call.includes("/overview"))).toBe(true);
  });

  it("renders the categories the schema defines", async () => {
    backend({ overview: overview() });
    openOverview();
    await screen.findByTestId("overview-body");

    expect(screen.getByTestId("overview-research_question")).toHaveTextContent("退化问题");
    expect(screen.getByTestId("overview-core_idea")).toHaveTextContent("残差映射");
    expect(screen.getByTestId("overview-contributions")).toHaveTextContent("residual learning");
  });

  it("marks a claim the model organised rather than the authors stated", async () => {
    backend({ overview: overview() });
    openOverview();
    await screen.findByTestId("overview-body");

    // Said, not implied: a reader checking the paper should know which kind of
    // claim they are reading.
    expect(screen.getByTestId("overview-inferred-contributions-0")).toHaveTextContent("归纳");
    expect(screen.queryByTestId("overview-inferred-research_question-0")).toBeNull();
  });

  it("keeps the paper's own spelling of a term", async () => {
    backend({ overview: overview() });
    openOverview();
    await screen.findByTestId("overview-body");

    // `ResNet-50` is an identifier; case-folding it is the one thing that would
    // make a key-terms list useless.
    expect(screen.getByTestId("overview-term-ResNet-50")).toHaveTextContent("ResNet-50");
    expect(screen.getByTestId("overview-term-CIFAR-10")).toHaveTextContent("CIFAR-10");
  });

  it("says which model produced it", async () => {
    backend({ overview: overview() });
    openOverview();
    await screen.findByTestId("overview-body");
    // A stored overview survives a model change, so the reader is told whose
    // reading it is rather than left to assume it is the configured one.
    expect(screen.getByTestId("overview-provenance")).toHaveTextContent("deepseek-flash");
  });

  it("badges a partial overview", async () => {
    backend({ overview: overview({ status: "PARTIAL", notes: ["no findings"] }) });
    openOverview();
    await screen.findByTestId("overview-body");
    expect(screen.getByTestId("overview-partial")).toBeInTheDocument();
  });

  it("hides an overview that describes a different file", async () => {
    backend({ overview: overview({ content_hash: "hash_of_another_paper" }) });
    openOverview();
    await screen.findByTestId("overview-not-generated");
    expect(screen.queryByTestId("overview-body")).toBeNull();
  });

  it("shows the entry when there is no overview, and does not fetch one", async () => {
    const calls = backend({ overview: null });
    openOverview();
    await screen.findByTestId("overview-not-generated");

    expect(screen.getByTestId("overview-abstract")).toHaveTextContent(ABSTRACT);
    expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
  });
});

describe("DS-QA-015 · generating", () => {
  it("asks once, on the button, and renders what comes back", async () => {
    openOverview();
    useWorkspaceStore.setState({ profileId: "prof_1" });
    await screen.findByTestId("overview-not-generated");

    const calls = backend({ overview: null });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("overview-generate"));

    await screen.findByTestId("overview-body");
    const posts = calls.filter((call) => call.startsWith("POST"));
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("/overview");
  });

  it("keeps the instant entry usable when generation fails", async () => {
    /* The paper must not be replaced by an error screen. The reader opened a
       document; a provider being unreachable does not un-open it. */
    openOverview();
    useWorkspaceStore.setState({ profileId: "prof_1" });
    await screen.findByTestId("overview-not-generated");

    backend({
      overview: null,
      onPost: () => new Response(JSON.stringify({ error: { code: "PROVIDER_ERROR" } }), {
        status: 502, headers: { "Content-Type": "application/json" },
      }),
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("overview-generate"));

    await screen.findByTestId("overview-error");
    expect(screen.getByTestId("overview-error")).toHaveTextContent("AI 服务暂时不可用");
    // The abstract never depended on a provider.
    expect(screen.getByTestId("overview-abstract")).toHaveTextContent(ABSTRACT);
    expect(screen.getByTestId("overview-generate")).toBeInTheDocument();
  });

  it("says which failure it was, not just that it failed", async () => {
    openOverview();
    useWorkspaceStore.setState({ profileId: "prof_1" });
    await screen.findByTestId("overview-not-generated");

    backend({
      overview: null,
      onPost: () => new Response(JSON.stringify({ error: { code: "RATE_LIMIT" } }), {
        status: 429, headers: { "Content-Type": "application/json" },
      }),
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("overview-generate"));

    await screen.findByTestId("overview-error");
    expect(screen.getByTestId("overview-error")).toHaveTextContent("请求过于频繁");
  });

  it("promises no configured provider rather than failing obscurely", async () => {
    backend({ overview: null });
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

describe("DS-QA-015 · evidence", () => {
  it("offers the page an item came from, and jumps there", async () => {
    backend({ overview: overview() });
    openOverview();
    await screen.findByTestId("overview-body");

    const user = userEvent.setup();
    await user.click(screen.getByTestId("overview-evidence-p2"));

    // The same jump the citation and section paths use; no second engine, and
    // no rectangle — the provider was never given one.
    const jump = useWorkspaceStore.getState().jumpRequest;
    expect(jump?.pageNumber).toBe(2);
    expect(jump?.bboxes).toEqual([]);
  });
});

describe("DS-QA-015 · the no-document state", () => {
  it("says to open a paper, and offers nothing to generate", async () => {
    backend({ overview: null });
    useWorkspaceStore.setState({ document: null, outlinePanel: "overview", sidebarOpen: true });
    render(<App />);

    await screen.findByTestId("overview-empty-state");
    expect(screen.queryByTestId("overview-generate")).toBeNull();
  });
});
