import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Sparkles, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { listProfiles, type ProviderProfile } from "@/api/profiles";
import { describeApiError } from "@/translation/errors";
import type { ContextMode, TranslateOptions } from "@/translation/session";

/**
 * The languages the translation engine actually accepts.
 *
 * This is upstream PDFMathTranslate's own list (`pdf2zh/gui.py`), not an
 * invention. It matters that the set is closed: the code is interpolated
 * verbatim into the model's prompt, so sending anything else asks the model to
 * "translate to <nonsense>" rather than failing cleanly. There is deliberately
 * no "auto" option — upstream has no detection to back one.
 */
export const LANGUAGES = [
  { code: "zh", label: "简体中文" },
  { code: "zh-TW", label: "繁體中文" },
  { code: "en", label: "English" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "fr", label: "Français" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "ru", label: "Русский" },
  { code: "it", label: "Italiano" },
] as const;

const DEFAULT_IN = "en";
const DEFAULT_OUT = "zh";

/** Only the in-process kernel exists; `precise` needs a second repository. */
const ENGINE_LABEL = "Fast（内置）";

/**
 * The three ways a translation can be produced.
 *
 * The descriptions are the point. "Contextual" is not labelled as better — it
 * costs roughly six times the prompt and needs the whole paper analysed first,
 * and a user who is not told that will read a several-minute wait as a hang.
 * Measured on a real paper: 6.6× tokens, 392 s of analysis, and no observed
 * improvement in how ambiguous terminology was rendered.
 */
const MODES: ReadonlyArray<{
  value: ContextMode;
  label: string;
  detail: string;
  experimental?: boolean;
}> = [
  {
    value: "basic",
    label: "快速",
    detail: "默认。上游翻译提示词，最省 token。",
  },
  {
    value: "academic",
    label: "学术",
    detail: "附加学术翻译要求：保留公式、引用与专有名称，不总结、不解释。token 约为“快速”的 2 倍。",
  },
  {
    value: "contextual",
    label: "上下文增强",
    detail: "附带全文摘要、章节摘要与相邻段落。需先分析全文（数分钟），token 约为“快速”的 6.6 倍。",
    experimental: true,
  },
];

interface TranslateDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (options: TranslateOptions) => void;
}

const FIELD =
  "h-8 w-full rounded-md border bg-background px-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background";

