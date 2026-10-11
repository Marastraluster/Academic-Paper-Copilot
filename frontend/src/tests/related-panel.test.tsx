/**
 * 文献 — the related-papers panel.
 *
 * Off until a search profile exists, and saying what turning it on would send;
 * once on, the three lists, the filter, the jump to where the paper cites a
 * reference, and the one-click explanation that costs one model call.
 */
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SEARCH_PROFILE_CHANGED } from "@/api/related";
import { RelatedPanel } from "@/related/RelatedPanel";
import { useWorkspaceStore } from "@/stores/workspace";
import { seedDocument, TEST_DOCUMENT_ID } from "@/tests/fixtures";

const paper = (key: string, kind: string, extra: Record<string, unknown> = {}) => ({
  key, kind, title: `Paper ${key}`, authors: ["A. One", "B. Two", "C. Three", "D. Four"],
  year: 2016, venue: "CVPR", doi: null, url: `https://example.org/${key}`,
  abstract: "An abstract.", cited_by: 1200, oa_pdf_url: null, relation: null, ...extra,
});

const RESULT = {
  source: "openalex",
  identified: paper("W9", "reference"),
  query: { doi: "10.48550/arXiv.1512.03385", title: "Paper" },
  cached: true,
  papers: [
    paper("W1", "reference", { cited_in_paragraph_id: "p2", marker: 5 }),
    paper("W2", "reference"),
    paper("W3", "citing"),
    paper("W5", "similar"),
  ],
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("文献 panel", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      document: seedDocument(),
      profileId: "prof_1",
      ir: {
        paragraphs: [{ id: "p2", page_number: 3, bboxes: [[10, 20, 100, 60]] }],
      } as never,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is off until a search profile exists, and says what turning it on would send", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      json({ error: { code: "SEARCH_NOT_CONFIGURED", message: "" } }, 409)));
    render(<RelatedPanel />);
    const off = await screen.findByTestId("related-off");
    expect(off).toHaveTextContent("DOI");
    expect(off).toHaveTextContent("论文正文和你的笔记不会被发送");
  });

  it("asks again when settings turn the search on, without being reopened", async () => {
    let configured = false;
    vi.stubGlobal("fetch", vi.fn(async () =>
      configured ? json(RESULT) : json({ error: { code: "SEARCH_NOT_CONFIGURED", message: "" } }, 409)));
    render(<RelatedPanel />);
    await screen.findByTestId("related-off");

    configured = true;
    act(() => {
      window.dispatchEvent(new Event(SEARCH_PROFILE_CHANGED));
    });
    expect(await screen.findAllByTestId("related-card")).toHaveLength(4);
    expect(screen.queryByTestId("related-off")).toBeNull();
  });

  it("lists, filters, jumps to the citing sentence, and explains in one call", async () => {
    const user = userEvent.setup();
    const posts: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(String(url));
        const keys = JSON.parse(String(init.body)).keys as string[];
        return json({ relations: Object.fromEntries(keys.map((k) => [k, `${k} 提出了本文所用的基线`])) });
      }
      return json(RESULT);
    }));
    const jump = vi.fn();
    useWorkspaceStore.setState({ requestJump: jump });

    render(<RelatedPanel />);
    expect(await screen.findAllByTestId("related-card")).toHaveLength(4);
    expect(screen.getByTestId("related-source")).toHaveTextContent("OpenAlex · 已识别本文");

    await user.click(screen.getByTestId("related-filter-citing"));
    expect(screen.getAllByTestId("related-card")).toHaveLength(1);
    await user.click(screen.getByTestId("related-filter-all"));

    const first = screen.getAllByTestId("related-card")[0]!;
    expect(within(first).getByText(/A. One, B. Two, C. Three 等/)).toBeInTheDocument();
    await user.click(within(first).getByTestId("related-cited-in"));
    expect(jump).toHaveBeenCalledWith(3, [[10, 20, 100, 60]]);

    await user.click(screen.getByTestId("related-explain"));
    expect(await screen.findAllByTestId("related-relation")).toHaveLength(4);
    expect(posts).toEqual([`http://127.0.0.1:8000/api/documents/${TEST_DOCUMENT_ID}/related/explain`]);
  });

  it("names the AI web search and flags what its search did not confirm", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ...RESULT,
      source: "llm_web",
      papers: [paper("web_a", "citing", { verified: true }), paper("web_b", "similar", { verified: false })],
    })));
    render(<RelatedPanel />);
    const cards = await screen.findAllByTestId("related-card");
    expect(screen.getByTestId("related-source")).toHaveTextContent("AI 联网搜索 · 已识别本文");
    expect(within(cards[0]!).queryByTestId("related-unverified")).toBeNull();
    expect(within(cards[1]!).getByTestId("related-unverified")).toHaveTextContent("待核对");
  });
});
