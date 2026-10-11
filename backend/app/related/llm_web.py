"""Related papers through a chat model that can search the web.

Some model services run a web search on the model's behalf: DeepSeek and
Anthropic through the Messages API's ``web_search`` tool, OpenAI through the
Responses API, Qwen (DashScope) through ``enable_search``, Zhipu GLM through its
``web_search`` tool and OpenRouter through the ``:online`` model suffix. A search
profile with protocol ``llm_web`` points at one of the reader's chat profiles
(its ``model`` field holds that profile's id) and reuses its endpoint and key.

A model can make things up, so nothing it returns is taken on its word:

* a reference is kept only when it matches an entry in the paper's own
  bibliography (when the bibliography was found at all);
* every paper is marked ``verified`` only when its link or DOI appears among
  the pages the search actually returned; the reader sees the rest flagged.

What is sent is the same as for the indexes: the paper's DOI (else its title)
and the reader's own search terms — never the body text.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import httpx

from app.related import sources
from app.related.sources import SearchError, Work, normalize_title
from app.storage.profiles import ServiceConfig

PROTOCOL = "llm_web"
#: A web-search round trip is slow; this is a floor, not the default.
MIN_TIMEOUT_S = 120.0
#: The model's thinking counts against this too: at 4096 a real DeepSeek answer
#: for three lists was cut off in the middle of the second.
MAX_OUTPUT_TOKENS = 16384

ANTHROPIC = "anthropic_messages"
RESPONSES = "openai_responses"
DASHSCOPE = "dashscope_chat"
ZHIPU = "zhipu_chat"
OPENROUTER = "openrouter_chat"
DIALECTS = (ANTHROPIC, RESPONSES, DASHSCOPE, ZHIPU, OPENROUTER)

DIALECT_LABELS = {
    ANTHROPIC: "Messages API · web_search",
    RESPONSES: "Responses API · web_search",
    DASHSCOPE: "DashScope · enable_search",
    ZHIPU: "GLM · web_search",
    OPENROUTER: "OpenRouter · :online",
}


@dataclass(frozen=True)
class WebModelConfig:
    """A chat profile's endpoint, key and model, with how to ask it to search."""

    dialect: str
    endpoint: str
    model: str
    api_key: str
    timeout_s: float
    custom_headers: dict[str, str] | None
    protocol: str = PROTOCOL


def detect_dialect(base_url: str, llm_protocol: str = "auto") -> tuple[str, str] | None:
    """(dialect, endpoint base) for a chat profile, or None if it cannot search.

    Decided by host: only services known to run the search server-side qualify,
    because a model without search would answer from memory — exactly the
    invented citations this feature must not show.
    """
    parsed = urlparse(base_url.strip())
    host = (parsed.hostname or "").lower()
    base = base_url.strip().rstrip("/")
    if host.endswith("deepseek.com"):
        # The Anthropic-compatible endpoint is the one that carries web search.
        return ANTHROPIC, f"{parsed.scheme or 'https'}://{parsed.netloc}/anthropic"
    if host.endswith("anthropic.com"):
        return ANTHROPIC, f"{parsed.scheme or 'https'}://{parsed.netloc}"
    if base.endswith("/anthropic"):
        return ANTHROPIC, base
    if "dashscope" in host:
        return DASHSCOPE, base
    if host.endswith("bigmodel.cn") or host.endswith("z.ai"):
        return ZHIPU, base
    if host.endswith("openrouter.ai"):
        return OPENROUTER, base
    if host.endswith("openai.com") or llm_protocol == "responses":
        return RESPONSES, base
    return None


def resolve(store: Any, service: ServiceConfig) -> WebModelConfig:
    """Turn an ``llm_web`` search profile into the chat service it points at."""
    linked_id = (service.model or "").strip()
    if not linked_id:
        raise SearchError("SEARCH_ERROR", "This search profile does not name a model profile.")
    try:
        profile = store.get_profile(linked_id)
    except Exception as exc:  # noqa: BLE001 — a deleted profile, typically
        raise SearchError(
            "SEARCH_ERROR", "The model profile this search uses no longer exists. Pick another in settings."
        ) from exc
    if profile.kind != "llm":
        raise SearchError("SEARCH_ERROR", "The linked profile is not a chat-model profile.")
    found = detect_dialect(profile.base_url, profile.protocol)
    if found is None:
        raise SearchError(
            "SEARCH_UNSUPPORTED",
            f"{profile.name} ({urlparse(profile.base_url).hostname}) has no built-in web search this app "
            "knows how to use. Supported: DeepSeek, Anthropic, OpenAI, Qwen (DashScope), GLM, OpenRouter.",
        )
    dialect, endpoint = found
    config = store.to_provider_config(linked_id)
    key = config.api_key
    key = key.get_secret_value() if hasattr(key, "get_secret_value") else str(key or "")
    return WebModelConfig(
        dialect=dialect,
        endpoint=endpoint,
        model=config.model,
        api_key=key,
        timeout_s=max(MIN_TIMEOUT_S, float(config.timeout_s or 0)),
        custom_headers=config.custom_headers,
    )


