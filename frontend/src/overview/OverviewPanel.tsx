import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { ChevronRight, Loader2, MapPin, Sparkles, TriangleAlert } from "lucide-react";

import { jumpToSection } from "@/outline/navigate";
import { firstReadingTarget } from "@/overview/roadmap";
import { generateOverview, loadOverview, overviewIsCurrent } from "@/overview/session";
import { useWorkspaceStore } from "@/stores/workspace";

/**
 * The generated half loads when there is something to show.
 *
 * The deterministic entry above it — title, abstract, structure, where to start —
 * is deliberately **not** behind this boundary: it is the first paint of the tab a
 * paper opens on, and a suspension in front of it would turn the one thing that
 * always works into something that sometimes waits.
 */
const GeneratedOverview = lazy(() =>
  import("@/overview/GeneratedOverview").then((module) => ({
    default: module.GeneratedOverview,
  })),
);

/**
 * Where to start reading, and what a model made of the paper.
 *
 * ## Two layers, and the first one never waits
 *
 * Everything above the analysis block comes from the `DocumentIR` the
 * application already holds when a paper finishes registering: the title, the
 * abstract, the section count, and the recommendation. It renders on the first
 * paint with no request and no spinner — which matters more here than anywhere
 * else, because 概览 is the tab a paper opens on.
 *
 * The overview below it is read from the backend — the **reader** overview, not
 * the translation-context artifact DS-QA-014 showed, which summarised the
 * bibliography and addressed a translator. **It is never generated from here.**
 * When there is none the panel says so and offers a button; pressing it is the
 * only path in the application that can reach a provider.
 */

function PanelLoading() {
  return (
    <p data-testid="assistant-panel-loading" className="px-3 py-6 text-xs text-muted-foreground">
      正在载入…
    </p>
  );
}

