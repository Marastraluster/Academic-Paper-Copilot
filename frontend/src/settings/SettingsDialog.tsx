/**
 * The model service this application talks to, and how to change it.
 *
 * Until this dialog existed the answer was "you cannot": the 设置 button has been
 * in the tab order since DS-FE-001 without ever opening anything, so a reader who
 * wanted to point the application at their own endpoint had to edit the database.
 *
 * ## Where a profile actually lives
 *
 * Not in a configuration file, and that is deliberate. The profile — name,
 * endpoint, model, protocol, timeout — is a row in SQLite. The **API key is not
 * written to the database at all**: it goes to the operating system's credential
 * store, and the client is only ever told whether one is set and a masked
 * rendering of it. A plaintext config file would leak keys into backups, git
 * trees and sync folders, which is the whole reason the split exists.
 *
 * ## Three things this screen must never do
 *
 * **Never hold a key it was not just given.** The key input starts empty even
 * when a key is stored, and saving without typing one omits the field entirely —
 * which the backend reads as "leave the stored key alone". Sending an empty
 * string instead would silently destroy a credential the reader never touched,
 * and sending `null` is rejected outright for exactly that ambiguity.
 *
 * **Never probe on its own.** Asking an endpoint whether it answers spends a
 * request, so it happens on a click and nowhere else: not on open, not on
 * selection, not on edit.
 *
 * **Never require a key.** A local OpenAI-compatible server with no
 * authentication is a supported configuration (DS-BE-007), so an empty key is a
 * valid profile rather than a validation error.
 *
 * The whole module is behind a dynamic import in `TopBar` — there are 1.11 kB of
 * bundle headroom, and a settings screen nobody has opened should not be in the
 * first download.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { KeyRound, Loader2, Pencil, Plus, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  createProfile,
  deleteProfile,
  listProfiles,
  testProfile,
  updateProfile,
  type ProfileTestResult,
  type ProviderProfile,
} from "@/api/profiles";
import { useWorkspaceStore } from "@/stores/workspace";
import { describeApiError } from "@/translation/errors";

/** What a probe failure means to a reader, by the code the backend mapped it to. */
const PROBE_MESSAGE: Record<string, string> = {
  PROVIDER_AUTH_FAILED: "认证失败：API Key 无效或无访问权限。",
  PROVIDER_RATE_LIMITED: "请求受限：已超出服务商的速率限制，请稍后再试。",
  PROVIDER_MODEL_NOT_FOUND: "模型未找到：请检查模型名称是否正确。",
  PROVIDER_TIMEOUT: "连接超时：端点未在指定时间内响应。",
  PROVIDER_UNREACHABLE: "服务不可达：无法连接到该地址，请检查地址与网络。",
  PROVIDER_OUTPUT_TRUNCATED: "端点应答了，但一次请求的预算太小，未能读完。",
  PROVIDER_ERROR: "服务商返回了一个错误。",
};

const PROTOCOLS = [
  { value: "auto", label: "自动检测" },
  { value: "chat_completions", label: "Chat Completions" },
  { value: "responses", label: "Responses" },
];

interface Draft {
  name: string;
  base_url: string;
  model: string;
  protocol: string;
  timeout_s: string;
  api_key: string;
}

const EMPTY_DRAFT: Draft = {
  name: "", base_url: "", model: "", protocol: "auto", timeout_s: "60", api_key: "",
};

function draftFrom(profile: ProviderProfile): Draft {
  return {
    name: profile.name,
    base_url: profile.base_url,
    model: profile.model,
    protocol: profile.protocol || "auto",
    timeout_s: String((profile as { timeout_s?: number }).timeout_s ?? 60),
    // Empty on purpose: the stored key is not ours to show, and an empty field
    // is what makes "leave it alone" the default.
    api_key: "",
  };
}

