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
    input_tokens: 1520,
    output_tokens: 640,
    source_sections: ["Abstract", "1. Introduction"],
    notes: [],
    items: [
      { category: "research_question", text: "论文解决深度网络的退化问题。",
        inferred: false, partial: false,
        evidence: [{ paragraph_id: "p_1", page_number: 1 }] },
      { category: "core_idea", text: "让堆叠层拟合残差映射 F(x) = H(x) − x。",
        inferred: false, partial: false,
        evidence: [{ paragraph_id: "p_2", page_number: 3 }] },
      { category: "contributions", text: "提出 residual learning framework。",
        inferred: true, partial: false,
        evidence: [{ paragraph_id: "p_1", page_number: 1 }] },
    ],
    key_terms: [
      { term: "ResNet-50", definition: "一种深层残差网络。",
        evidence: [{ paragraph_id: "p_1", page_number: 1 }] },
      // An id this extraction does not contain: the badge still goes to the
      // page, which is the half of the provenance that cannot go stale.
      { term: "CIFAR-10", definition: "一个图像分类数据集。",
        evidence: [{ paragraph_id: "p_gone", page_number: 7 }] },
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

  it("holds up when the backend cannot be reached at all", async () => {
    /* The one thing that must never wait on anything. Layer A renders from the
       IR in memory, so a provider being unreachable, a backend that is down and
       a request that simply never answers all leave the same thing on screen:
       the paper's own title, abstract, structure and where to start. */
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    openOverview();

    await screen.findByTestId("overview-error");
    expect(screen.getByTestId("overview-title")).toHaveTextContent(
      "Deep Residual Learning for Image Recognition",
    );
    expect(screen.getByTestId("overview-abstract")).toHaveTextContent(ABSTRACT);
    expect(screen.getByTestId("overview-metrics")).toHaveTextContent("12 页");
    expect(screen.getByTestId("overview-start-reading")).toBeInTheDocument();
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

  it("marks a claim only part of whose evidence supports it", async () => {
    /* A claim the reader should not take at full strength. Distinct from the
       PARTIAL badge below, which says the *overview* is incomplete rather than
       that this particular sentence is. */
    backend({ overview: overview({ items: [
      { category: "findings", text: "作者推测这种退化来自优化困难。",
        inferred: false, partial: true,
        evidence: [{ paragraph_id: "p_1", page_number: 1 }] },
      { category: "findings", text: "作者测得的 top-1 error 为 3.57%。",
        inferred: false, partial: false,
        evidence: [{ paragraph_id: "p_1", page_number: 1 }] },
    ] }) });
    openOverview();
    await screen.findByTestId("overview-body");

    expect(screen.getByTestId("claim-caveat-pill")).toHaveTextContent("部分证据支持");
    // Exactly the one claim: a pill on every claim is the same as a pill on none.
    expect(screen.getAllByTestId("claim-caveat-pill")).toHaveLength(1);
  });

  it("reports what the run cost, in the provider's own numbers", async () => {
    backend({ overview: overview({ input_tokens: 1520, output_tokens: 640 }) });
    openOverview();
    await screen.findByTestId("overview-body");

    expect(screen.getByTestId("overview-usage")).toHaveTextContent("1520");
    expect(screen.getByTestId("overview-usage")).toHaveTextContent("640");
  });

  it("says the token count is unavailable rather than estimating one", async () => {
    // A store written before usage was recorded, or an endpoint that reported
    // none. Either way the honest answer is that there is no number.
    backend({ overview: overview({ input_tokens: null, output_tokens: null }) });
    openOverview();
    await screen.findByTestId("overview-body");

    expect(screen.getByTestId("overview-usage")).toHaveTextContent("Token 统计不可用");
  });

  it("says the paper states no limitations rather than dropping them quietly", async () => {
    /* AC-P0-31. An absent category reads exactly like a category the panel
       forgot, and a reader deciding whether to trust the paper is owed the
       difference. */
    backend({ overview: overview() });
    openOverview();
    await screen.findByTestId("overview-body");

    expect(screen.getByTestId("overview-no-limitations")).toHaveTextContent(
      "原论文未设独立局限性章节",
    );
  });

  it("does not tell a paper with a limitations section that it has none", async () => {
    /* The claim is about the paper. When the extraction found a section for
       limitations and the overview is silent about it, that is the overview's
       omission — asserting the paper has none would be inventing a fact. */
    backend({ overview: overview({ source_sections: ["Abstract", "5. Limitations"] }) });
    openOverview();
    await screen.findByTestId("overview-body");

    expect(screen.queryByTestId("overview-no-limitations")).toBeNull();
  });

  it("does not make that claim about an incomplete overview", async () => {
    backend({ overview: overview({ status: "PARTIAL" }) });
    openOverview();
    await screen.findByTestId("overview-body");

    expect(screen.queryByTestId("overview-no-limitations")).toBeNull();
  });

  it("shows twelve terms, and the rest behind an expansion", async () => {
    // AC-P0-32. A curated list, not a glossary flood: the measured baseline
    // produced 197 terms, which is a document rather than an orientation.
    const terms = Array.from({ length: 15 }, (_, index) => ({
      term: `Term-${index}`,
      definition: "一个术语。",
      evidence: [{ paragraph_id: "p_1", page_number: 1 }],
    }));
    backend({ overview: overview({ key_terms: terms }) });
    openOverview();
    await screen.findByTestId("overview-body");

    expect(screen.getAllByTestId(/^overview-term-/)).toHaveLength(12);
    const expand = screen.getByTestId("overview-terms-expand");
    expect(expand).toHaveTextContent("15");

    const user = userEvent.setup();
    await user.click(expand);

    expect(screen.getAllByTestId(/^overview-term-/)).toHaveLength(15);
    expect(screen.queryByTestId("overview-terms-expand")).toBeNull();
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

  it("tells a paper that cannot be structured apart from a provider that is down", async () => {
    /* Three failures, three next actions: fix a key, try again later, or try a
       different paper. One message for all of them teaches the reader none of
       them — and the paper being unreadable is the one they cannot retry their
       way out of. */
    openOverview();
    useWorkspaceStore.setState({ profileId: "prof_1" });
    await screen.findByTestId("overview-not-generated");

    backend({
      overview: null,
      onPost: () => new Response(JSON.stringify({ error: { code: "EXTRACTION_ERROR" } }), {
        status: 422, headers: { "Content-Type": "application/json" },
      }),
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("overview-generate"));

    await screen.findByTestId("overview-error");
    expect(screen.getByTestId("overview-error")).toHaveTextContent("结构无法解析");
  });

  it("calls a cancelled run cancelled rather than failed", async () => {
    openOverview();
    useWorkspaceStore.setState({ profileId: "prof_1" });
    await screen.findByTestId("overview-not-generated");

    backend({
      overview: null,
      onPost: () => {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      },
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("overview-generate"));

    await screen.findByTestId("overview-error");
    expect(screen.getByTestId("overview-error")).toHaveTextContent("已取消");
    // And the panel is not left saying a run is in progress.
    expect(screen.queryByTestId("overview-progress")).toBeNull();
    expect(screen.getByTestId("overview-generate")).toBeInTheDocument();
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

describe("DS-QA-015 · leaving mid-generation", () => {
  it("aborts the request when the reader opens another paper", async () => {
    /* AC-P0-44. Discarding the answer is not enough on its own: a generation for
       a paper the reader has left is work nobody is waiting for, and it should
       stop rather than run to completion and be thrown away. The backend has
       already cached it under the paper's own content hash, so cancelling costs
       nothing that was not already paid for. */
    openOverview();
    useWorkspaceStore.setState({ profileId: "prof_1" });
    await screen.findByTestId("overview-not-generated");

    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        if (init.signal) signals.push(init.signal);
        // A generation takes tens of seconds; this one never answers.
        return new Promise<Response>(() => {});
      }
      return new Response("", { status: 404 });
    }));

    const user = userEvent.setup();
    await user.click(screen.getByTestId("overview-generate"));
    await waitFor(() => expect(signals).toHaveLength(1));
    expect(signals[0].aborted).toBe(false);

    const { openDocument } = await import("@/translation/session");
    openDocument(new File([new Uint8Array([1])], "b.pdf", { type: "application/pdf" }));

    expect(signals[0].aborted).toBe(true);
    // And nothing of A's is left behind for B to inherit.
    const state = useWorkspaceStore.getState();
    expect(state.overview).toBeNull();
    expect(state.overviewFor).toBeNull();
    expect(state.overviewStatus).toBe("idle");
  });
});

describe("DS-QA-015 · evidence", () => {
  it("offers the page an item came from, and jumps there", async () => {
    backend({ overview: overview() });
    openOverview();
    await screen.findByTestId("overview-body");

    const user = userEvent.setup();
    await user.click(screen.getByTestId("overview-evidence-p3"));

    // The same jump the citation and section paths use, so there is no second
    // navigation engine to keep in step with the first.
    const jump = useWorkspaceStore.getState().jumpRequest;
    expect(jump?.pageNumber).toBe(3);
  });

  it("draws the source paragraph's rectangle, from the reader's own extraction", async () => {
    /* The artifact carries a paragraph id and never a coordinate — the model was
       shown excerpts, not geometry — so the rectangle comes from the IR the
       client is already holding. That is the only rectangle anyone measured. */
    backend({ overview: overview() });
    openOverview();
    await screen.findByTestId("overview-body");

    const user = userEvent.setup();
    await user.click(screen.getByTestId("overview-evidence-p3"));

    const jump = useWorkspaceStore.getState().jumpRequest;
    expect(jump?.bboxes).toEqual([[50, 100, 545, 140]]);
    // Lifted off the top edge, or the box the reader asked for lands under the
    // fold of the page they were sent to.
    expect(jump?.offsetPt).toBe(100);
  });

  it("degrades to the page when the paragraph is not in this extraction", async () => {
    backend({ overview: overview() });
    openOverview();
    await screen.findByTestId("overview-body");

    const user = userEvent.setup();
    await user.click(screen.getByTestId("overview-evidence-p7"));

    const jump = useWorkspaceStore.getState().jumpRequest;
    expect(jump?.pageNumber).toBe(7);
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
