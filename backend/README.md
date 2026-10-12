# Backend — Academic PDF Copilot

Local-only FastAPI service. It binds to loopback and is never exposed to a
network. See `docs/ARCHITECTURE.md` for where this sits in the product.

## Requirements

**Python 3.12.** The interpreter lives in `backend/.venv`. This is not optional:
the machine's default Python (3.14) is outside the supported range of the PDF
library this project builds on, so the backend is pinned to 3.12 so that later
phases can import that library in-process.

## Install

```bash
uv pip install --python backend/.venv/Scripts/python.exe -e "backend[dev]"
```

## Run

Single command, from `backend/`:

```bash
.venv/Scripts/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-server-header --no-date-header
```

`--host 127.0.0.1` and `--no-server-header` are both deliberate: the first keeps
the service off the network, the second stops uvicorn advertising its identity in
a `Server:` header. The application itself *also* refuses to configure a
non-loopback host, so a mistake here fails at startup rather than silently
exposing the service.

Then:

```bash
curl -i http://127.0.0.1:8000/api/health
# HTTP/1.1 200 OK
# {"status":"ok","version":"0.1.0"}
```

Interactive API docs are available at <http://127.0.0.1:8000/docs> when
`DEBUG=true`.

## Test

```bash
cd backend && .venv/Scripts/python -m pytest
```

The suite runs entirely offline. An autouse fixture fails any test that opens a
non-loopback socket, and every test uses a temporary database — the developer's
real database is never touched.

## Configuration

Copy `.env.example` to `.env` and edit. Precedence is
**environment > `.env` > defaults**. Every setting has a safe default, so an
empty config is valid.

| Variable | Default | Notes |
|---|---|---|
| `HOST` | `127.0.0.1` | Loopback only; anything else is rejected at startup |
| `PORT` | `8000` | |
| `DATABASE_PATH` | per-user app data dir | Parent directories are created automatically |
| `LOG_LEVEL` | `INFO` | `CRITICAL`…`DEBUG` |
| `CORS_ORIGINS` | local frontend origins | Comma-separated; `*` is rejected |
| `DEBUG` | `false` | Enables `/docs` |

## Layout

```
app/
├── __init__.py    version only — importing has no side effects
├── main.py        application factory, lifespan, request middleware
├── config.py      environment-driven settings + safety validators
├── errors.py      the error envelope and its exception handlers
├── logging.py     JSON logging with secret redaction, request ids
├── db.py          SQLite bootstrap (schema-version table only)
├── api/
│   ├── health.py    GET /api/health
│   └── profiles.py  /api/profiles — provider CRUD + connection test
├── security/      credential store (OS keyring)
├── storage/       profile persistence (SQLite)
├── pdfkernel/     PDF translation adapter — the ONLY package importing pdf2zh
└── llm/           vendor-neutral LLM layer
    ├── base.py             LLMProvider contract
    ├── models.py           request / result / config types
    ├── errors.py           normalised errors + retryability
    ├── client.py           shared SDK-client construction
    ├── chat_completions.py Chat Completions adapter  (POST /v1/chat/completions)
    └── responses.py        Responses adapter         (POST /v1/responses)
```

## Using the LLM layer

Callers depend on `LLMProvider` and the models — never on the OpenAI SDK:

```python
from app.llm import LLMRequest, OpenAIChatCompletionsProvider, ProviderConfig

provider = OpenAIChatCompletionsProvider(
    ProviderConfig(
        base_url="https://api.deepseek.com/v1",   # used verbatim
        api_key="sk-...",
        model="deepseek-chat",
    )
)

result = await provider.generate(
    LLMRequest(messages=[{"role": "user", "content": "Explain Bellman's equation."}])
)
print(result.text, result.usage)
```

Failures arrive as an `LLMError` subclass carrying a stable `code` and a `retryable`
flag — never as an `openai.*` exception or an HTTP status. `provider.test_connection()`
returns a report instead of raising, for settings screens.

**Two protocols, one contract.** Swap `OpenAIChatCompletionsProvider` for
`OpenAIResponsesProvider` and everything above it keeps working — same request models, same
`LLMResult`, same error codes for the same failures:

