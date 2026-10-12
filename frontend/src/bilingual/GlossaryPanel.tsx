/**
 * 术语表 — the words this paper is translated with, and the reader's to correct.
 *
 * Made once, before the first batch, by the same model that translates; shown
 * here so a wrong choice can be fixed in one place rather than paragraph by
 * paragraph. Saving spends nothing. It tells the reader how many paragraphs
 * contain a term they changed, and only those are translated again.
 */
import { useCallback, useEffect, useState } from "react";
import { BookA, Loader2, Plus, RefreshCw, X } from "lucide-react";

import { extractGlossary, fetchGlossary, saveGlossary, type GlossaryTerm } from "@/api/bilingual";
import { Button } from "@/components/ui/button";
import { BILINGUAL_LANGUAGE, generateBilingual } from "@/bilingual/session";
import { profileIdFor } from "@/settings/taskModels";
import { useWorkspaceStore } from "@/stores/workspace";

type Load = "loading" | "ready" | "failed";

/**
 * Terms that were built on one the reader just changed.
 *
 * A paper's terms come in families — "shortcut connection", "identity shortcut",
 * "projection shortcut" — and their translations share a stem. Changing one and
 * leaving the others is how a paper ends up with two words for one thing again,
 * so the others are pointed out, with the same substitution offered for them.
 */
export function relatedEdits(
  saved: GlossaryTerm[],
  draft: GlossaryTerm[],
): Array<{ from: string; to: string; sources: string[] }> {
  const before = new Map(saved.map((term) => [term.source, term.target]));
  const out: Array<{ from: string; to: string; sources: string[] }> = [];
  for (const term of draft) {
    const from = before.get(term.source);
    const to = term.target.trim();
    if (from === undefined || to === "" || from === to || from.length < 2) continue;
    const sources = draft
      .filter(
        (other) =>
          other.source !== term.source &&
          other.target.includes(from) &&
          // Its own translation must not already be what the edit would make it.
          !other.target.includes(to) &&
          before.get(other.source) === other.target,
      )
      .map((other) => other.source);
    if (sources.length > 0) out.push({ from, to, sources });
  }
  return out;
}

function sameTerms(a: GlossaryTerm[], b: GlossaryTerm[]): boolean {
  return a.length === b.length && a.every((term, i) => term.source === b[i]!.source && term.target === b[i]!.target);
}