/** The first thing wrong with what was typed, or null. */
function validate(draft: Draft): string | null {
  if (draft.name.trim() === "") return "请填写配置名称。";
  if (draft.base_url.trim() === "") return "请填写服务地址。";
  if (!/^https?:\/\/.+/i.test(draft.base_url.trim())) {
    return "服务地址必须以 http:// 或 https:// 开头。";
  }
  if (draft.model.trim() === "") return "请填写模型名称。";
  const timeout = Number(draft.timeout_s);
  if (draft.timeout_s.trim() === "" || !Number.isFinite(timeout) || timeout <= 0) {
    return "超时时间必须是大于 0 的秒数。";
  }
  return null;
}

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const [profiles, setProfiles] = useState<ProviderProfile[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<Element | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const loaded = await listProfiles(signal);
      setProfiles(loaded);
      setListError(null);
      return loaded;
    } catch (caught) {
      if ((caught as { name?: string })?.name === "AbortError") return null;
      setProfiles([]);
      setListError(describeApiError(caught).detail);
      return null;
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setProfiles(null);
    setSelectedId(null);
    setAdding(false);
    setConfirming(null);
    void load(controller.signal);
    return () => controller.abort();
  }, [open, load]);

  // Escape closes; Tab cycles inside; focus returns to whatever opened this.
  // The same contract `TranslateDialog` keeps, because two dialogs in one shell
  // that behaved differently would be a bug in one of them.
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
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const previous = restoreFocusRef.current;
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [open, onClose]);

  const selected = useMemo(
    () => profiles?.find((profile) => profile.id === selectedId) ?? null,
    [profiles, selectedId],
  );

  const remove = useCallback(async (profileId: string) => {
    try {
      await deleteProfile(profileId);
      setConfirming(null);
      if (selectedId === profileId) setSelectedId(null);
      // The application holds its own selection — the one a question or an
      // overview generation will use. Left pointing at a deleted profile it
      // would fail later, at the moment the reader asked for something, with an
      // error about a profile they already removed.
      const store = useWorkspaceStore.getState();
      if (store.profileId === profileId) store.setProfileId("");
      await load();
    } catch (caught) {
      setListError(describeApiError(caught).detail);
    }
  }, [load, selectedId]);

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
        aria-labelledby="settings-dialog-title"
        data-testid="settings-dialog"
        className="flex max-h-[85vh] w-full max-w-2xl flex-col gap-3 rounded-lg border bg-card p-4 shadow-lg"
      >
        <h2 id="settings-dialog-title" className="flex items-center gap-1.5 text-sm font-semibold">
          <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
          设置 · 模型服务
        </h2>

        <div className="flex min-h-0 flex-1 gap-3">
          {/* ---- the list ---- */}
          <div className="flex w-56 shrink-0 flex-col gap-1 border-r pr-3">
            <div className="flex items-center justify-between">
              <p className="text-2xs font-medium text-muted-foreground">已配置的服务</p>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="新建配置"
                data-testid="settings-new"
                onClick={() => {
                  setAdding(true);
                  setSelectedId(null);
                }}
              >
                <Plus />
              </Button>
            </div>

            {profiles === null ? (
              <p data-testid="settings-loading" className="px-1 py-2 text-2xs text-muted-foreground">
                正在载入…
              </p>
            ) : profiles.length === 0 ? (
              <p data-testid="settings-empty" className="px-1 py-2 text-2xs text-muted-foreground">
                还没有配置任何模型服务。点击右上角「+」添加一个。
              </p>
            ) : (
              <ul data-testid="settings-profile-list" className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
                {profiles.map((profile) => (
                  <li key={profile.id}>
                    <button
                      type="button"
                      data-testid={`settings-profile-${profile.id}`}
                      aria-current={selectedId === profile.id}
                      onClick={() => {
                        setAdding(false);
                        setSelectedId(profile.id);
                      }}
                      className={cn(
                        "w-full rounded-sm px-2 py-1 text-left text-2xs",
                        selectedId === profile.id
                          ? "bg-primary/10 text-foreground"
                          : "text-muted-foreground hover:bg-accent/60",
                      )}
                    >
                      <span className="flex items-center gap-1">
                        <span className="min-w-0 flex-1 truncate font-medium">{profile.name}</span>
                        {/* What a reader needs to tell "the key I saved yesterday is
                            still there" from "there is no key". The mask is the
                            server's, and it is all the client is ever given. */}
                        {profile.has_key ? (
                          <span data-testid="settings-key-badge" className="shrink-0 text-2xs text-primary">
                            已保存凭据
                          </span>
                        ) : (
                          <span data-testid="settings-keyless-badge" className="shrink-0 text-2xs text-muted-foreground">
                            免密模式
                          </span>
                        )}
                      </span>
                      <span className="block truncate">{profile.base_url}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {listError !== null && (
              <p role="alert" data-testid="settings-list-error" className="text-2xs text-amber-600">
                {listError}
              </p>
            )}
          </div>

          {/* ---- the form ---- */}
          <div className="min-w-0 flex-1 overflow-y-auto">
            {adding ? (
              <ProfileForm
                key="new"
                profile={null}
                known={profiles ?? []}
                onCancel={() => setAdding(false)}
                onSaved={async (saved) => {
                  setAdding(false);
                  setSelectedId(saved.id);
                  await load();
                }}
              />
            ) : selected !== null ? (
              <div className="space-y-2">
                <ProfileForm
                  key={selected.id}
                  profile={selected}
                  known={profiles ?? []}
                  onCancel={() => setSelectedId(null)}
                  onSaved={async () => { await load(); }}
                />
                {confirming === selected.id ? (
                  <div
                    data-testid="settings-confirm-delete"
                    className="rounded-sm border border-destructive/40 bg-destructive/5 p-2"
                  >
                    <p className="text-2xs">
                      确定删除「{selected.name}」吗？删除后将同时清理系统密钥存储中的凭据。
                    </p>
                    <div className="mt-1.5 flex gap-1.5">
                      <Button size="sm" variant="destructive"
                        data-testid="settings-delete-confirm"
                        onClick={() => void remove(selected.id)}>
                        删除
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setConfirming(null)}>
                        取消
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    data-testid="settings-delete"
                    onClick={() => setConfirming(selected.id)}
                  >
                    <Trash2 />
                    删除配置
                  </Button>
                )}
              </div>
            ) : (
              <p data-testid="settings-no-selection" className="text-2xs text-muted-foreground">
                从左侧选择一个服务进行编辑，或新建一个。
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One profile, being created or edited.
 *
 * The key field is the delicate part. It starts empty, and what it means on
 * save depends on what the reader did — see the three intents in the module
 * docstring. A stored key is shown as the server's mask and nothing else.
 */
function ProfileForm({
  profile, known, onSaved, onCancel,
}: {
  profile: ProviderProfile | null;
  known: ProviderProfile[];
  onSaved: (saved: ProviderProfile) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(profile ? draftFrom(profile) : EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [clearKey, setClearKey] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null);

  const editing = profile !== null;
  const field = (key: keyof Draft) => ({
    value: draft[key],
    onChange: (event: { target: { value: string } }) => {
      setDraft((current) => ({ ...current, [key]: event.target.value }));
      setError(null);
      setNameError(null);
    },
  });

  const save = useCallback(async () => {
    const invalid = validate(draft);
    if (invalid !== null) {
      setError(invalid);
      return;
    }
    // Checked here as well as on the server, which is the authority: the reader
    // learns about a clash without a round trip, and the backend still refuses
    // one that races in from somewhere else.
    const name = draft.name.trim();
    const clash = known.some(
      (other) => other.id !== profile?.id && other.name.toLowerCase() === name.toLowerCase(),
    );
    if (clash) {
      setNameError("该配置名称已存在，请使用其他名称。");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const payload = {
        name,
        base_url: draft.base_url.trim(),
        model: draft.model.trim(),
        protocol: draft.protocol,
        timeout_s: Number(draft.timeout_s),
      };
      const saved = editing
        ? await updateProfile(profile.id, {
            ...payload,
            // Absent when untouched (leave the key alone), "" when the reader
            // asked for it to be cleared, a value when they typed one. Never
            // null: the backend rejects that reading.
            ...(draft.api_key !== "" ? { api_key: draft.api_key } : clearKey ? { api_key: "" } : {}),
          })
        : await createProfile({
            ...payload,
            ...(draft.api_key !== "" ? { api_key: draft.api_key } : {}),
          });
      setDraft((current) => ({ ...current, api_key: "" }));
      setClearKey(false);
      await onSaved(saved);
    } catch (caught) {
      const described = describeApiError(caught);
      const status = (caught as { status?: number })?.status;
      const message = (caught as { message?: string })?.message ?? "";
      if (status === 400 && /already exists/i.test(message)) {
        setNameError("该配置名称已存在，请使用其他名称。");
      } else if (status === 503) {
        setError("系统凭据存储不可用，密钥无法保存。请检查系统的凭据服务后再试。");
      } else {
        setError(described.detail || described.title);
      }
    } finally {
      setSaving(false);
    }
  }, [clearKey, draft, editing, known, onSaved, profile?.id]);

  /* The one place a request is spent. Nothing above this line calls it, and
     nothing else may: a probe on open or on edit would spend the reader's quota
     for a question they did not ask. */
  const probeNow = useCallback(async () => {
    if (!editing) return;
    setProbing(true);
    setProbe(null);
    try {
      const result: ProfileTestResult = await testProfile(profile.id);
      setProbe({
        ok: true,
        text: `连接成功 · ${result.protocol}${result.model ? ` · ${result.model}` : ""}` +
          (result.latency_ms !== null ? ` · ${Math.round(result.latency_ms)} ms` : ""),
      });
    } catch (caught) {
      const code = (caught as { code?: string })?.code ?? "";
      setProbe({ ok: false, text: PROBE_MESSAGE[code] ?? describeApiError(caught).detail });
    } finally {
      setProbing(false);
    }
  }, [editing, profile]);

  return (
    <div data-testid="settings-form" className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="text-2xs text-muted-foreground">
          名称
          <input data-testid="settings-name" {...field("name")}
            className="mt-0.5 w-full rounded-sm border bg-background px-1.5 py-1 text-xs text-foreground" />
        </label>
        <label className="text-2xs text-muted-foreground">
          模型
          <input data-testid="settings-model" {...field("model")}
            className="mt-0.5 w-full rounded-sm border bg-background px-1.5 py-1 text-xs text-foreground" />
        </label>
      </div>

      <label className="block text-2xs text-muted-foreground">
        服务地址（endpoint）
        <input data-testid="settings-base-url" {...field("base_url")} placeholder="https://api.example.com/v1"
          className="mt-0.5 w-full rounded-sm border bg-background px-1.5 py-1 text-xs text-foreground" />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="text-2xs text-muted-foreground">
          协议
          <select data-testid="settings-protocol" {...field("protocol")}
            className="mt-0.5 w-full rounded-sm border bg-background px-1.5 py-1 text-xs text-foreground">
            {PROTOCOLS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="text-2xs text-muted-foreground">
          超时（秒）
          <input data-testid="settings-timeout" {...field("timeout_s")}
            className="mt-0.5 w-full rounded-sm border bg-background px-1.5 py-1 text-xs text-foreground" />
        </label>
      </div>

      <label className="block text-2xs text-muted-foreground">
        API Key
        <span className="ml-1 text-muted-foreground/70">
          {editing && profile.has_key
            ? `（已保存：${profile.api_key_masked}，留空则保留）`
            : "（可留空：本地服务通常不需要）"}
        </span>
        <input data-testid="settings-api-key" type="password" autoComplete="off" {...field("api_key")}
          className="mt-0.5 w-full rounded-sm border bg-background px-1.5 py-1 text-xs text-foreground" />
      </label>

      {editing && profile.has_key && (
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" data-testid="settings-clear-key"
            onClick={() => { setClearKey(true); setDraft((c) => ({ ...c, api_key: "" })); }}>
            <KeyRound />
            清除密钥
          </Button>
          {clearKey && (
            <span data-testid="settings-clear-pending" className="text-2xs text-amber-600">
              保存后将清除已存储的密钥。
            </span>
          )}
        </div>
      )}

      {nameError !== null && (
        <p role="alert" data-testid="settings-name-error" className="text-2xs text-amber-600">
          {nameError}
        </p>
      )}
      {error !== null && (
        <p role="alert" data-testid="settings-error"
          className="flex items-start gap-1 text-2xs text-amber-600">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" data-testid="settings-save" disabled={saving} onClick={() => void save()}>
          {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          保存
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel}>取消</Button>
        {editing && (
          <Button size="sm" variant="outline" data-testid="settings-test"
            disabled={probing} onClick={() => void probeNow()}>
            {probing && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            测试连接
          </Button>
        )}
        {editing && <Pencil className="h-3 w-3 text-muted-foreground/50" aria-hidden="true" />}
      </div>

      {probe !== null && (
        <p data-testid="settings-probe-result"
          className={cn("text-2xs", probe.ok ? "text-emerald-600" : "text-amber-600")}>
          {probe.text}
        </p>
      )}
    </div>
  );
}

export default SettingsDialog;