```python
from app.llm import OpenAIResponsesProvider

provider = OpenAIResponsesProvider(profile)
```

Protocol differences (`max_tokens` vs `max_output_tokens`, `prompt_tokens` vs `input_tokens`,
a `system` message vs `instructions`) are absorbed inside the adapters and never reach callers.

**The adapters are OpenAI-compatible, not OpenAI-only.** Endpoint, key, and model all come
from configuration; nothing in the package branches on vendor names.

## Parsing with MinerU (optional, off by default)

The in-house extractor runs on first read so a paper is readable at once. For
the reflowed bilingual reading — real LaTeX formulas, tables as tables, figures
as images — parse it with [MinerU](https://github.com/opendatalab/MinerU)
instead. MinerU is **called over HTTP, never installed into this backend**; the
same v1 API is served by a local server, a lab machine, or mineru.net.

1. Run a MinerU server (any machine), e.g. `pip install mineru` then
   `mineru-api --port 8100 --tier basic` (CPU-friendly; MinerU's own default
   port is 8000, which this backend already uses), or use mineru.net with an
   API key.
2. Create a *parser* profile. `model` is MinerU's tier: `flash` or `basic` for a
   CPU-only machine, `standard`/`advanced` when the server has a GPU (empty lets
   the server choose):

   ```bash
   curl -X POST http://127.0.0.1:8000/api/profiles -H "Content-Type: application/json" \
     -d '{"name":"MinerU","kind":"parser","base_url":"http://127.0.0.1:8100","model":"basic"}'
   ```
3. `POST /api/documents/{id}/parse` with `{"profile_id": "..."}` starts a
   background parse; `GET /api/documents/{id}/parse` reports it. When it
   completes, `ir.json` is replaced (`pipeline_version` becomes `mineru-2`), and
   the QA index, overview and paragraph translation rebuild on next use.
4. Images are served from `GET /api/documents/{id}/assets/images/<file>`.

What MinerU returned is kept in `<document dir>/mineru/` (`middle.json` plus
`images/`), so the IR can be rebuilt without paying the service again.

Paragraph translation runs as a background job:

| Route | What it does |
|---|---|
| `POST /api/documents/{id}/bilingual-text/jobs` `{"profile_id"}` | start (or resume) translating; 202 |
| `GET /api/documents/{id}/bilingual-text/jobs` | progress in batches |
| `DELETE /api/documents/{id}/bilingual-text/jobs` | stop; what landed is kept |
| `GET /api/documents/{id}/bilingual-text` | the reading — while a job runs, what it has so far (`pending` paragraphs fill in) |
| `POST /api/documents/{id}/bilingual-text/paragraphs/{pid}/retranslate` | one paragraph again, one call |
| `GET /api/documents/{id}/bilingual-text/glossary` | the terms this paper is translated with; reads a file, reaches no provider |
| `POST /api/documents/{id}/bilingual-text/glossary` `{"terms":[{"source","target"}]}` | save the reader's glossary; un-translates exactly the paragraphs that contain a changed term and returns `affected_paragraphs` — spends nothing (starting the job again translates those, and only those). `POST`, not `PUT`: the CORS policy does not admit `PUT` |
| `POST /api/documents/{id}/bilingual-text/glossary/extract` `{"profile_id"}` | read the paper's terms again, one call; a proposal — nothing is stored |

Each paragraph is saved as it lands (`_cache/bilingual/<hash>_<lang>.partial.json`,
rewritten at most every 0.8 s): a batch's answer is read as the model writes it
(Chat Completions `stream=True`), and a paragraph is kept the moment its own
translation is whole and has passed the checks a finished answer gets. An adapter
that cannot stream (the Responses one) is asked the ordinary way and lands a
batch at a time. A stopped or failed job resumes with only the paragraphs still
missing. Up to `concurrency` batches (default 2, at most 4) run at once.

The first batch is small (3 paragraphs / 1 500 characters) so the opening
arrives in seconds, and the glossary is read *beside* the translation, not before
it: batches sent before it returns go without one, and afterwards only the
paragraphs that contain a term and did not use its translation are translated
again (`restated_paragraphs` in the job; measured on one 92-paragraph paper: 18).
A streamed call reports no token usage, so `input_tokens`/`output_tokens` are
`null` for a reading made this way. The synchronous `POST /bilingual-text` still
works and is unchanged.

Inline formulas stay in paragraph text as `$…$`. The paragraph translator
replaces them with placeholders before a model sees the text and rejects any
translation that loses or duplicates one (`app/bilingual/mathguard.py`).

## Related papers (opt-in, the only outbound network feature)

Off by default. Adding a profile with `kind: "search"` turns it on; until then every
related-paper endpoint answers `409 SEARCH_NOT_CONFIGURED` and nothing leaves the machine.

- `protocol: "openalex"` — `base_url` `https://api.openalex.org`. Since Feb 2026 OpenAlex
  expects an API key (free at openalex.org); without one the daily budget is very small.
- `protocol: "semantic_scholar"` — `base_url` `https://api.semanticscholar.org`; key optional
  (sent as `x-api-key`).

- `protocol: "llm_web"` — no key of its own: `model` holds the id of a chat profile whose service
  runs web search server-side (DeepSeek via its `/anthropic` endpoint, Anthropic, OpenAI Responses,
  Qwen/DashScope `enable_search`, GLM `web_search`, OpenRouter `:online`).
  `GET /api/related/web-models` lists which chat profiles qualify. A model can invent papers, so
  references not in the paper's own bibliography are dropped, and each paper carries
  `verified: true` only when its link/DOI was among the pages the search returned.

What is sent: the paper's DOI (or arXiv id, else its title) and search terms the user types.
Body text and notes are never sent. Results are cached in `_cache/related/`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/documents/{id}/related[?refresh=1]` | identify the paper; references, citing works, similar works; references linked to the paper's own bibliography and citing sentence |
| `GET /api/documents/{id}/related/search?q=` | free-text search |
| `POST /api/documents/{id}/related/explain` `{profile_id, keys}` | one LLM sentence per paper on how it relates (abstracts only, ≤8 per call) |
| `POST /api/documents/{id}/related/import` `{key}` | download a cached open-access PDF (public http(s) only, size-limited, PDF-validated) into the library |

## Translating a PDF (PDFMathTranslate, layout-preserving)

```python
from app.pdfkernel import translate_pdf

result = await translate_pdf(
    "paper.pdf", "output/", "zh",
    provider_config,           # from a profile: ProfileStore.to_provider_config(id)
)

result.mono_path       # translated only, same page count as the source
result.dual_path       # bilingual, interleaved: orig0, trans0, orig1, trans1, …
result.pages_per_minute
```

Heavy and synchronous, so it runs on a worker thread. Failures arrive as `PDFKernelError`
subclasses with a stable `code` and a `to_dict()` for the HTTP envelope.

**The source file is never modified.** The adapter hands upstream a *copy*: upstream deletes
input files that live under the system temp directory, so passing the original would risk a
user's file.

**One prerequisite:** the layout model (~72 MiB) must be cached locally. It is fetched on first
use; if it is missing the adapter says so precisely rather than downloading or hanging.

**Known issues** (recorded in `.agent/evidence/DS-PDF-001.md`, not yet fixed):
a failing provider is retried indefinitely by upstream, and the translation cache is keyed
without the endpoint, so two providers can share translations.

## Conventions

**Error shape.** Every error response is
`{"error": {"code", "message", "detail"}}` with a stable machine-readable
`code`. FastAPI's default `{"detail": ...}` shape is overridden.

**Logging.** One JSON object per line. Any field whose name looks like a
credential (`api_key`, `authorization`, `token`, `secret`, `password`) is
redacted, as are `Bearer …` and `key=value` patterns inside free text. Never add
a code path that logs a secret directly.

**Privacy.** Nothing here or downstream may write to `~/.cache/pdf2zh/` or
`~/.config/PDFMathTranslate/` — those belong to the upstream PDF library, and a
test enforces it.

**Import discipline.** Importing `app.main` must not create files, open sockets,
or log. Startup work belongs in the lifespan handler.
