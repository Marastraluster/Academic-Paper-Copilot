# Evidence — DS-CTX-001 Academic Context Foundation

- **Date:** 2026-09-17
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-CTX-001.md` (Gemini, frozen before implementation)
- **Baseline:** `ff744ab` (DS-DOC-001 + Gate 0 fix)
- **Verdict:** **DONE — all 24 P0 criteria PASS. 1 of 4 P1 PASS, 3 deferred with reasons.
  0 of 3 P2 implemented (optional). 2 `AC_CHANGE_REQUEST`s raised and resolved.
  §79/§80 (real-model quality judgement) NOT PERFORMED — see below.**

## Gate 0 — closing the DS-DOC-001 gap

Before any Context Engine work, the real-paper validation DS-DOC-001 left partial was
completed against **ResNet (arXiv:1512.03385)**, 12 pages, two-column, with display equations.
It found five defects in the shipped IR, all now fixed and regression-tested in `ff744ab`.
Full record: `.agent/evidence/DS-DOC-001-GATE0.md`.

The one worth repeating here, because it was a claim rather than a defect: **`AC-DOC-30` was
reported PASS when only its metadata half existed.** The layout-title fallback was never
implemented and never tested. Gate 0 caught it because a real arXiv PDF carries no title
metadata — the exact case the fallback exists for.

Two obvious heading heuristics were measured and both failed before one was accepted: "a heading
is followed by prose" matched every spurious heading, and "a label sits near a table" put
`Abstract` at zero points from a figure while `PASCAL VOC` sat at infinity. Font size separated
them cleanly — 17 of 17 real headings accepted, 6 of 6 spurious rejected.

## What was built

```
backend/app/context/models.py           DocumentAnalysis and friends — the AI-derived schema
backend/app/context/prompts.py          versioned prompts; PROMPT_VERSION is in the cache key
backend/app/context/budget.py           token estimation and truncation
backend/app/context/evidence.py         paragraph-id and snippet validation
backend/app/context/pipeline.py         the hierarchical pipeline
backend/app/context/persistence.py      analysis.json, atomic
backend/app/context/context_builder.py  the bounded context package
backend/app/context/service.py          caching, invalidation, and the provider adapter
backend/app/storage/atomic.py           one atomic-write implementation instead of two
backend/tests/test_context_analysis.py  50 tests
```

New endpoints, following the DS-BE-007 conventions:

```
POST   /api/documents/{id}/analysis            analyse, or reuse a valid analysis
GET    /api/documents/{id}/analysis            read a stored analysis; never generates
DELETE /api/documents/{id}/analysis            discard it
GET    /api/documents/{id}/context-preview     the context a translation call would receive
```

## Verification

```
$ cd backend && .venv/Scripts/python -m pytest
    → 610 passed, 0 failed     (560 at baseline, +50 new — no regression)

$ cd frontend && npm run test
    → 75 passed, exit 0        (untouched)

translation kernel:  git status backend/app/pdfkernel/ → unmodified
```

### Real path, end to end

`.agent/results/ctx-verify/verify.py` drives the real ASGI app, the real IR, the real context
service, the real provider adapter, and a real HTTP round trip to an OpenAI-compatible endpoint
on loopback, against the 12-page ResNet paper.

```
--- analysis (15.3s, 21 provider requests) ---
status            : READY
domain            : {'primary': 'Computer Vision', 'secondary': ['Deep Learning'],
                     'confidence': 0.85, 'rationale': 'residual networks for image recognition'}
sections analysed : 10
glossary entries  : 3
entities          : 1
errors            : []

--- glossary ---
  'residual learning'   -> '残差学习'  translatable=True  evidence=[p_…_0001, p_…_0002]
  'degradation problem' -> '退化问题'  translatable=True  evidence=[p_…_0001, p_…_0002]
  'plain network'       -> '普通网络'  translatable=True  evidence=[p_…_0001, p_…_0002]

