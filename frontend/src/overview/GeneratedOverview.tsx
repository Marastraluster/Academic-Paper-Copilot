import type {
  OverviewCategory,
  OverviewEvidence,
  OverviewItemView,
  OverviewTermView,
  OverviewView,
} from "@/api/overview";
import { useWorkspaceStore } from "@/stores/workspace";
import { cn } from "@/lib/utils";

/**
 * The generated half of the overview: what a model said, and where it says so.
 *
 * Split from the panel it renders inside, and the boundary is deliberate rather
 * than a size trick. The **deterministic reading entry** — title, abstract,
 * structure, where to start — is what a reader gets on the first paint of the tab
 * a paper opens on, so it must never sit behind a dynamic import. This half only
 * exists once an overview does: a reader sees it from cache or after asking for
 * one, and either way they are already looking at the panel.
 *
 * The one cost is a brief gap between the cache answering and this rendering.
 * That is acceptable where a spinner in front of the *entry* would not be.
 */
/**
 * Jump the reader to the paragraphs an item's evidence came from.
 *
 * The same jump the citation and section paths use, and deliberately the same
 * shape: the page comes from the artifact, the rectangles come from the IR the
 * client already holds, and the offset lifts the box off the top edge so an
 * evidence link does not land with its source just under the fold.
 *
 * The geometry is resolved **here** rather than carried in the artifact. The
 * model was shown numbered excerpts and never a coordinate, so a rectangle in an
 * overview would be a rectangle nobody measured; this one is the reader's own
 * extraction of the paragraph the backend validated the citation against. When
 * the id does not resolve — an overview whose IR has moved on — the jump still
 * goes to the page rather than nowhere.
 */
function jumpToEvidence(paragraphIds: string[], pageNumber: number): void {
  const ir = useWorkspaceStore.getState().ir;
  const boxes = paragraphIds.flatMap(
    (id) => ir?.paragraphs.find((paragraph) => paragraph.id === id)?.bboxes ?? [],
  );
  useWorkspaceStore.getState().requestJump(pageNumber, boxes, boxes[0]?.[1]);
}

function EvidencePages({ evidence }: { evidence: OverviewEvidence[] }) {
  // One badge per page: two excerpts from the same page are one place to go, and
  // the box is drawn for whichever of them the reader already has.
  const pages = [...new Set(evidence.map((ref) => ref.page_number))];
  return (
    <span className="ml-1 inline-flex shrink-0 gap-0.5">
      {pages.map((page) => (
        <button
          key={page}
          type="button"
          data-testid={`overview-evidence-p${page}`}
          onClick={() =>
            jumpToEvidence(
              evidence
                .filter((ref) => ref.page_number === page)
                .map((ref) => ref.paragraph_id),
              page,
            )
          }
          className="rounded-sm px-1 text-2xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          p.{page}
        </button>
      ))}
    </span>
  );
}

/** The categories, with the heading a reader sees, and the order they appear in. */
const CATEGORY_LABEL: Record<OverviewCategory, string> = {
  research_question: "研究问题",
  core_idea: "核心思路",
  contributions: "主要贡献",
  method: "方法",
  experiments: "实验",
  findings: "发现",
  limitations: "局限",
};

const CATEGORY_ORDER: OverviewCategory[] = [
  "research_question", "core_idea", "contributions",
  "method", "experiments", "findings", "limitations",
];

const INITIAL_TERMS = 12;

/** A heading that says the paper set its limitations apart. */
const LIMITATIONS_HEADING = /limitation|局限|限制|不足/i;

/**
 * What the run cost, in the provider's own numbers.
 *
 * Reported or unavailable, and never a third thing: a character count presented
 * beside a real measurement reads exactly like one, and the reader has no way to
 * tell which they are looking at.
 */
function usageLabel(overview: OverviewView): string {
  if (overview.input_tokens === null || overview.output_tokens === null) {
    return "Token 统计不可用";
  }
  return `Token 输入 ${overview.input_tokens} · 输出 ${overview.output_tokens}`;
}

