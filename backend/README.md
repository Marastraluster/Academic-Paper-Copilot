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

## Translating a PDF

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