# --- prompts --------------------------------------------------------------------

_ITEM = (
    '{"title": str, "authors": [str], "year": int|null, "venue": str|null, '
    '"doi": str|null, "url": str|null, "abstract": str|null, "cited_by": int|null}'
)

_SYSTEM = f"""\
You are a literature-search assistant. Use the web search tool — Google Scholar,
Semantic Scholar, arXiv, OpenAlex, DBLP and publisher pages are good sources.

Rules:
1. Report only papers you actually saw in search results. Never invent a paper,
   a DOI, an author list or a citation count; use null for anything not seen.
2. "url" is the page where you saw the paper (prefer doi.org, arxiv.org or the
   publisher). "abstract" is at most 300 characters copied from that page, or null.
3. Answer with one JSON object and nothing else. Each paper is {_ITEM}.
"""


def _overview_prompt(title: str | None, doi: str | None) -> str:
    who = f"DOI {doi}" if doi else f'the paper titled "{title}"'
    return (
        f"Find {who}"
        + (f' (title: "{title}")' if doi and title else "")
        + ". Then find:\n"
        "- references: up to 15 of the most important works it cites;\n"
        "- citing: up to 10 notable later papers that cite it;\n"
        "- similar: up to 8 closely related papers on the same problem.\n"
        'Return {"paper": <paper or null>, "references": [...], "citing": [...], "similar": [...]}.'
    )


def _search_prompt(query: str, limit: int) -> str:
    return (
        f"Search for academic papers matching: {query}\n"
        f'Return up to {limit} of the most relevant as {{"papers": [...]}}.'
    )


# --- transport ------------------------------------------------------------------


@dataclass
class _Answer:
    text: str
    urls: set[str]


def _status_error(response: httpx.Response) -> SearchError:
    code = response.status_code
    if code in (401, 403):
        return SearchError("SEARCH_AUTH_FAILED", "The model service refused the API key.")
    if code == 429:
        return SearchError("SEARCH_RATE_LIMITED", "The model service's rate limit is used up for now.")
    detail = ""
    try:
        body = response.json()
        error = body.get("error") if isinstance(body, dict) else None
        detail = str((error or {}).get("message") or "") if isinstance(error, dict) else str(error or "")
    except ValueError:
        pass
    if code in (400, 404, 422) and re.search(r"web_?search|tool|enable_search|online", detail, re.I):
        return SearchError(
            "SEARCH_UNSUPPORTED", f"The model service rejected the web-search request: {detail[:200]}"
        )
    return SearchError("SEARCH_ERROR", f"The model service answered HTTP {code}. {detail[:200]}".strip())


async def _post(config: WebModelConfig, url: str, body: dict[str, Any], headers: dict[str, str]) -> Any:
    try:
        async with httpx.AsyncClient(
            transport=sources.TRANSPORT,
            timeout=httpx.Timeout(config.timeout_s, connect=10.0),
        ) as client:
            response = await client.post(url, json=body, headers={**(config.custom_headers or {}), **headers})
    except httpx.TimeoutException as exc:
        raise SearchError("SEARCH_TIMEOUT", "The model's web search timed out.") from exc
    except httpx.TransportError as exc:
        raise SearchError("SEARCH_UNREACHABLE", f"Could not reach {urlparse(url).hostname}.") from exc
    if response.status_code >= 400:
        raise _status_error(response)
    try:
        return response.json()
    except ValueError as exc:
        raise SearchError("SEARCH_ERROR", "The model service answered with something that is not JSON.") from exc


