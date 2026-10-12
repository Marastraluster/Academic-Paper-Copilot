/**
 * 设置 · 文档解析（MinerU）.
 *
 * One MinerU endpoint is all a reader needs, so this is a single form rather
 * than a list: where the server is, which tier to ask for, and a key when the
 * server wants one (mineru.net does; a local `mineru-api` does not). The key
 * follows the same rules as a model key — it goes to the OS credential store,
 * and the client only ever sees the server's mask.
 */
import { useCallback, useEffect, useState } from "react";
import { FileScan, Loader2 } from "lucide-react";

import {
  createProfile,
  listProfilesOfKind,
  testProfile,
  updateProfile,
  type ProviderProfile,
} from "@/api/profiles";
import { Button } from "@/components/ui/button";
import { describeApiError } from "@/translation/errors";

const TIERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "", label: "由服务决定" },
  { value: "flash", label: "flash · 最快，CPU 即可" },
  { value: "basic", label: "basic · CPU 推荐" },
  { value: "standard", label: "standard · 需要显卡" },
  { value: "advanced", label: "advanced · 最准，需要显卡" },
];

const DEFAULT_URL = "http://127.0.0.1:8100";

export function ParserSection() {
  const [profile, setProfile] = useState<ProviderProfile | null | undefined>(undefined);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_URL);
  const [tier, setTier] = useState("basic");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const found = (await listProfilesOfKind("parser"))[0] ?? null;
      setProfile(found);
      if (found !== null) {
        setBaseUrl(found.base_url);
        setTier(found.model);
      }
    } catch {
      setProfile(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy("save");
    setMessage(null);
    try {
      const draft = {
        base_url: baseUrl.trim(),
        model: tier,
        ...(apiKey !== "" ? { api_key: apiKey } : {}),
      };
      const saved =
        profile == null
          ? await createProfile({ name: "MinerU", kind: "parser", ...draft })
          : await updateProfile(profile.id, draft);
      setProfile(saved);
      setApiKey("");
      setMessage({ ok: true, text: "已保存。" });
    } catch (error) {
      setMessage({ ok: false, text: describeApiError(error).detail });
    } finally {
      setBusy(null);
    }
  };

  const probe = async () => {
    if (!profile) return;
    setBusy("test");
    setMessage(null);
    try {
      const result = await testProfile(profile.id);
      setMessage({
        ok: true,
        text: `连接成功 · ${result.model ?? "MinerU"}${result.latency_ms !== null ? ` · ${Math.round(result.latency_ms)} ms` : ""}`,
      });
    } catch (error) {
      setMessage({ ok: false, text: describeApiError(error).detail });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section data-testid="settings-parser" className="space-y-2 border-t pt-3">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold">
        <FileScan className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
        文档解析 · MinerU
      </h3>
      <p className="text-2xs leading-relaxed text-muted-foreground">
        用 MinerU 解析后，公式按 LaTeX 排版、表格还原为表格、图片单独显示。可以是本机运行的
        <code className="mx-0.5 rounded bg-muted px-1">mineru-api</code>、实验室服务器，或 mineru.net（需要 API Key，论文会上传到其服务器）。
      </p>
      <div className="grid gap-2 sm:grid-cols-[1fr_12rem]">
        <label className="text-2xs text-muted-foreground">
          服务地址
          <input
            data-testid="parser-base-url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={DEFAULT_URL}
            className="mt-0.5 h-7 w-full rounded-md border bg-background px-2 text-xs text-foreground"
          />
        </label>
        <label className="text-2xs text-muted-foreground">
          解析档位
          <select
            data-testid="parser-tier"
            value={tier}
            onChange={(event) => setTier(event.target.value)}
            className="mt-0.5 h-7 w-full rounded-md border bg-background px-1 text-xs text-foreground"
          >
            {TIERS.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block text-2xs text-muted-foreground">
        API Key（可选）
        <input
          data-testid="parser-api-key"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={profile?.has_key ? `已保存：${profile.api_key_masked}（留空则不修改）` : "本地服务通常不需要"}
          className="mt-0.5 h-7 w-full rounded-md border bg-background px-2 text-xs text-foreground"
        />
      </label>
      <div className="flex items-center gap-2">
        <Button size="sm" data-testid="parser-save" disabled={busy !== null || baseUrl.trim() === ""} onClick={() => void save()}>
          {busy === "save" && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          保存
        </Button>
        <Button size="sm" variant="outline" data-testid="parser-test" disabled={busy !== null || !profile} onClick={() => void probe()}>
          {busy === "test" && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          检测连接
        </Button>
        {message !== null && (
          <span
            role={message.ok ? "status" : "alert"}
            data-testid="parser-message"
            className={message.ok ? "text-2xs text-success" : "text-2xs text-warning"}
          >
            {message.text}
          </span>
        )}
      </div>
    </section>
  );
}
