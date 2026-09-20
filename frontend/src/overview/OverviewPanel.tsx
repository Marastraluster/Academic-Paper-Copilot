import { useEffect, useMemo, useState } from "react";
import { ChevronRight, Loader2, MapPin, Sparkles, TriangleAlert } from "lucide-react";

import type { GlossaryTerm } from "@/api/analysis";
import { jumpToSection } from "@/outline/navigate";
import { firstReadingTarget, isFrontMatter } from "@/overview/roadmap";
import { analysisIsCurrent, generateOverview, loadAnalysis } from "@/overview/session";
import { useWorkspaceStore } from "@/stores/workspace";
import { cn } from "@/lib/utils";

/**
 * Where to start reading, and what the model made of the paper.
 *
 * ## Two layers, and the first one never waits
 *
 * Everything above the analysis block comes from the `DocumentIR` the
 * application already holds when a paper finishes registering: the title, the
 * abstract, the section count, and the recommendation. It renders on the first
 * paint with no request and no spinner — which matters more here than anywhere
 * else, because 概览 is the tab a paper opens on.
 *
 * The analysis below it is read from the backend and **never generated from
 * here**. When there is none the panel says so and offers a button; pressing it
 * is the only path in the application that can reach a provider.
 *
 * ## What this deliberately does not do
 *
 * It does not summarise. Measured against the real analysis, the pieces the task
 * asks for are already there — a document summary, per-section summaries with
 * page ranges, and a glossary — and a second summariser on top of them would be
 * a second answer to a settled question, produced by a prompt nothing has
 * measured. What this does is arrange them, bound them, and say where each came
 * from.
 */
export function OverviewPanel() {
  const document_ = useWorkspaceStore((s) => s.document);
  const ir = useWorkspaceStore((s) => s.ir);
  const sections = useWorkspaceStore((s) => s.sections);
  const analysis = useWorkspaceStore((s) => s.analysis);
  const analysisFor = useWorkspaceStore((s) => s.analysisFor);
  const status = useWorkspaceStore((s) => s.analysisStatus);
  const error = useWorkspaceStore((s) => s.analysisError);
  const startedAt = useWorkspaceStore((s) => s.analysisStartedAt);
  const documentId = document_?.documentId ?? null;
  const [expanded, setExpanded] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  // A refusal that never reached the store — no document, no configured
  // provider — still has to be said out loud rather than leaving the button
  // looking like it did nothing.
  const [refusal, setRefusal] = useState<string | null>(null);

  const ready = document_?.registration === "ready";

  // Read the stored analysis when the panel first has a document to read it for.
  // A read, never a generation — the difference is the whole product rule.
  useEffect(() => {
    if (ready && documentId !== null && analysisFor !== documentId) {
      void loadAnalysis();
    }
  }, [ready, documentId, analysisFor]);

  /* Elapsed seconds while generating, because the backend takes minutes on a
     real paper and an indeterminate spinner with no number is indistinguishable
     from one that has hung. This counts real time; it does not estimate a
     percentage, which would be a number nothing measured. */
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

  const target = useMemo(
    () => firstReadingTarget(sections ?? []),
    [sections],
  );

  /* A stored analysis is shown only when it describes *this* paper at *this*
     extraction. Measured on a real change: one layout constant renumbered 145 of
     160 paragraphs, so summaries and term references from a previous extraction
     point at text that has moved. Saying "not generated yet" and offering the
     button is honest; showing the old one would be a confident answer about a
     document that no longer exists. */
  const usable =
    analysis !== null &&
    analysisFor === documentId &&
    ir !== null &&
    analysisIsCurrent(analysis, ir.content_hash, ir.pipeline_version ?? "");

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
        <h2
          data-testid="overview-title"
          className="text-xs font-medium leading-snug text-foreground"
        >
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
            /* **Not** "this document has no abstract." Before the extraction
               arrives nothing is known about the document, and a reader told
               their paper has no abstract — by a panel that simply had not read
               it yet — has been given a confident false statement about their
               paper. That is the one failure this repository treats as worse
               than saying nothing. */
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
            <span>正在分析章节内容（已用时 {elapsed} 秒，通常需要 30–90 秒）…</span>
          </div>
        ) : usable ? (
          <AnalysisBody
            analysis={analysis}
            expanded={expanded}
            onExpand={() => setExpanded(true)}
          />
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
                {/* The reader's most recent action speaks last. A read that
                    failed when the panel opened is older news than the button
                    they just pressed, and showing the older one is how a reader
                    concludes their press did nothing. */}
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
                control in the application that spends their money, and the
                backend answers it with several provider calls over the whole
                paper. */}
            <p className="mt-1 text-2xs text-muted-foreground/80">
              将调用 1 次以上模型请求并读取全文，可能耗时数十秒。
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