def _collect_urls(node: Any, into: set[str]) -> None:
    """Every URL anywhere in the response's search-result and citation parts."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key in ("url", "link", "uri") and isinstance(value, str) and value.startswith("http"):
                into.add(value)
            else:
                _collect_urls(value, into)
    elif isinstance(node, list):
        for item in node:
            _collect_urls(item, into)


async def _ask_anthropic(config: WebModelConfig, prompt: str) -> _Answer:
    messages: list[dict[str, Any]] = [{"role": "user", "content": prompt}]
    texts: list[str] = []
    urls: set[str] = set()
    for _turn in range(3):
        data = await _post(
            config,
            f"{config.endpoint}/v1/messages",
            {
                "model": config.model,
                "max_tokens": MAX_OUTPUT_TOKENS,
                "system": _SYSTEM,
                "messages": messages,
                "tools": [{"type": "web_search_20250305", "name": "web_search", "max_uses": 5}],
            },
            {"x-api-key": config.api_key, "anthropic-version": "2023-06-01"},
        )
        content = data.get("content") or []
        for block in content:
            if block.get("type") == "text":
                texts.append(str(block.get("text") or ""))
            elif block.get("type") in ("web_search_tool_result", "server_tool_result"):
                _collect_urls(block.get("content"), urls)
            if block.get("type") == "text":
                _collect_urls(block.get("citations"), urls)
        if data.get("stop_reason") != "pause_turn":
            break
        # A long search turn is paused, not finished: hand it back to continue.
        messages = [*messages, {"role": "assistant", "content": content}]
    return _Answer("\n".join(texts), urls)


async def _ask_responses(config: WebModelConfig, prompt: str) -> _Answer:
    data = await _post(
        config,
        f"{config.endpoint}/responses",
        {"model": config.model, "instructions": _SYSTEM, "input": prompt, "tools": [{"type": "web_search"}]},
        {"Authorization": f"Bearer {config.api_key}"},
    )
    texts: list[str] = []
    urls: set[str] = set()
    for item in data.get("output") or []:
        if item.get("type") == "message":
            for part in item.get("content") or []:
                if part.get("type") == "output_text":
                    texts.append(str(part.get("text") or ""))
                    _collect_urls(part.get("annotations"), urls)
        elif item.get("type") == "web_search_call":
            _collect_urls(item.get("action"), urls)
    if not texts and isinstance(data.get("output_text"), str):
        texts.append(data["output_text"])
    return _Answer("\n".join(texts), urls)


async def _ask_chat(config: WebModelConfig, prompt: str) -> _Answer:
    body: dict[str, Any] = {
        "model": config.model,
        "messages": [{"role": "system", "content": _SYSTEM}, {"role": "user", "content": prompt}],
    }
    if config.dialect == DASHSCOPE:
        body["enable_search"] = True
        body["search_options"] = {"forced_search": True, "enable_source": True}
    elif config.dialect == ZHIPU:
        body["tools"] = [{"type": "web_search", "web_search": {"enable": True, "search_result": True}}]
    elif config.dialect == OPENROUTER and not config.model.endswith(":online"):
        body["model"] = f"{config.model}:online"
    data = await _post(
        config, f"{config.endpoint}/chat/completions", body, {"Authorization": f"Bearer {config.api_key}"}
    )
    choice = (data.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    urls: set[str] = set()
    _collect_urls(message.get("annotations"), urls)
    _collect_urls(data.get("web_search"), urls)  # GLM
    _collect_urls(data.get("search_info"), urls)  # DashScope
    _collect_urls(data.get("output", {}).get("search_info") if isinstance(data.get("output"), dict) else None, urls)
    return _Answer(str(message.get("content") or ""), urls)


async def ask(config: WebModelConfig, prompt: str) -> _Answer:
    if config.dialect == ANTHROPIC:
        return await _ask_anthropic(config, prompt)
    if config.dialect == RESPONSES:
        return await _ask_responses(config, prompt)
    return await _ask_chat(config, prompt)


# --- parsing and checking ----------------------------------------------------------


def _loads_object(text: str) -> dict[str, Any] | None:
    try:
        value = json.loads(text)
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def _object_at(text: str, start: int) -> dict[str, Any] | None:
    """The JSON object opening at `start`.

    An answer cut off by the output limit never closes; it is closed after its
    last whole item instead, so the papers that did arrive are kept. Moving on
    to the next brace would return the first *nested* object — one paper —
    as if it were the whole answer.
    """
    closers: list[str] = []
    in_string = False
    escape = False
    whole: tuple[int, tuple[str, ...]] | None = None
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
        elif char in "{[":
            closers.append("}" if char == "{" else "]")
        elif char in "}]":
            if not closers or closers[-1] != char:
                return None
            closers.pop()
            if not closers:
                return _loads_object(text[start:index + 1])
            whole = (index + 1, tuple(closers))
    if whole is None:
        return None
    end, still_open = whole
    return _loads_object(text[start:end] + "".join(reversed(still_open)))


def parse_json(text: str) -> dict[str, Any]:
    """The first JSON object in a reply, fences and chatter tolerated."""
    cleaned = re.sub(r"```(?:json)?", "", text)
    start = cleaned.find("{")
    while start != -1:
        value = _object_at(cleaned, start)
        if value is not None:
            return value
        start = cleaned.find("{", start + 1)
    raise SearchError("SEARCH_ERROR", "The model's answer did not contain the expected JSON.")


_DOI = re.compile(r"^10\.\d{4,9}/\S+$")


def _norm_url(url: str) -> str:
    parsed = urlparse(url.strip())
    path = parsed.path.rstrip("/")
    path = re.sub(r"(/abs/[^/]+?)(v\d+)?$", r"\1", path)  # arXiv versions
    path = re.sub(r"\.pdf$", "", path.replace("/pdf/", "/abs/"))
    return f"{(parsed.hostname or '').removeprefix('www.')}{path}".lower()


def _is_verified(work: Work, seen: set[str]) -> bool:
    if not seen:
        return False
    normalized = {_norm_url(u) for u in seen}
    if work.url and _norm_url(work.url) in normalized:
        return True
    if work.doi:
        doi = work.doi.lower()
        return any(doi in u.lower() for u in seen)
    return False


def _int(value: Any) -> int | None:
    try:
        return int(value) if value is not None and str(value).strip() != "" else None
    except (TypeError, ValueError):
        return None


def to_work(raw: Any, seen: set[str]) -> Work | None:
    if not isinstance(raw, dict):
        return None
    title = str(raw.get("title") or "").strip()
    if len(normalize_title(title)) < 4:
        return None
    doi = str(raw.get("doi") or "").strip().removeprefix("https://doi.org/").removeprefix("doi:") or None
    if doi and not _DOI.match(doi):
        doi = None
    url = str(raw.get("url") or "").strip() or None
    if url and not url.startswith(("http://", "https://")):
        url = None
    if url is None and doi:
        url = f"https://doi.org/{doi}"
    authors = raw.get("authors") or []
    if isinstance(authors, str):
        authors = [a.strip() for a in re.split(r",|;| and ", authors) if a.strip()]
    identity = (doi or normalize_title(title)).lower()
    work = Work(
        key="web_" + hashlib.sha1(identity.encode("utf-8")).hexdigest()[:12],
        title=title,
        authors=[str(a) for a in authors if str(a).strip()][:30],
        year=_int(raw.get("year")),
        venue=(str(raw.get("venue")).strip() or None) if raw.get("venue") else None,
        doi=doi,
        url=url,
        abstract=(str(raw.get("abstract")).strip()[:600] or None) if raw.get("abstract") else None,
        cited_by=_int(raw.get("cited_by")),
    )
    work.verified = _is_verified(work, seen)
    return work


def _works(items: Any, seen: set[str], limit: int) -> list[Work]:
    out: list[Work] = []
    keys: set[str] = set()
    for raw in items if isinstance(items, list) else []:
        work = to_work(raw, seen)
        if work is not None and work.key not in keys:
            keys.add(work.key)
            out.append(work)
        if len(out) >= limit:
            break
    return out


# --- the source ---------------------------------------------------------------------


class LLMWebSource:
    """Same surface as the index sources, plus one-call `overview`."""

    name = PROTOCOL

    def __init__(self, config: WebModelConfig) -> None:
        self.config = config

    async def overview(
        self, title: str | None, doi: str | None, limits: tuple[int, int, int]
    ) -> tuple[Work | None, list[Work], list[Work], list[Work]]:
        answer = await ask(self.config, _overview_prompt(title, doi))
        data = parse_json(answer.text)
        paper = to_work(data.get("paper"), answer.urls)
        refs, citing, similar = limits
        return (
            paper,
            _works(data.get("references"), answer.urls, refs),
            _works(data.get("citing"), answer.urls, citing),
            _works(data.get("similar"), answer.urls, similar),
        )

    async def search(self, query: str, limit: int) -> list[Work]:
        answer = await ask(self.config, _search_prompt(query, limit))
        return _works(parse_json(answer.text).get("papers"), answer.urls, limit)
