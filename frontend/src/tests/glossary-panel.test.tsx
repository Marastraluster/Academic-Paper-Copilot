/**
 * 术语表 — seeing and correcting the words a paper is translated with.
 *
 * Saving sends the whole glossary and spends nothing; only when the backend
 * says paragraphs were affected is the translation started again, and it is
 * told nothing about which — it resumes, and the backend sends what is missing.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GlossaryPanel, relatedEdits } from "@/bilingual/GlossaryPanel";
import { useWorkspaceStore } from "@/stores/workspace";
import { seedDocument, TEST_DOCUMENT_ID } from "@/tests/fixtures";

const TERMS = [
  { source: "residual learning", target: "残差学习" },
  { source: "shortcut connection", target: "捷径" },
];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("术语表", () => {
  let calls: Array<{ method: string; url: string; body: unknown }>;
  let affected: number;

  beforeEach(() => {
    calls = [];
    affected = 0;
    useWorkspaceStore.setState({
      document: seedDocument(), profiles: [], profileId: "prof_1", taskModels: {},
    });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, url: String(url), body });
      if (String(url).includes("/glossary")) {
        if (method === "POST" && String(url).includes("/glossary")) {
          return json({ exists: true, terms: body.terms, affected_paragraphs: affected });
        }
        return json({ exists: true, terms: TERMS });
      }
      if (String(url).endsWith("/bilingual-text/jobs")) return json({ status: "completed", cached: true }, 202);
      return json({ error: { code: "BILINGUAL_TEXT_NOT_FOUND", message: "" } }, 404);
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const open = async (disabled = false) => {
    const user = userEvent.setup();
    render(<GlossaryPanel documentId={TEST_DOCUMENT_ID} disabled={disabled} refreshKey="none:0" />);
    await waitFor(() => expect(screen.getByTestId("glossary-toggle")).toHaveTextContent("术语表 2"));
    await user.click(screen.getByTestId("glossary-toggle"));
    return user;
  };

  it("lists the paper's terms, and cannot be saved until something changes", async () => {
    await open();
    expect(screen.getAllByTestId("glossary-row")).toHaveLength(2);
    expect(screen.getByLabelText("术语 1 译文")).toHaveValue("残差学习");
    expect(screen.getByTestId("glossary-save")).toBeDisabled();
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("saves a corrected term and retranslates only when paragraphs are affected", async () => {
    affected = 3;
    const user = await open();
    const target = screen.getByLabelText("术语 2 译文");
    await user.clear(target);
    await user.type(target, "快捷连接");
    await user.click(screen.getByTestId("glossary-save"));

    await waitFor(() => expect(screen.getByTestId("glossary-message")).toHaveTextContent("重译受影响的 3 段"));
    const put = calls.find((call) => call.method === "POST" && call.url.includes("/glossary"))!;
    expect(put.body).toEqual({
      target_language: "zh-CN",
      terms: [TERMS[0], { source: "shortcut connection", target: "快捷连接" }],
    });
    // The resume is an ordinary job start: it names a profile, not paragraphs.
    await waitFor(() => expect(calls.some((call) => call.url.endsWith("/bilingual-text/jobs"))).toBe(true));
    const job = calls.find((call) => call.url.endsWith("/bilingual-text/jobs"))!;
    expect(job.body).toMatchObject({ profile_id: "prof_1", force: false });
  });

  it("adds and removes terms, drops half-filled rows, and spends nothing when nothing is affected", async () => {
    const user = await open();
    await user.click(screen.getByLabelText("删除术语 residual learning"));
    await user.click(screen.getByTestId("glossary-add"));
    await user.type(screen.getByLabelText("术语 2 原文"), "bottleneck");
    await user.type(screen.getByLabelText("术语 2 译文"), "瓶颈");
    await user.click(screen.getByTestId("glossary-add")); // left empty
    await user.click(screen.getByTestId("glossary-save"));

    await waitFor(() => expect(screen.getByTestId("glossary-message")).toHaveTextContent("无需重译"));
    expect(calls.find((call) => call.method === "POST" && call.url.includes("/glossary"))!.body).toMatchObject({
      terms: [TERMS[1], { source: "bottleneck", target: "瓶颈" }],
    });
    expect(calls.some((call) => call.url.endsWith("/bilingual-text/jobs"))).toBe(false);
  });

  it("points out terms built on the one just changed", async () => {
    // A family: both translations share the stem being replaced.
    expect(relatedEdits(
      [{ source: "shortcut connection", target: "快捷连接" }, { source: "identity shortcut", target: "恒等快捷连接" }],
      [{ source: "shortcut connection", target: "捷径连接" }, { source: "identity shortcut", target: "恒等快捷连接" }],
    )).toEqual([{ from: "快捷连接", to: "捷径连接", sources: ["identity shortcut"] }]);

    const user = await open();
    const target = screen.getByLabelText("术语 1 译文");
    await user.clear(target);
    await user.type(target, "残差式学习");
    // Nothing else in this glossary is built on 「残差学习」, so nothing is suggested.
    expect(screen.queryByTestId("glossary-related")).toBeNull();
  });

  it("applies the same substitution to the related terms when asked", async () => {
    const user = userEvent.setup();
    const family = [
      { source: "shortcut connection", target: "快捷连接" },
      { source: "identity shortcut", target: "恒等快捷连接" },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => json({ exists: true, terms: family })));
    render(<GlossaryPanel documentId={TEST_DOCUMENT_ID} disabled={false} refreshKey="none:0" />);
    await waitFor(() => expect(screen.getByTestId("glossary-toggle")).toHaveTextContent("术语表 2"));
    await user.click(screen.getByTestId("glossary-toggle"));

    const target = screen.getByLabelText("术语 1 译文");
    await user.clear(target);
    await user.type(target, "捷径连接");
    expect(screen.getByTestId("glossary-related")).toHaveTextContent(
      "「identity shortcut」的译法里也含有「快捷连接」",
    );
    await user.click(screen.getByTestId("glossary-related-apply"));
    expect(screen.getByLabelText("术语 2 译文")).toHaveValue("恒等捷径连接");
    expect(screen.queryByTestId("glossary-related")).toBeNull();
  });

  it("extracts again into the draft, and saves nothing by itself", async () => {
    const user = userEvent.setup();
    const proposed = [{ source: "bottleneck", target: "瓶颈" }];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ method, url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (String(url).endsWith("/glossary/extract")) return json({ terms: proposed });
      return json({ exists: true, terms: TERMS });
    }));
    render(<GlossaryPanel documentId={TEST_DOCUMENT_ID} disabled={false} refreshKey="none:0" />);
    await waitFor(() => expect(screen.getByTestId("glossary-toggle")).toHaveTextContent("术语表 2"));
    await user.click(screen.getByTestId("glossary-toggle"));
    await user.click(screen.getByTestId("glossary-extract"));

    await waitFor(() => expect(screen.getByTestId("glossary-message")).toHaveTextContent("抽取到 1 个术语"));
    expect(screen.getAllByTestId("glossary-row")).toHaveLength(1);
    expect(screen.getByLabelText("术语 1 原文")).toHaveValue("bottleneck");
    const extract = calls.find((call) => call.url.endsWith("/glossary/extract"))!;
    expect(extract.body).toEqual({ profile_id: "prof_1", target_language: "zh-CN" });
    // Only the extraction was sent: the glossary itself was not saved.
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(screen.getByTestId("glossary-save")).toBeEnabled();
  });

  it("is read-only while a translation is running", async () => {
    await open(true);
    expect(screen.getByLabelText("术语 1 译文")).toBeDisabled();
    expect(screen.getByTestId("glossary-add")).toBeDisabled();
    expect(screen.getByTestId("glossary-panel")).toHaveTextContent("翻译进行中");
  });
});
