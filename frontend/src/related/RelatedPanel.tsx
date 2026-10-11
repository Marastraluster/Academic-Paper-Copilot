/**
 * 文献 — the papers around the open one.
 *
 * Three lists from a scholarly index (what it cites, what cites it, what is
 * similar), a free-text search, and per paper: how it relates to this one (one
 * model sentence, on request), where this paper cites it, and — when the index
 * lists an open-access PDF — import it into the library and read it.
 *
 * The panel never reaches the network on its own until the reader has added a
 * literature-search profile; before that it says what turning it on would send.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { BookMarked, ExternalLink, Loader2, Quote, RefreshCw, Search, Sparkles } from "lucide-react";

import { isAbortError } from "@/api/client";
import {
  explainRelated,
  fetchRelated,
  importRelated,
  searchRelated,
  SEARCH_PROFILE_CHANGED,
  type RelatedKind,
  type RelatedPaper,
  type RelatedResult,
} from "@/api/related";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { profileIdFor } from "@/settings/taskModels";
import { useWorkspaceStore } from "@/stores/workspace";
import { describeApiError } from "@/translation/errors";
import { openRegisteredDocument } from "@/translation/session";

type Filter = "all" | Exclude<RelatedKind, "search">;

const FILTERS: ReadonlyArray<{ value: Filter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "reference", label: "参考文献" },
  { value: "citing", label: "后续工作" },
  { value: "similar", label: "主题相似" },
];

const TAG: Record<RelatedKind, { label: string; className: string }> = {
  reference: { label: "参考文献", className: "bg-teal-500/15 text-teal-800 dark:text-teal-300" },
  citing: { label: "后续工作", className: "bg-orange-500/15 text-orange-800 dark:text-orange-300" },
  similar: { label: "主题相似", className: "bg-muted text-muted-foreground" },
  search: { label: "搜索结果", className: "bg-primary/10 text-primary" },
};

const SOURCE_NAME: Record<string, string> = {
  openalex: "OpenAlex",
  semantic_scholar: "Semantic Scholar",
  llm_web: "AI 联网搜索",
};

type Load =
  | { state: "loading" }
  | { state: "not-configured" }
  | { state: "failed"; reason: string }
  | { state: "ok"; result: RelatedResult };

export function RelatedPanel() {
  const documentId = useWorkspaceStore((state) => state.document?.documentId ?? null);
  const profileId = useWorkspaceStore((state) => profileIdFor("related", state));
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [searchHits, setSearchHits] = useState<RelatedPaper[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [explaining, setExplaining] = useState(false);
  const [relations, setRelations] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);

  const read = useCallback(
    async (refresh: boolean, signal?: AbortSignal) => {
      if (documentId === null) return;
      setLoad({ state: "loading" });
      try {
        const answer = await fetchRelated(documentId, { refresh, signal });
        if (answer.state === "not-configured") {
          setLoad({ state: "not-configured" });
          return;
        }
        setLoad({ state: "ok", result: answer.result });
        setRelations(
          Object.fromEntries(
            answer.result.papers.filter((p) => p.relation).map((p) => [p.key, p.relation as string]),
          ),
        );
      } catch (error) {
        if (isAbortError(error)) return;
        setLoad({ state: "failed", reason: describeApiError(error).detail });
      }
    },
    [documentId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void read(false, controller.signal);
    // Settings may turn the search on or off while this panel is showing.
    const reread = () => void read(false, controller.signal);
    window.addEventListener(SEARCH_PROFILE_CHANGED, reread);
    return () => {
      window.removeEventListener(SEARCH_PROFILE_CHANGED, reread);
      controller.abort();
    };
  }, [read]);

  const papers = useMemo(() => {
    if (searchHits !== null) return searchHits;
    if (load.state !== "ok") return [];
    return load.result.papers.filter((p) => filter === "all" || p.kind === filter);
  }, [load, filter, searchHits]);

  const counts = useMemo(() => {
    const out: Record<string, number> = { all: 0, reference: 0, citing: 0, similar: 0 };
    if (load.state === "ok") {
      for (const p of load.result.papers) {
        out.all = (out.all ?? 0) + 1;
        out[p.kind] = (out[p.kind] ?? 0) + 1;
      }
    }
    return out;
  }, [load]);

  if (documentId === null) {
    return <p className="px-3 py-6 text-xs text-muted-foreground">请先打开一篇论文。</p>;
  }

  if (load.state === "not-configured") {
    return (
      <div data-testid="related-off" className="space-y-2 px-3 py-4 text-xs leading-relaxed text-muted-foreground">
        <p className="flex items-center gap-1.5 font-medium text-foreground">
          <BookMarked className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
          相关论文搜索未开启
        </p>
        <p>
          开启后，会把这篇论文的 DOI（没有时用标题）发给 OpenAlex、Semantic Scholar，或交给一个支持联网搜索的模型（如 DeepSeek），查出它的参考文献、引用它的论文和主题相似的论文。论文正文和你的笔记不会被发送。
        </p>
        <p>在「设置 · 文献检索」中添加一个检索服务即可开启。</p>
      </div>
    );
  }

  const search = async () => {
    const q = query.trim();
    if (q === "") {
      setSearchHits(null);
      return;
    }
    setSearching(true);
    setNotice(null);
    try {
      setSearchHits(await searchRelated(documentId, q));
    } catch (error) {
      setNotice(describeApiError(error).detail);
    } finally {
      setSearching(false);
    }
  };

  const explainVisible = async () => {
    if (!profileId) {
      setNotice("请先在设置中配置模型服务。");
      return;
    }
    const keys = papers.filter((p) => !relations[p.key] && p.abstract && p.kind !== "search").slice(0, 8).map((p) => p.key);
    if (keys.length === 0) return;
    setExplaining(true);
    setNotice(null);
    try {
      const found = await explainRelated(documentId, profileId, keys);
      setRelations((current) => ({ ...current, ...found }));
    } catch (error) {
      setNotice(describeApiError(error).detail);
    } finally {
      setExplaining(false);
    }
  };

  return (
    <div data-testid="related-panel" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 px-3.5 pb-2 pt-1">
        <form
          className="flex h-9 items-center gap-1.5 rounded-full border border-[var(--glass-line)] bg-[var(--field-bg)] px-3.5 transition-[background-color,box-shadow] duration-300 focus-within:bg-white/90 focus-within:shadow-[0_0_0_3px_hsl(var(--primary)/.18)]"
          onSubmit={(event) => {
            event.preventDefault();
            void search();
          }}
        >
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <label className="sr-only" htmlFor="related-query">搜索论文</label>
          <input
            id="related-query"
            data-plain
            data-testid="related-query"
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              if (event.target.value === "") setSearchHits(null);
            }}
            placeholder="搜索论文标题或关键词…"
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
          />
          {searching && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
        </form>

        {searchHits === null && (
          <div className="flex flex-wrap items-center gap-1">
            {FILTERS.map((entry) => (
              <button
                key={entry.value}
                type="button"
                data-testid={`related-filter-${entry.value}`}
                aria-pressed={filter === entry.value}
                onClick={() => setFilter(entry.value)}
                className={cn(
                  "h-6 rounded-full px-2 text-2xs transition-colors",
                  filter === entry.value
                    ? "bg-foreground text-background"
                    : "bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                {entry.label}
                <span className="ml-1 tabular-nums opacity-70">{counts[entry.value] ?? 0}</span>
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 text-2xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate" data-testid="related-source">
            {load.state === "ok"
              ? load.result.identified
                ? `${SOURCE_NAME[load.result.source] ?? load.result.source} · 已识别本文${load.result.query.doi ? `（DOI ${load.result.query.doi}）` : "（按标题）"}`
                : `${SOURCE_NAME[load.result.source] ?? load.result.source} 中未能识别本文，可直接搜索`
              : load.state === "loading"
                ? "正在查找…"
                : ""}
          </span>
          {load.state === "ok" && (
            <button
              type="button"
              aria-label="重新查找"
              onClick={() => void read(true)}
              className="rounded p-0.5 hover:bg-muted"
            >
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {load.state === "loading" && (
          <div className="space-y-2" aria-label="正在载入">
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-2 rounded-xl bg-muted/50 p-3">
                <div className="reflow-skeleton h-2.5 w-1/3 rounded" />
                <div className="reflow-skeleton h-3 w-11/12 rounded" />
                <div className="reflow-skeleton h-2.5 w-1/2 rounded" />
              </div>
            ))}
          </div>
        )}
        {load.state === "failed" && (
          <p role="alert" className="text-xs text-amber-600">{load.reason}</p>
        )}
        {notice !== null && <p role="alert" className="text-xs text-amber-600">{notice}</p>}

        {load.state === "ok" && papers.length > 0 && searchHits === null && (
          <Button
            size="sm"
            variant="outline"
            data-testid="related-explain"
            disabled={explaining}
            className="w-full select-none"
            onClick={() => void explainVisible()}
          >
            {explaining ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            用 AI 说明这些论文与本文的关系
          </Button>
        )}

        {load.state === "ok" && papers.length === 0 && (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {searchHits !== null ? "没有找到匹配的论文。" : "这一类下暂时没有论文。"}
          </p>
        )}

        {papers.map((paper) => (
          <PaperCard
            key={`${paper.kind}-${paper.key}`}
            paper={paper}
            relation={relations[paper.key] ?? null}
            documentId={documentId}
            onNotice={setNotice}
          />
        ))}
      </div>
    </div>
  );
}

function PaperCard({
  paper,
  relation,
  documentId,
  onNotice,
}: {
  paper: RelatedPaper;
  relation: string | null;
  documentId: string;
  onNotice: (text: string | null) => void;
}) {
  const [importing, setImporting] = useState(false);
  const authors =
    paper.authors.length > 3 ? `${paper.authors.slice(0, 3).join(", ")} 等` : paper.authors.join(", ");

  const jumpTo = (paragraphId: string) => {
    const state = useWorkspaceStore.getState();
    const target = state.ir?.paragraphs.find((p) => p.id === paragraphId);
    if (!target) return;
    state.requestJump(target.page_number, target.bboxes);
  };

  const importAndOpen = async () => {
    setImporting(true);
    onNotice(null);
    try {
      const imported = await importRelated(documentId, paper.key);
      await openRegisteredDocument(imported.document_id, imported.name);
    } catch (error) {
      onNotice(describeApiError(error).detail);
    } finally {
      setImporting(false);
    }
  };

  return (
    <article
      data-testid="related-card"
      data-kind={paper.kind}
      className="animate-rise space-y-1.5 rounded-2xl border border-[var(--glass-line)] bg-[var(--glass-strong)] p-3 shadow-[var(--glass-highlight)] transition-transform duration-500 ease-spring hover:-translate-y-0.5"
    >
      <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        <span className={cn("rounded px-1.5 py-0.5 font-medium", TAG[paper.kind].className)}>
          {TAG[paper.kind].label}
        </span>
        <span className="min-w-0 truncate">
          {[paper.year, paper.venue].filter(Boolean).join(" · ")}
        </span>
        {paper.verified === false && (
          <span
            data-testid="related-unverified"
            title="由模型联网检索得到，但它的链接不在搜索返回的网页中，请打开原文页面核对"
            className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 font-medium text-amber-700"
          >
            待核对
          </span>
        )}
        {paper.cited_by !== null && (
          <span className="ml-auto shrink-0 tabular-nums">被引 {paper.cited_by.toLocaleString()}</span>
        )}
      </div>
      <h4 className="text-[0.8125rem] font-semibold leading-snug [font-family:Charter,'Source_Serif_Pro',Georgia,serif]">
        {paper.title}
      </h4>
      {authors && <p className="truncate text-2xs text-muted-foreground">{authors}</p>}
      {relation && (
        <p data-testid="related-relation" className="rounded-md bg-primary/5 px-2 py-1.5 text-xs leading-relaxed">
          <span className="font-medium text-primary">与本文的关系 · </span>
          {relation}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        {paper.oa_pdf_url && (
          <Button
            size="sm"
            data-testid="related-import"
            disabled={importing}
            onClick={() => void importAndOpen()}
            className="h-7 px-2 text-2xs"
          >
            {importing && <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />}
            导入并阅读
          </Button>
        )}
        {paper.cited_in_paragraph_id && (
          <button
            type="button"
            data-testid="related-cited-in"
            onClick={() => jumpTo(paper.cited_in_paragraph_id as string)}
            className="flex h-7 items-center gap-1 rounded-md bg-primary/10 px-2 text-2xs font-medium text-primary hover:bg-primary/15"
          >
            <Quote className="h-3 w-3" aria-hidden="true" />
            本文引用处{paper.marker ? ` [${paper.marker}]` : ""}
          </button>
        )}
        {paper.url && (
          <a
            href={paper.url}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto flex h-7 items-center gap-1 rounded-md px-1.5 text-2xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
            原文页面
          </a>
        )}
      </div>
    </article>
  );
}

export default RelatedPanel;