const INITIAL_TERMS = 8;

function AnalysisBody({
  analysis,
  expanded,
  onExpand,
}: {
  analysis: import("@/api/analysis").AnalysisView;
  expanded: boolean;
  onExpand: () => void;
}) {
  const sections = analysis.sections;
  const terms = analysis.glossary;
  const shownTerms = expanded ? terms : terms.slice(0, INITIAL_TERMS);

  return (
    <div className="mt-2" data-testid="overview-body">
      {analysis.status === "PARTIAL" && (
        <p
          data-testid="overview-partial"
          className="mb-2 rounded-sm bg-amber-100 px-2 py-1 text-2xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
        >
          部分章节分析已就绪。
        </p>
      )}

      {analysis.summary && (
        <div data-testid="overview-summary" className="mb-3">
          <p className="text-2xs leading-relaxed text-foreground/90">{analysis.summary}</p>
          {/* The whole-paper summary is synthesised from the section summaries and
              has no per-claim anchor — a section does. Saying which is which is
              the difference between a reader trusting it appropriately and
              trusting it the same as a page-numbered claim. */}
          <p className="mt-1 text-2xs text-muted-foreground/80">基于全文各章节综合分析生成。</p>
        </div>
      )}

      {sections.length > 0 && (
        <div data-testid="overview-sections" className="mb-3">
          <p className="mb-1 text-2xs font-medium text-muted-foreground">章节概览</p>
          <ul className="space-y-1">
            {sections.map((section) => (
              <li key={section.section_id} data-testid={`overview-section-${section.section_id}`}>
                <div className="flex items-baseline gap-1">
                  <span className="min-w-0 flex-1 truncate text-2xs font-medium">{section.title}</span>
                  {section.synthetic && (
                    <span
                      data-testid={`overview-synthetic-${section.section_id}`}
                      className="shrink-0 rounded-sm bg-muted px-1 text-2xs text-muted-foreground"
                    >
                      自动分块
                    </span>
                  )}
                  <a
                    data-testid={`overview-jump-${section.section_id}`}
                    href={`#page-${section.page_range[0]}`}
                    onClick={(event) => {
                      event.preventDefault();
                      useWorkspaceStore.getState().requestJump(
                        section.page_range[0], [], undefined,
                      );
                    }}
                    className="shrink-0 text-2xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    p. {section.page_range[0]}
                    {section.page_range[1] > section.page_range[0]
                      ? `–${section.page_range[1]}`
                      : ""}
                  </a>
                </div>
                <p className="text-2xs leading-relaxed text-muted-foreground">{section.summary}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {terms.length > 0 && (
        <div data-testid="overview-terms">
          <p className="mb-1 text-2xs font-medium text-muted-foreground">关键术语</p>
          <ul className="space-y-0.5">
            {shownTerms.map((term) => (
              <TermRow key={term.source_term} term={term} />
            ))}
          </ul>
          {!expanded && terms.length > INITIAL_TERMS && (
            <button
              type="button"
              data-testid="overview-terms-expand"
              onClick={onExpand}
              className={cn(
                "mt-1 text-2xs text-primary hover:underline",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
              )}
            >
              展开全部 {terms.length} 个术语
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TermRow({ term }: { term: GlossaryTerm }) {
  return (
    <li data-testid={`overview-term-${term.source_term}`} className="text-2xs">
      {/* The source spelling exactly as the paper writes it, beside what the
          analysis proposed for it. Measured: the glossary holds 207 entries for
          ResNet and case-folding `ResNet-50` is the one thing that would make
          them useless. */}
      <span className="font-medium">{term.source_term}</span>
      {term.suggested_translation && (
        <span className="text-muted-foreground"> · {term.suggested_translation}</span>
      )}
    </li>
  );
}

export { isFrontMatter };