export function TranslateDialog({ open, onClose, onSubmit }: TranslateDialogProps) {
  const [profiles, setProfiles] = useState<ProviderProfile[] | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [profileId, setProfileId] = useState("");
  const [langIn, setLangIn] = useState<string>(DEFAULT_IN);
  const [langOut, setLangOut] = useState<string>(DEFAULT_OUT);
  // Basic by default, decided by measurement rather than by hope. DS-CTX-004 ran
  // the three arms over 15 units three times each: academic and basic were
  // indistinguishable on identifier and citation preservation (6 and 6), while
  // academic cost 2.07x the prompt. DS-CTX-003 had suggested the academic prompt
  // carried the gains; with repeats, that did not replicate.
  const [mode, setMode] = useState<ContextMode>("basic");

  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<Element | null>(null);

  // Load the provider list each time the dialog opens, so a profile created in
  // another window is not missing from the list.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setProfiles(null);
    setProfileError(null);

    void (async () => {
      try {
        const loaded = await listProfiles(controller.signal);
        if (controller.signal.aborted) return;
        setProfiles(loaded);
        setProfileId((current) => current || loaded[0]?.id || "");
      } catch (cause) {
        if (controller.signal.aborted) return;
        setProfiles([]);
        setProfileError(describeApiError(cause).detail);
      }
    })();

    return () => controller.abort();
  }, [open]);

  // Escape closes; focus moves into the dialog and returns whence it came.
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    panelRef.current
      ?.querySelector<HTMLElement>("select, button")
      ?.focus();

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const previous = restoreFocusRef.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [open, onClose]);

  const selected = useMemo(
    () => profiles?.find((profile) => profile.id === profileId) ?? null,
    [profiles, profileId],
  );

  const noProfiles = profiles !== null && profiles.length === 0;
  const submitting = profiles === null;
  const canSubmit = !submitting && !noProfiles && profileId !== "" && langIn !== langOut;

  const submit = useCallback(() => {
    if (!canSubmit) return;
    onSubmit({ profileId, langIn, langOut, engine: "fast", contextMode: mode });
  }, [canSubmit, onSubmit, profileId, langIn, langOut, mode]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="translate-dialog-title"
        data-testid="translate-dialog"
        className="w-full max-w-sm rounded-lg border bg-card p-4 shadow-lg"
      >
        <h2
          id="translate-dialog-title"
          className="flex items-center gap-1.5 text-sm font-semibold"
        >
          <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
          翻译 PDF
        </h2>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-2xs text-muted-foreground">源语言</span>
            <select
              className={FIELD}
              data-testid="translate-lang-in"
              aria-label="源语言"
              value={langIn}
              onChange={(event) => setLangIn(event.target.value)}
            >
              {LANGUAGES.map(({ code, label }) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-2xs text-muted-foreground">目标语言</span>
            <select
              className={FIELD}
              data-testid="translate-lang-out"
              aria-label="目标语言"
              value={langOut}
              onChange={(event) => setLangOut(event.target.value)}
            >
              {LANGUAGES.map(({ code, label }) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <fieldset className="mt-4">
          <legend className="mb-1.5 text-2xs text-muted-foreground">翻译模式</legend>
          <div className="flex flex-col gap-1">
            {MODES.map(({ value, label, detail, experimental }) => (
              <label
                key={value}
                className={cn(
                  "flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 transition-colors",
                  mode === value ? "border-primary/60 bg-accent/40" : "hover:bg-accent/20",
                )}
              >
                <input
                  type="radio"
                  name="context-mode"
                  className="mt-0.5"
                  value={value}
                  checked={mode === value}
                  data-testid={`translate-mode-${value}`}
                  onChange={() => setMode(value)}
                />
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-xs font-medium">
                    {label}
                    {experimental && (
                      <span className="rounded-sm bg-amber-500/15 px-1 py-px text-2xs font-normal text-amber-700">
                        实验性
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-2xs text-muted-foreground">
                    {detail}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <label className="mt-3 flex flex-col gap-1">
          <span className="text-2xs text-muted-foreground">Provider</span>
          <select
            className={FIELD}
            data-testid="translate-profile"
            aria-label="Provider 配置"
            disabled={submitting || noProfiles}
            value={profileId}
            onChange={(event) => setProfileId(event.target.value)}
          >
            {profiles?.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-2xs text-muted-foreground">模型</span>
            <p
              data-testid="translate-model"
              className="truncate rounded-md border border-dashed px-2 py-1.5 text-xs text-muted-foreground"
              title={selected?.model ?? ""}
            >
              {submitting ? "…" : (selected?.model ?? "—")}
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-2xs text-muted-foreground">引擎</span>
            <p className="rounded-md border border-dashed px-2 py-1.5 text-xs text-muted-foreground">
              {ENGINE_LABEL}
            </p>
          </div>
        </div>

        {noProfiles && (
          <p
            data-testid="translate-no-profiles"
            role="alert"
            className="mt-3 flex items-start gap-1.5 text-2xs text-destructive"
          >
            <TriangleAlert className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
            尚未配置任何 Provider。请先在设置中添加一个（本地模型可不填 API Key）。
          </p>
        )}

        {profileError && (
          <p
            data-testid="translate-profile-error"
            role="alert"
            className="mt-3 flex items-start gap-1.5 text-2xs text-destructive"
          >
            <TriangleAlert className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
            {profileError}
          </p>
        )}

        {langIn === langOut && (
          <p className="mt-3 text-2xs text-destructive">源语言与目标语言不能相同。</p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            size="sm"
            data-testid="translate-submit"
            disabled={!canSubmit}
            onClick={submit}
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            开始翻译
          </Button>
        </div>
      </div>
    </div>
  );
}