function GeneratedOverviewBody({
  overview,
  expanded,
  onExpand,
}: {
  overview: OverviewView;
  expanded: boolean;
  onExpand: () => void;
}) {
  const terms = overview.key_terms;
  const shownTerms = expanded ? terms : terms.slice(0, INITIAL_TERMS);

  /* Whether the paper states limitations at all, and whether anyone can claim
     it. A paper that states none has none to report, and saying so is the
     difference between an honest omission and a panel that looks like it forgot.
     But the claim is about the *paper*, so it is only made when the extraction
     found no limitations-like section — and only for a complete run, because a
     category can also go missing by being dropped, which says nothing about the
     paper. */
  const statesLimitations =
    overview.items.some((item) => item.category === "limitations") ||
    overview.source_sections.some((title) => LIMITATIONS_HEADING.test(title));

  return (
    <div className="mt-2" data-testid="overview-body">
      {overview.status === "PARTIAL" && (
        <p
          data-testid="overview-partial"
          className="mb-2 rounded-sm bg-amber-100 px-2 py-1 text-2xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
        >
          部分概览已生成。
        </p>
      )}

      {CATEGORY_ORDER.map((category) => {
        const items = overview.items.filter((item) => item.category === category);
        if (items.length === 0) return null;
        return (
          <div key={category} data-testid={`overview-${category}`} className="mb-2.5">
            <p className="mb-0.5 text-2xs font-medium text-muted-foreground">
              {CATEGORY_LABEL[category]}
            </p>
            <ul className="space-y-1">
              {items.map((item, index) => (
                <ItemRow key={index} item={item} category={category} index={index} />
              ))}
            </ul>
          </div>
        );
      })}

      {overview.status === "READY" && !statesLimitations && (
        <p
          data-testid="overview-no-limitations"
          className="mb-2.5 text-2xs text-muted-foreground"
        >
          原论文未设独立局限性章节。
        </p>
      )}

      {terms.length > 0 && (
        <div data-testid="overview-key-terms">
          <p className="mb-1 text-2xs font-medium text-muted-foreground">关键术语</p>
          <ul className="space-y-1">
            {shownTerms.map((term) => (
              <TermRow key={term.term} term={term} />
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

      {/* Whose reading this is. A stored overview survives a model change — the
          paper has not changed — so the reader is told which model produced the
          one they are looking at rather than left to assume it is the one
          currently configured. */}
      {overview.provider_model && (
        <p className="mt-2 text-2xs text-muted-foreground/70" data-testid="overview-provenance">
          由 {overview.provider_model} 生成
          {overview.cached ? "（已缓存）" : ""}
          {" · "}
          <span data-testid="overview-usage">{usageLabel(overview)}</span>
        </p>
      )}
    </div>
  );
}

function ItemRow({
  item,
  category,
  index,
}: {
  item: OverviewItemView;
  category: OverviewCategory;
  index: number;
}) {
  return (
    <li data-testid={`overview-item-${category}-${index}`} className="text-2xs leading-relaxed">
      <span className="text-foreground/90">{item.text}</span>
      {/* Said, not implied. A claim the authors stated and a claim the model
          organised out of their material are different things, and a reader
          checking the paper should know which one they are reading. */}
      {item.inferred && (
        <span
          data-testid={`overview-inferred-${category}-${index}`}
          className="ml-1 text-muted-foreground/70"
        >
          （归纳）
        </span>
      )}
      {/* AC-P0-42: a claim only part of whose evidence supports it. Distinct from
          the annotation-level PARTIAL badge, which says the *overview* is
          incomplete rather than that this particular sentence is. */}
      {item.partial && (
        <span
          data-testid="claim-caveat-pill"
          className="ml-1 rounded-sm bg-amber-100 px-1 text-2xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
        >
          部分证据支持
        </span>
      )}
      <EvidencePages evidence={item.evidence} />
    </li>
  );
}

function TermRow({ term }: { term: OverviewTermView }) {
  return (
    <li data-testid={`overview-term-${term.term}`} className="text-2xs leading-relaxed">
      {/* The source spelling exactly as the paper writes it. Measured: the
          generated terms include `ResNet-50`, `BN`, `FLOPs`, and case-folding
          them is the one thing that would make the list useless. */}
      <span className="font-medium">{term.term}</span>
      <span className="text-muted-foreground"> — {term.definition}</span>
      <EvidencePages evidence={term.evidence} />
    </li>
  );
}

export { GeneratedOverviewBody as GeneratedOverview };
