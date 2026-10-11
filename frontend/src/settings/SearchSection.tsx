/**
 * 设置 · 文献检索 — the switch for related-paper search.
 *
 * Adding a search profile *is* turning the feature on: until one exists, the
 * backend refuses every related-paper request and nothing is sent anywhere.
 * The page says plainly what turning it on sends.
 */
import { useCallback, useEffect, useState } from "react";
import { BookMarked, Loader2 } from "lucide-react";

import { fetchWebModels, SEARCH_PROFILE_CHANGED, type WebModel } from "@/api/related";
import {
  createProfile,
  deleteProfile,
  listProfilesOfKind,
  testProfile,
  updateProfile,
  type ProviderProfile,
} from "@/api/profiles";
import { Button } from "@/components/ui/button";
import { describeApiError } from "@/translation/errors";

const PROVIDERS = {
  openalex: {
    label: "OpenAlex",
    url: "https://api.openalex.org",
    keyHint: "免费 API Key 可在 openalex.org 注册获得；不填只有很小的每日额度",
  },
  semantic_scholar: {
    label: "Semantic Scholar",
    url: "https://api.semanticscholar.org",
    keyHint: "可选；不填时使用公共限流池，高峰期可能较慢",
  },
  llm_web: {
    label: "AI 联网搜索（用已配置的模型）",
    url: "",
    keyHint: "",
  },
} as const;
type Provider = keyof typeof PROVIDERS;

export function SearchSection() {
  const [profile, setProfile] = useState<ProviderProfile | null | undefined>(undefined);
  const [provider, setProvider] = useState<Provider>("openalex");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "off" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [webModels, setWebModels] = useState<WebModel[]>([]);
  const [linked, setLinked] = useState("");
  const isWeb = provider === "llm_web";

  const load = useCallback(async () => {
    try {
      const found = (await listProfilesOfKind("search"))[0] ?? null;
      setProfile(found);
      if (found !== null && found.protocol in PROVIDERS) setProvider(found.protocol as Provider);
      if (found?.protocol === "llm_web") setLinked(found.model);
    } catch {
      setProfile(null);
    }
    try {
      const models = await fetchWebModels();
      setWebModels(models);
      setLinked((current) => current || (models.find((m) => m.supported)?.profile_id ?? ""));
    } catch {
      setWebModels([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy("save");
    setMessage(null);
    try {
      const target = webModels.find((m) => m.profile_id === linked);
      if (isWeb && (!target || !target.supported)) {
        setMessage({ ok: false, text: "请选择一个支持联网搜索的模型。" });
        return;
      }
      const name = isWeb ? `AI 联网搜索 · ${target!.name}` : PROVIDERS[provider].label;
      const draft = isWeb
        ? // The model profile's own key is used; nothing is stored here.
          { base_url: target!.base_url, protocol: provider, model: target!.profile_id, timeout_s: 180,
            ...(profile?.has_key ? { api_key: "" } : {}) }
        : {
            base_url: PROVIDERS[provider].url,
            protocol: provider,
            model: "",
            ...(apiKey !== "" ? { api_key: apiKey } : {}),
          };
      const saved =
        profile == null
          ? await createProfile({ name, kind: "search", ...draft })
          : await updateProfile(profile.id, { ...draft, name });
      setProfile(saved);
      window.dispatchEvent(new Event(SEARCH_PROFILE_CHANGED));
      setApiKey("");
      setMessage({ ok: true, text: "已开启相关论文搜索。" });
    } catch (error) {
      setMessage({ ok: false, text: describeApiError(error).detail });
    } finally {
      setBusy(null);
    }
  };

  const turnOff = async () => {
    if (!profile) return;
    setBusy("off");
    try {
      await deleteProfile(profile.id);
      setProfile(null);
      window.dispatchEvent(new Event(SEARCH_PROFILE_CHANGED));
      setMessage({ ok: true, text: "已关闭，密钥已从系统凭据存储中删除。" });
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
        text: `连接成功${result.latency_ms !== null ? ` · ${Math.round(result.latency_ms)} ms` : ""}`,
      });
    } catch (error) {
      setMessage({ ok: false, text: describeApiError(error).detail });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section data-testid="settings-search" className="space-y-2 border-t pt-3">
      <h3 className="flex items-center gap-1.5 text-xs font-semibold">
        <BookMarked className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
        文献检索 · 相关论文
        <span className="ml-1 rounded-sm bg-muted px-1 text-2xs font-normal text-muted-foreground">
          {profile ? "已开启" : "未开启（默认）"}
        </span>
      </h3>
      <p className="text-2xs leading-relaxed text-muted-foreground">
        这是本应用唯一会主动联网的功能。开启后，只会把论文的 DOI（没有时用标题）和你输入的搜索词发给所选的学术索引或模型服务；论文正文和笔记不会被发送。
      </p>
      {isWeb && (
        <p data-testid="search-web-note" className="text-2xs leading-relaxed text-muted-foreground">
          由模型调用服务商自带的联网搜索（DeepSeek、Qwen、GLM、OpenAI、Anthropic、OpenRouter）。每次查询消耗一次模型调用和搜索费用，比学术索引慢。模型可能编造文献，所以：参考文献只保留本文参考文献表里确实有的；链接没有出现在搜索结果中的论文会标为「待核对」。
        </p>
      )}
      <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
        <label className="text-2xs text-muted-foreground">
          数据源
          <select
            data-testid="search-provider"
            value={provider}
            onChange={(event) => setProvider(event.target.value as Provider)}
            className="mt-0.5 h-7 w-full rounded-md border bg-background px-1 text-xs text-foreground"
          >
            {Object.entries(PROVIDERS).map(([value, entry]) => (
              <option key={value} value={value}>{entry.label}</option>
            ))}
          </select>
        </label>
        {isWeb ? (
          <label className="text-2xs text-muted-foreground">
            模型
            <select
              data-testid="search-web-model"
              value={linked}
              onChange={(event) => setLinked(event.target.value)}
              className="mt-0.5 h-7 w-full rounded-md border bg-background px-1 text-xs text-foreground"
            >
              {webModels.length === 0 && <option value="">还没有配置模型</option>}
              {webModels.map((m) => (
                <option key={m.profile_id} value={m.profile_id} disabled={!m.supported}>
                  {m.name}（{m.model}）{m.supported ? ` · ${m.via}` : " · 不支持联网搜索"}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="text-2xs text-muted-foreground">
            API Key
            <input
              data-testid="search-api-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={profile?.has_key ? `已保存：${profile.api_key_masked}（留空则不修改）` : PROVIDERS[provider].keyHint}
              className="mt-0.5 h-7 w-full rounded-md border bg-background px-2 text-xs text-foreground"
            />
          </label>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" data-testid="search-save" disabled={busy !== null} onClick={() => void save()}>
          {busy === "save" && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          {profile ? "保存" : "开启"}
        </Button>
        <Button size="sm" variant="outline" data-testid="search-test" disabled={busy !== null || !profile} onClick={() => void probe()}>
          {busy === "test" && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
          检测连接
        </Button>
        {profile && (
          <Button size="sm" variant="ghost" data-testid="search-off" disabled={busy !== null} onClick={() => void turnOff()}>
            关闭
          </Button>
        )}
        {message !== null && (
          <span
            role={message.ok ? "status" : "alert"}
            className={message.ok ? "text-2xs text-emerald-700" : "text-2xs text-amber-600"}
          >
            {message.text}
          </span>
        )}
      </div>
    </section>
  );
}
