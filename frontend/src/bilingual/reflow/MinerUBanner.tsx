/**
 * The offer to re-parse the open paper with MinerU, while it is still on the
 * in-house extraction.
 *
 * Shown only when it can do something: a MinerU profile exists and the paper's
 * IR did not come from MinerU already. Without a profile it says where to set
 * one up, once, in a line — not a modal, not a nag.
 */
import { useEffect, useState } from "react";
import { FileScan, Loader2 } from "lucide-react";

import type { ParseState } from "@/api/parsing";
import { listProfilesOfKind, type ProviderProfile } from "@/api/profiles";
import { Button } from "@/components/ui/button";
import { describeParse, parseWithMinerU } from "@/parsing/session";
import { useWorkspaceStore } from "@/stores/workspace";

export function MinerUBanner() {
  const pipeline = useWorkspaceStore((state) => state.ir?.pipeline_version ?? "");
  const [parser, setParser] = useState<ProviderProfile | null | undefined>(undefined);
  const [state, setState] = useState<ParseState | null>(null);
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listProfilesOfKind("parser")
      .then((found) => {
        if (!cancelled) setParser(found[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setParser(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (pipeline.startsWith("mineru") || parser === undefined) return null;

  if (parser === null) {
    return (
      <p data-testid="mineru-hint" className="select-none text-2xs text-muted-foreground/80">
        在「设置 · 文档解析」中配置 MinerU，公式会按 LaTeX 排版、表格还原为表格。
      </p>
    );
  }

  return (
    <div
      data-testid="mineru-banner"
      className="flex flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
    >
      <FileScan className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        {running
          ? `${describeParse(state)}…`
          : problem ?? "用 MinerU 重新解析这篇论文：公式、表格和图片会更准确。解析后需要重新生成逐段对照。"}
      </span>
      <Button
        size="sm"
        variant="outline"
        className="w-fit select-none"
        data-testid="mineru-parse"
        disabled={running}
        onClick={() => {
          setRunning(true);
          setProblem(null);
          void parseWithMinerU(parser.id, setState).then((outcome) => {
            setRunning(false);
            if (!outcome.ok) setProblem(outcome.reason);
          });
        }}
      >
        {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
        用 MinerU 解析
      </Button>
    </div>
  );
}
