/**
 * 设置 · 文献检索 — the AI web-search option borrows a chat profile.
 *
 * Only models whose service searches the web themselves can be picked, and the
 * saved search profile points at that chat profile instead of storing a key.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SearchSection } from "@/settings/SearchSection";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("文献检索 settings", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("creates an llm_web profile that points at a web-capable chat profile", async () => {
    const user = userEvent.setup();
    const created: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/related/web-models")) {
        return json({ models: [
          { profile_id: "prof_local", name: "Local", model: "qwen", base_url: "http://127.0.0.1:11434/v1",
            supported: false, via: null },
          { profile_id: "prof_ds", name: "DeepSeek", model: "deepseek-chat", base_url: "https://api.deepseek.com",
            supported: true, via: "Messages API · web_search" },
        ] });
      }
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        created.push(body);
        return json({ id: "prof_s", ...body, has_key: false, api_key_masked: "" }, 201);
      }
      return json({ profiles: [] });
    }));

    render(<SearchSection />);
    await user.selectOptions(await screen.findByTestId("search-provider"), "llm_web");
    expect(screen.queryByTestId("search-api-key")).toBeNull();
    const picker = await screen.findByTestId("search-web-model");
    expect(screen.getByRole("option", { name: /Local.*不支持联网搜索/ })).toBeDisabled();
    expect(picker).toHaveValue("prof_ds");

    await user.click(screen.getByTestId("search-save"));
    expect(await screen.findByRole("status")).toHaveTextContent("已开启");
    expect(created[0]).toMatchObject({
      kind: "search", protocol: "llm_web", model: "prof_ds", base_url: "https://api.deepseek.com",
    });
  });
});