export function OverviewPanel() {
  const document_ = useWorkspaceStore((s) => s.document);
  const ir = useWorkspaceStore((s) => s.ir);
  const sections = useWorkspaceStore((s) => s.sections);
  const overview = useWorkspaceStore((s) => s.overview);
  const overviewFor = useWorkspaceStore((s) => s.overviewFor);
  const status = useWorkspaceStore((s) => s.overviewStatus);
  const error = useWorkspaceStore((s) => s.overviewError);
  const startedAt = useWorkspaceStore((s) => s.overviewStartedAt);
  const documentId = document_?.documentId ?? null;
  const [expanded, setExpanded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  void setExpanded;
  // A refusal that never reached the store — no document, no configured
  // provider — still has to be said out loud rather than leaving the button
  // looking like it did nothing.
  const [refusal, setRefusal] = useState<string | null>(null);

  const ready = document_?.registration === "ready";

  // Read the stored overview when the panel first has a document to read it for.
  // A read, never a generation — the difference is the whole product rule.
  useEffect(() => {
    if (ready && documentId !== null && overviewFor !== documentId) {
      void loadOverview();
    }
  }, [ready, documentId, overviewFor]);

  /* Elapsed seconds while generating, because the backend takes tens of seconds
     on a real paper and an indeterminate spinner with no number is
     indistinguishable from one that has hung. This counts real time; it does not
     estimate a percentage, which would be a number nothing measured. */
  useEffect(() => {
    if (status !== "generating" || startedAt === null) return;
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [status, startedAt]);

  const abstract = useMemo(() => {
    if (!ir) return null;
    const parts = ir.paragraphs.filter((paragraph) => paragraph.is_abstract);
    if (parts.length === 0) return null;
    return parts.map((paragraph) => paragraph.text).join("\n\n");
  }, [ir]);

  const target = useMemo(() => firstReadingTarget(sections ?? []), [sections]);

  /* A stored overview is shown only when it describes *this* paper. The backend
     already refuses one from a previous extraction when it answers; this is the
     belt to that pair of braces, because the artifact and the document arrive
     from two different requests and nothing guarantees they arrived together. */
  const usable =
    overview !== null &&
    overviewFor === documentId &&
    ir !== null &&
    overviewIsCurrent(overview, ir.content_hash);

  if (!ready) {
    return (
      <p data-testid="overview-empty-state" className="px-3 py-6 text-xs text-muted-foreground">
        请先打开一篇论文。
      </p>
    );
  }

  const sectionCount = (sections ?? []).filter((s) => s.level === 1 || s.level === null).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden" data-testid="overview-panel">
      {/* ---- Layer A: available on the first paint, from data already held ---- */}
      <section className="border-b px-2 py-2" data-testid="overview-entry">
        <h2 data-testid="overview-title" className="text-xs font-medium leading-snug text-foreground">
          {ir?.metadata?.title ?? document_?.name ?? "未命名论文"}
        </h2>
        <p className="mt-0.5 text-2xs text-muted-foreground" data-testid="overview-metrics">
          {ir ? `${ir.page_count} 页` : ""}
          {sectionCount > 0 ? ` · ${sectionCount} 个一级章节` : ""}
        </p>

        {target.section !== null && (
          <button
            type="button"
            data-testid="overview-start-reading"
            onClick={() => jumpToSection(target.section!)}
            className="mt-2 flex w-full items-center gap-1 rounded-sm border px-2 py-1 text-left text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <MapPin className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{target.reason}</span>
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        )}

        <div className="mt-2">
          <p className="text-2xs font-medium text-muted-foreground">摘要</p>
          {ir === null ? (
            /* The paper has not been read yet, and that is a different statement
               from "it has no abstract". Claiming the second while the first is
               true is the panel asserting something about a document it has not
               looked at. */
            <p data-testid="overview-no-ir" className="mt-1 text-2xs text-muted-foreground">
              正在读取论文结构…
            </p>
          ) : abstract !== null ? (
            <p
              data-testid="overview-abstract"
              className="mt-1 whitespace-pre-wrap text-2xs leading-relaxed text-foreground/90"
            >
              {abstract}
            </p>
          ) : (
            /* Said, not fabricated. A paper without an abstract is a real thing —
               a legal brief, a specification — and inventing one from the
               introduction would be the panel's first claim and its first lie. */
            <p data-testid="overview-no-abstract" className="mt-1 text-2xs text-muted-foreground">
              本文档未检测到独立摘要。
            </p>
          )}
        </div>
      </section>

      {/* ---- Layer B: read from the backend, never generated from here ---- */}
      <section className="px-2 py-2" data-testid="overview-analysis">
        <div className="flex items-center gap-1">
          <Sparkles className="h-3 w-3 text-primary" aria-hidden="true" />
          <p className="text-2xs font-medium text-muted-foreground">AI 论文概览</p>
        </div>

        {status === "generating" ? (
          <div data-testid="overview-progress" className="mt-2 flex items-center gap-2 text-2xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            <span>正在分析论文（已用时 {elapsed} 秒）…</span>
          </div>
        ) : usable ? (
          <Suspense fallback={<PanelLoading />}>
            <GeneratedOverview
              overview={overview}
              expanded={expanded}
              onExpand={() => setExpanded(true)}
            />
          </Suspense>
        ) : (
          <div className="mt-2">
            <p data-testid="overview-not-generated" className="text-2xs text-muted-foreground">
              这篇论文还没有生成概览。
            </p>
            {(error !== null || refusal !== null || status === "failed") && (
              <p
                role="alert"
                data-testid="overview-error"
                className="mt-1 flex items-start gap-1 text-2xs text-amber-600 dark:text-amber-500"
              >
                <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
                {/* The reader's most recent action speaks last: a read that
                    failed when the panel opened is older news than the button
                    they just pressed. */}
                <span>{refusal ?? error ?? "概览生成失败，请稍后重试。"}</span>
              </p>
            )}
            <button
              type="button"
              data-testid="overview-generate"
              onClick={() => {
                setRefusal(null);
                void generateOverview().then((outcome) => {
                  if (!outcome.ok) setRefusal(outcome.reason);
                });
              }}
              className="mt-2 w-full rounded-sm border px-2 py-1 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              生成 AI 概览
            </button>
            {/* Stated before the reader presses it, not after. This is the only
                control in the application that spends their money. */}
            <p className="mt-1 text-2xs text-muted-foreground/80">
              将调用 1 次模型请求，可能耗时数十秒。
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