export function GlossaryPanel({
  documentId,
  disabled,
  refreshKey,
}: {
  documentId: string;
  /** A translation is running: the glossary it is using must not move under it. */
  disabled: boolean;
  /** Changes when a run finishes, so a glossary it just made is picked up. */
  refreshKey: string;
}) {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>("loading");
  const [saved, setSaved] = useState<GlossaryTerm[]>([]);
  const [draft, setDraft] = useState<GlossaryTerm[]>([]);
  const [busy, setBusy] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const profileId = useWorkspaceStore((state) => profileIdFor("translate", state));
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const read = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const found = await fetchGlossary(documentId, BILINGUAL_LANGUAGE, { signal });
        // An answer without a term list is not a glossary; the reading this
        // panel sits in must not fall over because of it.
        if (!Array.isArray(found?.terms)) {
          setLoad("failed");
          return;
        }
        setSaved(found.terms);
        setDraft(found.terms);
        setLoad("ready");
      } catch (error) {
        if ((error as { name?: string })?.name === "AbortError") return;
        setLoad("failed");
      }
    },
    [documentId],
  );

  useEffect(() => {
    const controller = new AbortController();
    void read(controller.signal);
    return () => controller.abort();
  }, [read, refreshKey]);

  // Rows left half-filled are not terms; they are dropped rather than refused.
  const cleaned = draft
    .map((term) => ({ source: term.source.trim(), target: term.target.trim() }))
    .filter((term) => term.source !== "" && term.target !== "");
  const dirty = !sameTerms(cleaned, saved);

  const edit = (index: number, field: keyof GlossaryTerm, value: string) => {
    setMessage(null);
    setDraft((rows) => rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  };

  const related = relatedEdits(saved, draft);

  const applyRelated = (edit: { from: string; to: string; sources: string[] }) => {
    setMessage(null);
    setDraft((rows) =>
      rows.map((row) =>
        edit.sources.includes(row.source) ? { ...row, target: row.target.split(edit.from).join(edit.to) } : row,
      ),
    );
  };

  /** One model call. The answer replaces the *draft*; nothing is saved until the reader saves. */
  const extractAgain = async () => {
    if (!profileId) {
      setMessage({ ok: false, text: "请先配置可用的模型服务。" });
      return;
    }
    setExtracting(true);
    setMessage(null);
    try {
      const terms = await extractGlossary(documentId, BILINGUAL_LANGUAGE, profileId);
      if (terms.length === 0) {
        setMessage({ ok: false, text: "模型没有返回可用的术语，术语表保持不变。" });
      } else {
        setDraft(terms);
        setMessage({ ok: true, text: `抽取到 ${terms.length} 个术语，检查后点「保存」才会生效。` });
      }
    } catch (error) {
      const status = (error as { status?: number })?.status;
      setMessage({
        ok: false,
        text: status === 409 ? "翻译正在进行，请等它结束后再抽取。" : "重新抽取失败，请检查模型服务后重试。",
      });
    } finally {
      setExtracting(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await saveGlossary(documentId, BILINGUAL_LANGUAGE, cleaned);
      setSaved(result.terms);
      setDraft(result.terms);
      if (result.affected_paragraphs > 0) {
        setMessage({ ok: true, text: `已保存，正在重译受影响的 ${result.affected_paragraphs} 段。` });
        void generateBilingual();
      } else {
        setMessage({ ok: true, text: "已保存。没有段落受影响，无需重译。" });
      }
    } catch (error) {
      const status = (error as { status?: number })?.status;
      setMessage({
        ok: false,
        text: status === 409 ? "翻译正在进行，请等它结束后再修改术语表。" : "术语表保存失败，请稍后重试。",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        data-testid="glossary-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1 rounded-sm px-1.5 text-2xs text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <BookA className="h-3 w-3" aria-hidden="true" />
        术语表{load === "ready" ? ` ${saved.length}` : ""}
      </button>

      {open && (
        <section
          data-testid="glossary-panel"
          aria-label="术语表"
          className="order-last w-full basis-full space-y-2 border-t pt-2"
        >
          <p className="text-2xs leading-relaxed text-muted-foreground">
            翻译时，每个术语在全文中统一使用这里的译法。修改后只重译包含该术语的段落。
          </p>

          {load === "loading" && <p className="text-2xs text-muted-foreground">正在读取…</p>}
          {load === "failed" && (
            <p role="alert" className="text-2xs text-warning">未能读取术语表。</p>
          )}
          {load === "ready" && draft.length === 0 && (
            <p data-testid="glossary-empty" className="text-2xs text-muted-foreground">
              这篇论文还没有术语表。生成逐段对照时会先自动整理一份，也可以在这里手动添加。
            </p>
          )}

          {load === "ready" && (
            <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">
              {draft.map((term, index) => (
                <li key={index} data-testid="glossary-row" className="flex items-center gap-1.5">
                  <input
                    aria-label={`术语 ${index + 1} 原文`}
                    value={term.source}
                    disabled={disabled || busy}
                    onChange={(event) => edit(index, "source", event.target.value)}
                    placeholder="原文术语"
                    className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs"
                  />
                  <span className="text-2xs text-muted-foreground" aria-hidden="true">→</span>
                  <input
                    aria-label={`术语 ${index + 1} 译文`}
                    value={term.target}
                    disabled={disabled || busy}
                    onChange={(event) => edit(index, "target", event.target.value)}
                    placeholder="译文"
                    className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs"
                  />
                  <button
                    type="button"
                    aria-label={`删除术语 ${term.source || index + 1}`}
                    disabled={disabled || busy}
                    onClick={() => {
                      setMessage(null);
                      setDraft((rows) => rows.filter((_, i) => i !== index));
                    }}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {load === "ready" &&
            related.map((edit) => (
              <p
                key={`${edit.from}→${edit.to}`}
                data-testid="glossary-related"
                className="flex flex-wrap items-center gap-1.5 rounded-md bg-primary/5 px-2 py-1.5 text-2xs leading-relaxed text-muted-foreground"
              >
                <span>
                  {edit.sources.map((source) => `「${source}」`).join("")}的译法里也含有「{edit.from}」。
                </span>
                <button
                  type="button"
                  data-testid="glossary-related-apply"
                  disabled={disabled || busy}
                  onClick={() => applyRelated(edit)}
                  className="rounded px-1.5 py-0.5 font-medium text-primary hover:bg-primary/10"
                >
                  一并改为「{edit.to}」
                </button>
              </p>
            ))}

          {load === "ready" && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                data-testid="glossary-add"
                disabled={disabled || busy}
                onClick={() => setDraft((rows) => [...rows, { source: "", target: "" }])}
              >
                <Plus className="h-3 w-3" aria-hidden="true" />
                添加术语
              </Button>
              <Button
                size="sm"
                variant="outline"
                data-testid="glossary-extract"
                title="让模型重读全文、重新整理术语表：1 次模型请求。结果先放进下面的列表，保存后才生效。"
                disabled={disabled || busy || extracting}
                onClick={() => void extractAgain()}
              >
                {extracting ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="h-3 w-3" aria-hidden="true" />
                )}
                重新抽取
              </Button>
              <Button
                size="sm"
                data-testid="glossary-save"
                disabled={disabled || busy || extracting || !dirty}
                onClick={() => void save()}
              >
                {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                保存
              </Button>
              {disabled && (
                <span className="text-2xs text-muted-foreground">翻译进行中，结束后可修改。</span>
              )}
              {message !== null && (
                <span
                  role={message.ok ? "status" : "alert"}
                  data-testid="glossary-message"
                  className={message.ok ? "text-2xs text-success" : "text-2xs text-warning"}
                >
                  {message.text}
                </span>
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}
