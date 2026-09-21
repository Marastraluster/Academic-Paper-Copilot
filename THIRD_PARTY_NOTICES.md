# Third-party notices

Academic Paper Copilot is distributed under the **GNU Affero General Public License v3.0**
(`LICENSE`). That is not a preference: the two components at the centre of its pipeline are
AGPL-3.0, and this application links them directly, so the combined work can only be
distributed under the same licence.

If you fork this project, a distributed or network-hosted version of it must be AGPL-3.0 as
well. The complete corresponding source of this application is this repository.

## Components that shape the licence

| Component | Licence | How it is used here |
|---|---|---|
| [PDFMathTranslate](https://github.com/Byaidu/PDFMathTranslate) | **AGPL-3.0** | The translation kernel. `backend/app/pdfkernel/` drives it through a thin adapter, so the engine stays swappable — but it is a direct dependency, and it is the reason for this project's licence. |
| [PyMuPDF](https://github.com/pymupdf/PyMuPDF) (imported as `fitz`) | **AGPL-3.0** (dual-licensed commercially by Artifex) | PDF parsing, page rendering, text and geometry extraction — the extraction pipeline in `backend/app/document/` and `backend/app/api/documents.py`. |
| [babeldoc](https://github.com/funstory-ai/BabelDOC) | not yet audited | Pulled in by the translation kernel. Its licence must be audited before any binary packaging. See `docs/decisions/ADR-002-license-AGPL.md`. |

Both AGPL components are used **as dependencies**, unmodified, under their own terms. Their
copyright notices and licence texts belong to their authors; if you redistribute a combined
work, preserve them.

## The rest of the stack

The remaining dependencies are permissively licensed (MIT / ISC / BSD / Apache-2.0) and are
listed in `backend/pyproject.toml` and `frontend/package.json`. Among them:

| Component | Licence | Role |
|---|---|---|
| [PDF.js](https://mozilla.github.io/pdf.js/) (`pdfjs-dist`) | Apache-2.0 | The in-browser PDF reader |
| [React](https://react.dev/) / [React DOM](https://react.dev/) | MIT | The interface |
| [Vite](https://vite.dev/) | MIT | Build and dev server |
| [Zustand](https://github.com/pmndrs/zustand) | MIT | Application state |
| [Tailwind CSS](https://tailwindcss.com/) | MIT | Styling |
| [lucide](https://lucide.dev/) | ISC | Icons |
| [Radix UI](https://www.radix-ui.com/) | MIT | Accessible primitives (tooltip, separator, slot) |
| [FastAPI](https://fastapi.tiangolo.com/) / [Uvicorn](https://www.uvicorn.org/) | MIT / BSD-3-Clause | The local HTTP service |
| [Pydantic](https://docs.pydantic.dev/) | MIT | Request and artifact models |
| [keyring](https://github.com/jaraco/keyring) | MIT | The operating system credential store |
| [OpenAI Python SDK](https://github.com/openai/openai-python) | Apache-2.0 | The OpenAI-compatible client used against any configured endpoint |

## A note on the model services

This project ships **no** model, no weights and no keys. It talks to whatever OpenAI-compatible
endpoint the reader configures — a local Ollama or vLLM server, or a hosted service — under
that service's own terms. Nothing about your papers or your prompts leaves your machine except
the requests you explicitly ask for.
