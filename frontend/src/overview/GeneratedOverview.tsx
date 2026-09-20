import type {
  OverviewCategory,
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
/** Jump the reader to the page an item's evidence came from. */
function jumpToPage(pageNumber: number): void {
  // The same jump the citation and section paths use. An item's evidence is a
  // page the backend resolved, not a rectangle a model supplied — and drawing a
  // box would mean trusting provenance the provider was never given.
  useWorkspaceStore.getState().requestJump(pageNumber, [], undefined);
}

function EvidencePages({ pages }: { pages: number[] }) {
  const unique = [...new Set(pages)];
  return (
    <span className="ml-1 inline-flex shrink-0 gap-0.5">
      {unique.map((page) => (
        <button
          key={page}
          type="button"
          data-testid={`overview-evidence-p${page}`}
          onClick={() => jumpToPage(page)}
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

  return (
    <div className="mt-2" data-testid="overview-body">
      {overview.status === "PARTIAL" && (
        <p
          data-testid="overview-partial"
          className="mb-2 rounded-sm bg-amber-100 px-2 py-1 text-2xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
        >
          部分章节已就绪。
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
      <EvidencePages pages={item.evidence.map((ref) => ref.page_number)} />
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
      <EvidencePages pages={term.evidence.map((ref) => ref.page_number)} />
    </li>
  );
}

export { GeneratedOverviewBody as GeneratedOverview };