fabricated term survived : False   (a term citing a non-existent paragraph id was dropped)
second call reused       : True    (provider calls added: 0)
different model reused   : False   (model change invalidates)
source unchanged         : True
```

The stub cites real paragraph ids read out of the prompt it receives, plus one id that does not
exist — so the evidence check was exercised in both directions against real data rather than
only against fixtures.

### ContextBuilder, three paragraphs

| Paragraph | Page | Section | kept | shed |
|---|---|---|---|---|
| `…_0001` | 1 | 1. Introduction | 239 / 600 | — |
| `…_0034` | 3 | 3.3. Network Architectures | **583 / 600** | glossary, document_summary |
| `…_0068` | 8 | 4.3. Object Detection on PASCAL and MS COCO | 346 / 600 | — |

Neighbours are the actual adjacent paragraphs in canonical reading order (`Plain Network…` →
target → `Residual Network…`), sections are the real `section_id`, and **the target paragraph's
own text appears in no context** — asserted for all three.

The second row is the interesting one: its neighbours are full paragraphs, the context genuinely
exceeded the budget, and the shedding order did exactly what it is specified to do — glossary
first, then the document summary — landing at 583 tokens. My first reading of that result was
that something had been shed unnecessarily; measuring the fields showed the budget was correct
and my estimate had used short sample strings. Recorded because it is the kind of result that
looks like a bug and is not.

## Two AC_CHANGE_REQUESTs

### 1. AC-P0-09's budget test referenced a field that does not exist

It wrote `… ≤ ProviderConfig.context_window`. `ProviderConfig` has no such field, and
deliberately: this project never models what a user's endpoint can hold. The budget is now an
explicit analysis-side configuration with a conservative default, and the invariant is checked
before every request rather than being discovered by the provider. That is what the brief
anticipated — *"If model context capacity is unknown: use conservative defaults/configuration."*

### 2. "Provider name" was the wrong cache identity

The criteria recorded `provider_name` (e.g. `openai`) in provenance and in the cache key. In this
project a provider is a **user-created profile**, so there is no vendor identity to record and
the profile's name is free text the user can rename. Using it would mean (a) renaming a profile
silently invalidates every analysis made with it, and (b) two profiles for different endpoints
sharing a name would be treated as the same provider — precisely the upstream translation-cache
defect this task is told not to repeat.

Identity is now `(base_url, model)`. The display name is recorded for a human and is not an
input to validity; a test asserts `is_cache_valid`'s source never mentions it.

## Two defects I introduced and caught

**A fatal provider error would have burned one call per section.** Auth failures were caught and
recorded per unit like any other error, so a five-section paper with a rejected key would have
issued five doomed requests — the same shape as the unbounded-retry defect DS-BE-FIX-002 removed
from translation, reintroduced in a new layer. Fatal errors (auth, permission, bad request, not
found) now abort the run: they describe the configuration, not the section. Pinned by
`test_a_fatal_provider_error_aborts_the_whole_run`, which asserts exactly one call.

**A successful single-pass analysis reported no sections at all**, making it indistinguishable
from one that analysed nothing. It now emits one synthetic partition covering the document,
which is the truthful shape: all of it was read, as one unit.

Both were found by tests failing for reasons I had not predicted, and both were product bugs
rather than test bugs — the distinction is worth making because three other failures in the same
run genuinely were test bugs (documents too short to take the hierarchical path).

## §79 / §80 — real-provider verification: NOT PERFORMED

The Definition of Done asks for *"at least one real analysis using an actually configured
OpenAI-compatible provider"* and a manual judgement of whether the domain is sensible, the
summary describes the real paper, and the glossary translations are academically plausible.

**No real provider is configured on this machine.** The application database has no `profiles`
table at all, and no API key or local model server is available. I did not invent one or
substitute a stub for it.

What *was* verified is the whole mechanical path — request construction, protocol
auto-detection, response parsing, evidence validation against real paragraph ids, merging,
persistence, reuse, invalidation, and the ContextBuilder — through a genuine HTTP round trip.
What remains unverified is **model judgement**: whether a real model infers a sensible domain for
this paper, writes a summary that describes it, or proposes academically plausible Chinese
terms. Every quality claim about the analysis itself is therefore unproven, and the domain,
summary and glossary shown above came from a stub whose content I wrote.

This is the same class of gap Gate 0 closed for DS-DOC-001, and it should be closed the same
way: by running the pipeline against a configured provider.

## Acceptance criteria — P0

All 24 pass. The load-bearing ones:

| Criterion | Verdict | Evidence |
|---|---|---|
| AC-P0-01 IR immutable | **PASS** | Serialised IR identical after analysis |
| AC-P0-02 no second parser | **PASS** | AST check over the package; analysis succeeds with no source file present |
| AC-P0-03 `abandon` excluded | **PASS** | Marker in an `abandon` block appears in no prompt |
| AC-P0-04 evidence by paragraph id | **PASS** | Unknown ids dropped; fabricated snippet rejected; **verified live** — the fabricated term did not survive |
| AC-P0-05 exact spelling | **PASS** | `LeVJEPA`, `ResNet-50`, `Something-Something V2` preserved; marked untranslatable |
| AC-P0-06 no invented expansions | **PASS** | Expansion kept only where the paper pairs the strings; otherwise `None` |
| AC-P0-07 domain uncertainty | **PASS** | Weak evidence yields `Unknown` with confidence < 0.5 |
| AC-P0-08 no bare `page` field | **PASS** | Asserted across serialised payloads and `TranslationContext` |
| AC-P0-09 paragraph boundaries + budget | **PASS** | Contiguous ids per request; no request over budget |
| AC-P0-10 unsectioned documents | **PASS** | Synthetic partitions; every paragraph covered |
| AC-P0-11 bounded, normalised errors | **PASS** | 401→1 call, 429→3, 5xx→2, timeout→2, connection→1; fatal aborts the run |
| AC-P0-12 malformed/empty rejected | **PASS** | One repair attempt; empty output never `READY` |
| AC-P0-13 partial failure | **PASS** | 5 sections, 1 failing → `PARTIAL`, other 4 retained |
| AC-P0-14 cancellation | **PASS** | No dispatch after cancel; nothing written |
| AC-P0-15 no speculative table | **PASS** | Table set still exactly four; `SCHEMA_VERSION` 3 |
| AC-P0-16 atomic write | **PASS** | Injected failure preserves the previous file; no temp left |
| AC-P0-17 provenance | **PASS** | All fields populated; no credential anywhere |
| AC-P0-18 invalidation | **PASS** | Source, prompt, pipeline, model and endpoint each invalidate; **key rotation does not**, and there is no code path by which it could |
| AC-P0-19 rebuildable | **PASS** | Source, IR, mono and dual byte-identical after delete and after forced rebuild |
| AC-P0-20 no credential leak | **PASS** | 0 occurrences across artifact, responses and logs |
| AC-P0-21 logging privacy | **PASS** | A marker sentence appears in no log record |
| AC-P0-22 translation untouched | **PASS** | Kernel unmodified; 610 tests pass |
| AC-P0-23 bounded context + shedding | **PASS** | Shedding order verified; section title and in-paragraph terms protected |
| AC-P0-24 no target text | **PASS** | No such field; asserted on the API preview too |

### P1

| Criterion | Verdict |
|---|---|
| AC-P1-01 summary quality contract | **DEFERRED** — length and synthesis-vs-copy bounds need a real model to calibrate; cannot be honestly assessed against a stub |
| AC-P1-02 terminology deduplication | **DEFERRED** — exact-match merging is implemented (casefolded, with id union); fuzzy variant clustering is not |
| AC-P1-03 opt-in real-provider test | **DEFERRED** — no provider to point it at |
| AC-P1-04 performance | **PASS** — cached read and `build_context` both asserted under budget |

## Known limitations

1. **Model quality is unverified.** See §79/§80 above. This is the significant one.
2. **Token counts are estimates, not tokenisations.** Deliberately conservative, and CJK is
   counted separately so a Chinese paper is not under-counted by an order of magnitude — but a
   real tokenizer would be more precise. None is added, because that would mean modelling
   per-model behaviour this project does not model.
3. **Column detection is two-column.** Inherited from DS-DOC-001 and unchanged here.
4. **Glossary selection is lexical.** A term is matched by case-folded substring. A term that
   appears only in an inflected form, or that the paper names differently in different sections,
   will not be matched to the paragraph that needs it.
5. **Rate-limit retries are per unit.** A persistent 429 across many sections burns three calls
   each. Bounded, and it still yields `PARTIAL` results — but a global rate limit is arguably a
   configuration condition like auth, and does not currently abort the run.
6. **No frontend consumes any of this.** The endpoints exist; the translation flow is unchanged,
   as the task requires.
7. **`analysis.json` is not versioned beyond the cache key.** An older file with an unknown
   status or a missing field is treated as a cache miss and regenerated, not migrated.

## Recommended Next Task

**DS-CTX-002 — context-aware PDF translation.** The context source now exists and is bounded;
the next step is injecting it into the translation call, which is also the right place to fix the
upstream cache's missing endpoint identity.

Before or alongside it, **§79/§80 should be closed**: configuring one real provider and running
this pipeline against ResNet would turn every quality claim in this document from unverifiable
into measured.
