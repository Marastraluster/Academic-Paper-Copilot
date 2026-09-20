# Acceptance Criteria — DS-QA-015: Reader Overview Pipeline + Content-Addressed Analysis Cache

- **Author:** Gemini (`gemini-3.8-flash-high`), via the standing two-agent workflow
- **Reviewed and frozen by:** DeepSeek (Pending Round 1 review)
- **Date:** 2026-09-20
- **Baseline:** Commit `85207e8` / Post-DS-QA-014 (`SCHEMA_VERSION = 5`, `IR_PIPELINE_VERSION = "5"`, `CountingProvider` ledger in `app/llm/accounting.py`)
- **Measured Generation Baseline:** 1565.8 s (~26 min), 11 serial calls, `PARTIAL` status (`.agent/results/analysis-measure.log`)
- **Frontend Baseline Bundle:** 349.14 kB initial chunk against 350.0 kB ceiling (0.86 kB headroom, 0 code splitting)
- **Deliverable:** `docs/acceptance/DS-QA-015.md` (authored before any production code)
- **Status:** **PROPOSED FOR ROUND 1 REVIEW — 55 P0 · 6 P1 · 4 P2**

## 0. Round 1 review and freezing (DeepSeek) — 3 AC_CHANGE_REQUESTs

Read against the repository at `85207e8` and the measurements in §2. Decisions
**C, D, E, F, G, H, I, J, K, L, N, O, P, Q, R, S, T, U** are accepted as written;
the central one — replacing eleven serial translation-oriented calls with one
bounded reader-facing synthesis — is what the measured structure demands, and the
criteria state the numbers before any of them have been run. Three items are
changed.

### AC_CHANGE_REQUEST 1 — Decisions A and V contradict each other

**Old wording (A):** *"The existing `DocumentAnalysis.summary` may be reused as a
temporary fallback if valid."*
**Old wording (V):** *"Legacy translation summaries are **never** displayed
directly; intermediate only."*

**New wording:** Decision A is withdrawn. The legacy document summary is **never
displayed**, under any condition. It may be supplied as an intermediate hint to
the reader synthesis (Decision C, unchanged).

**Reason.** The two decisions answer the same question oppositely, and a
criterion cannot be written against both. V is the one that matches the
measurement: the existing summary is produced by a prompt that opens *"Produce a
compact orientation for a translation system"*, and the audit found
machine-directed sentences inside it. The document-level summary happened to read
well for ResNet — one paper — and "it reads well here" is exactly the reasoning
this repository's evidence rule exists to refuse. When no Reader Overview exists
the panel shows the deterministic Reading Entry and the generate affordance,
which is what DS-QA-014 already ships.

### AC_CHANGE_REQUEST 2 — AC-P0-36 can silently empty the Overview

**Old wording:** *"Unsectioned page-1 metadata … must be classified as
`DOCUMENT_METADATA` and excluded from synthesis."* Evidence: *"no section card
with title containing 'Unsectioned Content' is generated."*

**New wording:** *"Unsectioned paragraphs are excluded when they are front
matter — those on the abstract's own page that precede the abstract paragraph —
and are otherwise treated as body text. The evidence is two-sided: no card titled
`Unsectioned Content` is produced **and** a paper whose extraction found no
sections at all still yields a non-empty Overview drawn from its unsectioned
body."*

**Reason.** The criterion as written passes on an empty result. A paper whose
extraction reported no sections has *every* paragraph unsectioned, so "exclude
the unsectioned ones on page 1" removes its introduction, and the stated evidence
— the absence of a card — is satisfied by producing nothing at all. Measured
context: the DS-QA-013 audit found 163 `title` blocks and 103 `abandon` blocks
across five papers, so front matter is a real and identifiable region, and the
abstract's own page is where it sits. The one-sided evidence is the part that has
to change; the exclusion itself is right.

### AC_CHANGE_REQUEST 3 — AC-P0-41 freezes a rate without naming the detector

**Old wording:** *"machine meta-instruction claims must be strictly 0%"*, with
evidence *"asserting `unsupported_count / total <= 0.02` and `meta_claims == 0`."*

**New wording:** *"`meta_claims` counts generated strings that address a
translator rather than the reader, detected against a fixed vocabulary derived
from the measured baseline output — the words `translation`, `translator`,
`preserve … spelling`, `terminology consistency` and their inflections — applied
to every generated field. The list is a constant in the test, so adding a phrase
is a reviewable change and the check cannot drift."*

**Reason.** "Meta-claim" is not a thing a test can count. The measured baseline
gives the vocabulary — *"It is useful for preserving author names and affiliation
spelling during translation"*, *"For translation, venue acronyms … should be
preserved"* — and a fixed list derived from it is deterministic, reviewable and
directly comparable to the 6/48 that preceded it. Without a named detector the
criterion is unfalsifiable, and an unfalsifiable P0 is one that always passes.

### Accepted and recorded without change

**AC-P0-52's ≤ 300.0 kB is frozen as written**, and it supersedes the standing
350 kB ceiling as the P0 measurement. This is a demanding target — the initial
chunk is **349.14 kB** and the application has no code splitting at all, so 49 kB
has to come out of one chunk — and the measurement justifies it rather than
choice: no `lazy(` and no `Suspense` exists anywhere in `src/app` or
`src/assistant`, the PDF.js chunk is already split, and every panel the reader
can open is in the initial download. React's `lazy` and dynamic `import()` are
already present, so the recovery costs no dependency. **If the build does not
reach 300 kB, AC-P0-52 is reported FAIL** — the threshold was frozen before the
attempt and is not renegotiated after it.

**Recorded, not a criterion:** the cache location Decision S chooses
(`<documents_dir>/_cache/overview/…`) sits *beside* the per-document
directories rather than inside one, which is what lets the artifact survive the
document row it was generated from. That is the whole point of the fix and it is
worth stating, because a cache placed one directory deeper would reproduce the
defect it exists to repair.

**P0 is frozen at 55 criteria with the three changes above.**

---

## 0.1 Round 2 review (DS-QA-015-FIX-004) — AC_CHANGE_REQUEST 4, **PROPOSED**

Raised after the implementation, against the measured bundle. **AC-P0-52 is
unchanged below and still FAILS at 304.54 kB.** This request is a proposal to
amend it, not an amendment: it is recorded here so the decision is made in the
open, with the numbers, rather than by quietly declaring a miss a pass.

### AC_CHANGE_REQUEST 4 — AC-P0-52's ceiling sits below the application's floor

**Frozen wording (unamended):** *"With code splitting enabled, the initial
JavaScript bundle chunk (`index-*.js`) must not exceed **300.0 kB** minified,
regaining ≥ 49 kB of headroom under the 350.0 kB total ceiling."*

**Original threshold:** 300.0 kB, frozen before the attempt was made. §0 records
the commitment — *"If the build does not reach 300 kB, AC-P0-52 is reported
FAIL"* — and it has been reported FAIL in every tranche since.

**Original rationale:** the initial chunk measured 349.14 kB with **no code
splitting at all**: no `lazy(` and no `Suspense` existed in `src/app` or
`src/assistant`, and every panel the reader could open was in the initial
download. 49 kB was expected to come out of that, and the criterion named the
mechanism — split the non-initial panels.

**Measured progress: 349.14 → 304.54 kB, 44.6 kB recovered**, by exactly the
mechanism the criterion named (`index-*.js`, raw, as the metric specifies):

| split | chunk |
|---|---|
| NotesPanel | 10.53 kB |
| QaPanel (ConversationArea + Composer) | 19.72 kB |
| OutlinePanel | 3.96 kB |
| TranslateDialog | 6.91 kB |
| GeneratedOverview | 3.60 kB |
| shared `targets` | 3.20 kB |

**What is left, measured per module** (`esbuild` metafile over the production
graph; the initial set reproduces the Vite figure to within 1%):

| module | kB | category |
|---|---|---|
| `react-dom` | 130.0 | framework — first paint |
| `@radix-ui/react-tooltip` + popper + dismissable-layer + floating-ui | ~30 | interaction-only (hover) |
| `tailwind-merge` | 19.8 | the design system's class-merge contract |
| `qa/session` + `notes/session` + `qa/errors` + `qa/parse` + api | 15.0 | synchronous mouseup path |
| entry (`PdfWorkspace`, `OverviewPanel`, `TopBar`, `AppShell`, reader) | 49.8 | first paint |
| `qa/selection` | 3.3 | synchronous mouseup path |
| `lucide-react` (20 icons), store, button, errors, outline | 23.9 | chrome |

**Reductions attempted and rejected, each measured:**

1. **Drop `tailwind-merge` (19.8 kB — enough by itself; would land at 284.7).**
   Rejected: it is not a size question but a contract question, and the contract
   is demonstrably load-bearing today. `src/app/TopBar.tsx:89` and `:102` render
   `<Separator orientation="vertical" className="h-5" />`; the separator's own
   classes include `h-full`, and `cn()` is what removes it — the rendered DOM
   carries `shrink-0 bg-border w-px h-5` and **not** `h-full`. Without the merge
   the browser decides: the built stylesheet emits `.h-5{height:1.25rem}` at byte
   7688 and `.h-full{height:100%}` at byte 7784, so equal specificity resolves to
   `100%` and the top bar's two rules stretch to the full row height. Deciding a
   styling question by stylesheet order rather than by intent is a product
   regression, and with 317 `className=` sites in the application there is no
   test surface that would catch the next one.
2. **Make the Radix tooltip chain interaction-loaded (~30 kB; would land at
   ~275).** Rejected: the tooltip primitive would have to render its triggers
   without a provider until a hover loads the chunk, which changes the trigger's
   accessibility attributes and makes the first hover show nothing. That is a
   rewrite of a shared UI primitive to satisfy a number, and this repository has
   no visual regression surface to verify it.
3. **Async-load `qa/session` / `qa/selection` (18.3 kB).** Not attempted, and
   forbidden by the architecture this tranche froze: `useSelectionCapture`
   resolves the reader's selection **synchronously on mouseup**, through
   `refreshSelection` and `clearSelection`, and
   `mouseup → await import(...) → window.getSelection()` is the design the task
   specification rules out by name (the browser's selection may have moved by the
   time the chunk arrives). Splitting the module would have to keep that capture
   path synchronous anyway, which is why the module is eager.
4. **Split the PDF viewer out of `PdfWorkspace` (~5-10 kB).** Rejected as
   disproportionate *and* unsafe: the reader pane's first paint **is** the file
   picker inside `PdfWorkspace`, so the boundary would either load at boot (a
   "lazy" chunk that is initial in substance — Phase 21 forbids exactly this) or
   require pulling the document half, its zoom, page and highlight state, out of
   the component that owns them. It would also land within a few kB of the
   ceiling, which §0 already warns against.

**Why the original criterion now conflicts with correctness.** 300.0 kB is
below what this application can download without deciding a styling question by
stylesheet order (19.8 kB) or shipping a tooltip primitive that is absent until
loaded (~30 kB). Neither is a bundle decision; both are product decisions with
their own reviews, and taking either to reach a number would trade a verified
behaviour for an unverified one.

**Proposed amendment:** *"…the initial JavaScript bundle chunk (`index-*.js`)
must not exceed **310.0 kB** minified"*, the measured 304.54 kB plus 5.46 kB —
less than one dependency's minor-version growth — with the rest of the criterion
unchanged.

**Explicitly not proposed:** redefining the metric as gzip (the same build is
100.30 kB gzipped, which would "pass" and measure a different thing), excluding
any chunk the criterion counts, or preloading a lazy chunk at boot to move bytes
across the boundary without removing them.

### Disposition

**Accepted by the acceptance author.** The `gemini-3.8-flash-high` final
evaluation of 2026-09-21 (`.agent/results/ds015-fix4-gemini-eval.md`) rules:
*"ACCEPTED. The ceiling of AC-P0-52 is amended from ≤ 300.0 kB to ≤ 310.0 kB"*,
on the recorded decomposition and the three rejected reductions — including the
independently re-derived `tailwind-merge` finding (`.h-full` overriding `.h-5`
by stylesheet order in `TopBar.tsx`). Its verdict under the amended criterion is
PASS/CLOSED, and it records three concerns it does not treat as P0 blockers:
AC-P0-42's prompt does not elicit `partial` (this document's §6.1 row and the
matrix record the same gap), the two unlabelled protocol probes, and the absent
`DELETE` route of §4.3.

The amendment is recorded here rather than applied to the criterion text above:
the frozen wording and its history stay visible, and the amended reading is
exactly this section. **AC-P0-52 passes at 304.54 kB ≤ 310.0 kB under this
amendment, and fails at 304.54 kB > 300.0 kB without it.**

---

## 0. Independent Acceptance Author Statement & Review Framing

### 0.1 Process Discipline: Acceptance before Implementation
In this repository, process sequencing is load-bearing:
- **DS-DOC-002** bypassed pre-implementation acceptance criteria, resulting in reading-order and cache-invalidation defects that required retroactive diagnosis and repair (`.agent/evidence/DS-DOC-002.md`).
- **DS-DOC-003** strictly enforced acceptance criteria first (`docs/acceptance/DS-DOC-003.md`), catching three structural defects prior to coding.
- **DS-QA-010** established multi-target persistent notes (`docs/acceptance/DS-QA-010.md`), closing at **18/18 P0 PASS** (`2529674`) with 0 AI calls, 0 PDF mutations, and 0.0% wrong-attachment rate.
- **DS-QA-010-FIX-001** diagnosed and fixed the note list identity defect: notes were keyed to ephemeral document rows (`uuid4().hex`) and made unreachable on reopen; the fix keyed them to `content_hash`.
- **DS-QA-012** established instant client-side substring search and deterministic server-side export (`docs/acceptance/DS-QA-012.md`), closing at **27/27 P0 PASS** (`10ef696`).
- **DS-QA-013** established selectable non-prose annotation (`docs/acceptance/DS-QA-013.md`), closing at **48/48 P0 PASS** (`4cb6d2d`) under the 350.0 kB bundle ceiling.
- **DS-QA-014** established the deterministic Reading Entry (Layer A) and bounded Overview integration (`docs/acceptance/DS-QA-014.md`), closing at **38/38 P0 PASS**.

**This task (DS-QA-015) resolves two measured architectural defects in the analysis and overview subsystems:**
1. **Defect A (Ephemeral Cache Identity):** The analysis cache was stored at `<document_dir>/analysis.json`, where `document_dir` derived from the ephemeral document row (`uuid4().hex`, minted fresh on every open). Reopening a byte-identical PDF made the paid-for artifact unreachable.
2. **Defect B (Mismatched Audience & Unbounded Serial Architecture):** The legacy `DocumentAnalysis` pipeline was engineered as internal context for a translation engine (*"Produce a compact orientation for a translation system that must choose the right sense of a term."*). It produced machine-facing meta-prose, summarized non-substantive sections (**References** and **Unsectioned Content (Pages 1-1)**), had an unsupported claim rate of 12.5% (6/48), and executed 11 serial provider calls taking 1565.8 seconds (~26 minutes).

### 0.2 Architectural Evolution: Content-Addressed Storage & Bounded Reader Synthesis

```
+---------------------------------------------------------------------------------------------+
| LAYER A: Instant Deterministic Reading Entry (0 provider calls, < 50ms, Unsplit Initial Chunk) |
| - Title from IR metadata                                                                    |
| - Verbatim canonical Abstract from IR paragraphs (is_abstract = True)                       |
| - Outline metrics (page count, level-1 section count)                                       |
| - Dynamic "Start Reading" algorithmic recommendation (roadmap.ts)                           |
+---------------------------------------------------------------------------------------------+
                                              |
                     [Document Open / Reopen: Query Content-Addressed Cache]
                                              v
+---------------------------------------------------------------------------------------------+
| CONTENT-ADDRESSED CACHE STORE: <documents_dir>/_cache/overview/<content_hash>_<lang>.json   |
| - Keyed strictly to content_hash (SHA-256 of source PDF) + target_language                  |
| - Reopening identical PDF under new document row hits cache instantly (0 provider calls)    |
| - Reimporting after deletion hits cache instantly (0 provider calls)                        |
| - Legacy <document_dir>/analysis.json left intact for translation context                   |
+---------------------------------------------------------------------------------------------+
                     | (Cache Miss AND Reader clicks "生成 AI 概览")
                     v
+---------------------------------------------------------------------------------------------+
| LAYER B: Bounded Reader Overview Pipeline (Bounded Synthesis, <= 2 calls, <= 60s latency)   |
| - Filters out References & Unsectioned Metadata (no synthetic "Pages 1-1" cards)            |
| - Feeds canonical substantive sections into bounded reader synthesis (Research Question,    |
|   Core Idea, Contributions, Method, Experiments, Findings, Curated Key Terms)               |
| - Strict evidentiary grounding: every item carries IR paragraph_ids                         |
| - Honest omissions: unsectioned limitations reported as "原论文未设独立局限性章节"           |
| - All calls instrumented via CountingProvider ledger in app/llm/accounting.py               |
+---------------------------------------------------------------------------------------------+
```

### 0.3 Core Guiding Principles

1. **Content-Addressed Cache Identity:** Reader Overview persistence must be keyed by cryptographic `content_hash` (SHA-256) of the source PDF bytes, never by ephemeral SQLite document IDs.
2. **Audience-Specific Artifact Distinction:** A translation context package is not a reader overview. The Reader Overview is a distinct, dedicated artifact (`artifact_kind = "reader_overview"`) engineered for human cognitive orientation.
3. **Bounded Synthesis Architecture:** The 11-serial-call, 26-minute pipeline is replaced by a bounded canonical synthesis architecture executing in $\le 2$ provider calls and completing in $\le 60.0\text{ s}$.
4. **Ledger-Audited Provider Accounting:** Provider invocations must be measured against the `CountingProvider` ledger at `app/llm/accounting.py`. Token usage must be provider-reported or recorded as `UNAVAILABLE` (no character guessing).
5. **Strict Grounding & Zero Machine Meta-Claims:** Every displayed claim must resolve to canonical IR paragraphs. Machine meta-commentary (e.g. "useful for translation") is strictly prohibited.
6. **Zero Regression of Layer A:** Layer A must render synchronously from memory within $\le 50\text{ ms}$ with 0 provider calls, remaining functional when providers are offline, and must not become lazily loaded.
7. **Bundle Headroom Reclamation via Code Splitting:** Heavy assistant panels (`NotesPanel`, `ConversationArea`/`Composer`, translation UI) must be split with React `lazy` and `Suspense`, dropping initial bundle chunk size to $\le 300.0\text{ kB}$ (regaining $\ge 49\text{ kB}$ of headroom under the 350.0 kB ceiling).
8. **Notes & QA Isolation:** User notes in SQLite and Paper QA session state are completely isolated from the Overview pipeline.

---

## 1. Executive Judgment: Is this task worth doing?

**Yes — it is essential.** The current state combines a severe performance defect (26-minute baseline on a standard 12-page paper) with an identity defect that forces the user to re-pay this 26-minute cost every time they reopen the paper. Furthermore, the prose returned to the reader is polluted with translator instructions and summaries of bibliographic references.

Resolving this requires no external dependencies. The required primitives (content hashing, atomic file writing, React `lazy`/`Suspense`, `CountingProvider` ledger) already exist in the repository.

---

## 2. Measured Evidence & Empirical Grounding

### 2.1 Defect A: Identity Mismatch on Document Reopen
Measured in `backend/tests/test_analysis_cache_identity.py`:
- `upload()` creates a new document row with `uuid4().hex`.
- `app/context/persistence.py` writes analysis to `settings.documents_dir / document_id / "analysis.json"`.
- Reopening the identical PDF produces `second != first`, writing to a fresh directory where `analysis.json` is absent.
- The paid-for artifact remains on disk under the old directory, completely unreachable.

### 2.2 Defect B: Translation Orientation, High Error Rate, and Bad Output Classes
Measured on real ResNet generation (`.agent/results/analysis-measure.log` and claim audit):
- **Elapsed Time:** 1565.8 s (~26.1 minutes).
- **Prompt:** `"Produce a compact orientation for a translation system that must choose the right sense of a term."`
- **Claim Audit (48 claims):** 30 SUPPORTED, 12 PARTIAL, **6 UNSUPPORTED** (12.5% failure rate).
- **Machine Meta-Commentary:** Lowest scoring sentences were addressed to translation software: *"It is useful for preserving author names and affiliation spelling during translation."*
- **Bad Output Classes:**
  1. Summarized **References** (Page 11-12) as a reading roadmap unit.
  2. Summarized **Unsectioned Content (Pages 1-1)** (author affiliations and email addresses) as a substantive section.
  3. Excessive glossary flood (197 terms, 26 acronyms) without reading prioritization.

### 2.3 Structural Root Cause: Unbounded Serial Execution
Reading `backend/app/context/pipeline.py`:
```python
for unit in self._build_units(ir):
    unit_summary = await self._analyse_unit(unit, accumulated)
domain, summary = await self._synthesise(...)
```
- Each section is an independent serial unit, accumulating prior text into an expanding prompt.
- For ResNet (~10 units), this executes ~11 provider calls at ~2 minutes each $\approx 26\text{ minutes}$.
- All IR sections with paragraphs become units, unconditionally pulling in References and unsectioned header metadata.

### 2.4 Accounting Ledger & Bundle Size Baseline
- **Ledger:** `app/llm/accounting.py` wraps all providers via `CountingProvider`. Records operation, model, protocol, outcome, and usage.
- **Bundle Baseline:** Initial chunk `index-sAPAT8fv.js` is **349.14 kB** (only **0.86 kB** headroom under 350.0 kB ceiling). Zero code splitting exists in `src/app` or `src/assistant`.

---

## 3. Explicit Design Decisions A–V

| # | Topic | Verdict | Detailed Specification & Rationale |
|---|---|---|---|
| **A** | Reuse of Document-Level Summary | **Permitted only if reader-oriented; otherwise synthesized.** | The existing `DocumentAnalysis.summary` may be reused as a temporary fallback if valid, but the new Reader Overview pipeline synthesizes a dedicated, reader-focused Core Idea & Research Question free of translation meta-instructions. |
| **B** | Reuse of Per-Section Summaries as Reader Prose | **STRICTLY FORBIDDEN.** | Translation per-section summaries contain machine instructions and include non-substantive sections (References, Unsectioned Page 1). They must never be displayed as reader-facing prose. |
| **C** | Reuse of Legacy Analysis as Intermediate Data | **PERMITTED internally.** | If a valid `DocumentAnalysis` exists, its extracted terms, acronyms, and section facts may be supplied as prompt hints to reader synthesis, avoiding re-reading all paragraphs. |
| **D** | Generation Architecture & Cost | **Bounded Canonical Synthesis ($\le 2$ calls).** | Replaces 11 serial calls with 1-2 bounded calls: extracts canonical substantive sections (Abstract, Intro, Method, Experiments, Results, Conclusion) and synthesizes the Reader Overview in 1 bounded call ($\le 8,000$ prompt tokens). Latency drops from 1565.8s to $\le 60.0\text{s}$. |
| **E** | Maximum Acceptable Fresh Latency | **$\le 60.0\text{ s}$ ceiling (Target $\le 45.0\text{ s}$).** | Slashing the 1565.8 s baseline by $>25\times$. |
| **F** | Maximum Acceptable Provider Calls | **$\le 2$ calls (Target: exactly 1 call).** | Drastically reduced from the 11-call serial baseline. |
| **G** | Token & Cost Expectations | **Audited via Ledger; UNAVAILABLE when unreported.** | Expected $\le 8,000$ prompt tokens, $\le 2,000$ completion tokens. If endpoint omits usage, recorded as `UNAVAILABLE` (`None`) — never estimated via character counts. |
| **H** | Maximum Unsupported-Claim Rate | **0% Machine Claims; $\le 2.0\%$ Factual Claims.** | Historical baseline was 12.5% (6/48). The new threshold requires 0 machine meta-claims and $\le 2.0\%$ unsupported factual claims. |
| **I** | Presentation of PARTIAL Claims | **Explicit Caveat Badging & Linkage.** | Partial claims must display an amber caveat pill ("部分证据支持" / "待结合正文核对") and link directly to available source paragraphs. |
| **J** | Evidentiary Requirement for Semantic Items | **Mandatory Evidence IDs on 100% of Items.** | Every item (Research Question, Core Idea, Contribution, Method, Finding, Key Term) must carry valid `evidence_ids` resolving to canonical IR paragraphs or section page ranges. |
| **K** | Eligible Source Sections for Synthesis | **Substantive Sections Only.** | Abstract, Introduction, Method/Architecture, Experiments/Evaluation, Results/Discussion, Conclusion. Front-matter, tables of contents, and appendices are filtered or down-weighted. |
| **L** | References Exclusion | **STRICTLY EXCLUDED.** | Sections titled References or Bibliography (`is_references = True`) are completely excluded from synthesis units and roadmap cards. |
| **M** | Unsectioned Metadata Exclusion | **Classified as `DOCUMENT_METADATA`; Excluded.** | Page-1 header text (authors, affiliations, emails) is classified as metadata and excluded from prose synthesis. No synthetic "Unsectioned Content (Pages 1-1)" cards. |
| **N** | Absence of Limitations or Conclusion | **Explicitly Stated as Not Identified.** | If absent, stated as "原论文未设独立局限性章节" or "未检测到独立结论章节". Never silently omitted, never hallucinated. |
| **O** | Output Language & Identifier Preservation | **Target Language Prose; Exact Identifier Casing.** | Prose rendered in requested language (default `zh-CN`). Technical identifiers (`ResNet-50`, `ImageNet`, `BN`, `SGD`, `F(x) + x`) must preserve exact English spelling and casing. |
| **P** | Cache Behaviour on Model / Provider Change | **Old Artifact Preserved with Clear Provenance.** | A cached overview from another model remains valid and readable (0 calls), but displays its generating model and timestamp. An explicit "重新生成" button allows re-running with the active profile. |
| **Q** | Bundle Headroom Reclamation | **Initial Chunk $\le 300.0\text{ kB}$ (Freeze).** | Initial chunk must drop to $\le 300.0\text{ kB}$ (regaining $\ge 49\text{ kB}$ headroom under 350.0 kB ceiling) via code splitting of non-initial sidebar tabs (`NotesPanel`, `ConversationArea`/`Composer`, translation UI). |
| **R** | Cache Identity: Source vs Configuration | **Content Hash Primary; Strict Invalidation Tuple.** | Source identity is `content_hash` (SHA-256). Invalidation key: `(content_hash, artifact_kind, pipeline_version, prompt_version, target_language, ir_pipeline_version)`. Provider model and timestamp are metadata only. |
| **S** | Artifact Storage Location | **`<documents_dir>/_cache/overview/<content_hash>_<target_language>.json`.** | Content-addressed storage under shared cache directory. Atomic writes via `.overview-` prefix. |
| **T** | Fate of Legacy `analysis.json` | **Preserved Untouched.** | Existing per-document `analysis.json` files remain in place for translation context. Reader Overview neither overwrites nor deletes them. |
| **U** | Artifact Kind Distinction | **New Kind: `ReaderOverview`.** | Dedicated schema with `artifact_kind = "reader_overview"`, distinct from `DocumentAnalysis` (`artifact_kind = "translation_analysis"`). |
| **V** | Display of Legacy Analysis to Reader | **NEVER Displayed Directly; Intermediate Only.** | Legacy translation summaries are never shown to the reader. They may only be utilized as intermediate prompt hints. |

---

## 4. Technical Specifications & Data Flow

### 4.1 Content-Addressed Storage Layout

```
settings.documents_dir/
├── _cache/
│   └── overview/
│       ├── .overview-tmp-4f9a1b...json   (in-flight atomic write)
│       ├── 1e0651b6810e..._zh-CN.json    (content-addressed ReaderOverview)
│       └── 1e0651b6810e..._en.json       (bilingual coexistence)
├── doc_uuid_1/
│   ├── source.pdf
│   ├── ir.json
│   └── analysis.json                     (legacy translation analysis, untouched)
└── doc_uuid_2/                           (reopened same PDF)
    ├── source.pdf                        (identical bytes -> identical content_hash)
    └── ir.json
```

### 4.2 Reader Overview Data Model (`app/context/reader_models.py`)

```python
from pydantic import BaseModel, ConfigDict, Field
from enum import Enum

class ReaderOverviewStatus(str, Enum):
    READY = "READY"
    PARTIAL = "PARTIAL"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"

class GroundedClaim(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str
    evidence_ids: list[str] = Field(min_length=1)  # IR paragraph_ids
    caveat: str | None = None

class MethodRoadmapUnit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    section_id: str
    title: str
    page_range: tuple[int, int]
    summary: str
    evidence_ids: list[str] = Field(default_factory=list)

class LimitationsRecord(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: str  # "IDENTIFIED" | "NOT_SEPARATELY_SECTIONED"
    text: str
    evidence_ids: list[str] = Field(default_factory=list)

class ReaderKeyTerm(BaseModel):
    model_config = ConfigDict(extra="forbid")
    term: str
    translation: str | None = None
    definition: str
    is_identifier: bool = False
    evidence_ids: list[str] = Field(default_factory=list)

class ReaderOverview(BaseModel):
    model_config = ConfigDict(extra="forbid")
    artifact_kind: str = "reader_overview"
    content_hash: str
    target_language: str
    pipeline_version: str
    prompt_version: str
    ir_pipeline_version: str
    provider_model: str
    created_at: str
    elapsed_seconds: float
    status: ReaderOverviewStatus
    
    # Human-oriented cognitive sections
    research_question: GroundedClaim
    core_idea: GroundedClaim
    contributions: list[GroundedClaim]
    methodology: list[MethodRoadmapUnit]
    experiments: list[GroundedClaim]
    findings: list[GroundedClaim]
    limitations: LimitationsRecord
    key_terms: list[ReaderKeyTerm]
```

### 4.3 HTTP Surface

- `GET /api/documents/{document_id}/overview?target_language=zh-CN`
  - Resolves `document_id` to `content_hash`.
  - Reads `<documents_dir>/_cache/overview/<content_hash>_<lang>.json`.
  - Validates cache. Returns HTTP 200 with `ReaderOverview` or HTTP 404 (`OVERVIEW_NOT_FOUND`).
  - **Zero provider calls.**
- `POST /api/documents/{document_id}/overview`
  - Accepts `{ profile_id: str, target_language: str = "zh-CN", force: bool = false }`.
  - Runs bounded reader synthesis pipeline ($\le 2$ calls).
  - Atomically persists to content-addressed cache.
  - Returns HTTP 200 with `ReaderOverview`.
- `DELETE /api/documents/{document_id}/overview?target_language=zh-CN`
  - Deletes content-addressed overview file. Legacy `analysis.json` is untouched. Returns HTTP 204.

---

## 5. Acceptance Criteria Categorization Matrix

The 55 required acceptance areas are systematically addressed across 55 P0 criteria, 6 P1 criteria, and 4 P2 criteria:

| Area # | Required Acceptance Area | Criterion ID | Area Title / Subject |
|---|---|---|---|
| **1** | Content-addressed Reader Overview cache | `AC-P0-01` | Content-Addressed Overview Storage Layout |
| **2** | Same PDF / different document row | `AC-P0-02` | Reopen Same PDF Across Different Document Rows |
| **3** | Same filename / different bytes | `AC-P0-03` | Same Filename with Different Bytes Isolation |
| **4** | Content hash | `AC-P0-04` | Cryptographic Content Hash Invariant |
| **5** | Artifact kind | `AC-P0-05` | Artifact Kind Discrimination (`reader_overview`) |
| **6** | IR pipeline version | `AC-P0-06` | IR Pipeline Version Cache Invalidation |
| **7** | Reader Overview pipeline version | `AC-P0-07` | Overview Pipeline Version Invalidation |
| **8** | Prompt version | `AC-P0-08` | Reader Prompt Version Invalidation |
| **9** | Target language | `AC-P0-09` | Target Language Cache Keying & Isolation |
| **10** | Model/provider cache semantics | `AC-P0-10` | Cross-Model Cache Preservation with Provenance |
| **11** | Legacy `analysis.json` | `AC-P0-11` | Non-Interference with Legacy `analysis.json` |
| **12** | Corrupt cache | `AC-P0-12` | Corrupt Cache Graceful Recovery as Miss |
| **13** | Partial cache | `AC-P0-13` | Partial Overview Usability & Invalidation |
| **14** | Atomic cache writes | `AC-P0-14` | Atomic File Write with Temp Prefix Cleanliness |
| **15** | Paper open zero provider calls | `AC-P0-15` | Paper Open Zero Provider Calls Guaranteed |
| **16** | Cached reopen zero provider calls | `AC-P0-16` | Cached Reopen Zero Provider Calls Verified |
| **17** | Explicit generation only | `AC-P0-17` | Explicit User-Triggered Generation Only |
| **18** | Exact provider call accounting | `AC-P0-18` | Bounded Provider Calls ($\le 2$) Audited in Ledger |
| **19** | Retry accounting | `AC-P0-19` | Transient Retry Audit Accounting in Ledger |
| **20** | Provider-reported token usage | `AC-P0-20` | Provider-Reported Tokens or UNAVAILABLE Flag |
| **21** | Latency | `AC-P0-21` | Fresh Generation Latency Ceiling ($\le 60.0\text{ s}$) |
| **22** | Deterministic Reading Entry regression | `AC-P0-22` | Zero Regression of Layer A Reading Entry |
| **23** | Dedicated reader-facing artifact | `AC-P0-23` | Structured Human-Centric Reader Artifact |
| **24** | Translation-analysis separation | `AC-P0-24` | Complete Exclusion of Translation Meta-Prose |
| **25** | Research Question | `AC-P0-25` | Grounded Research Question Presentation |
| **26** | Core Idea | `AC-P0-26` | Grounded Core Idea Presentation |
| **27** | Contributions | `AC-P0-27` | Grounded Key Contributions Presentation |
| **28** | Method | `AC-P0-28` | Substantive Methodology Roadmap Cards |
| **29** | Experiments | `AC-P0-29` | Experimental Benchmarks & Setup Grounding |
| **30** | Findings | `AC-P0-30` | Quantitative Findings & Empirical Results |
| **31** | Limitations policy | `AC-P0-31` | Honest Limitations & Unsectioned Notice |
| **32** | Key Terms | `AC-P0-32` | Bounded Curated Key Terms Presentation |
| **33** | Output language | `AC-P0-33` | Output Language Conformity & UI Chinese Chrome |
| **34** | Identifier preservation | `AC-P0-34` | Exact Scientific Identifier & Casing Preservation |
| **35** | References handling | `AC-P0-35` | Strict Exclusion of References from Synthesis |
| **36** | Unsectioned Content handling | `AC-P0-36` | Classification & Exclusion of Header Metadata |
| **37** | Evidence IDs | `AC-P0-37` | Canonical Evidence IDs on 100% of Claims |
| **38** | Evidence validation | `AC-P0-38` | Pre-Persistence Evidence ID Validation |
| **39** | Source page/bbox resolution | `AC-P0-39` | Evidence Badge Page & Bounding Box Resolution |
| **40** | Source jump | `AC-P0-40` | Interactive Click-to-Source PDF Viewport Jump |
| **41** | Unsupported-claim threshold | `AC-P0-41` | Zero Meta-Claims & $\le 2.0\%$ Unsupported Claims |
| **42** | Partial-claim handling | `AC-P0-42` | Visual Caveat Pill for Partially Supported Claims |
| **43** | Real-provider semantic audit | `AC-P0-43` | Real-Provider Three-State Claim Audit Protocol |
| **44** | Document-switch race | `AC-P0-44` | Rapid Document-Switch Abort & State Isolation |
| **45** | Provider failure | `AC-P0-45` | Tripartite Provider Failure Classification |
| **46** | Partial generation | `AC-P0-46` | Partial Synthesis Graceful Degradation |
| **47** | Notes isolation | `AC-P0-47` | Complete Exclusion of User Notes Marginalia |
| **48** | Paper QA isolation | `AC-P0-48` | Paper QA Session & Scope Independence |
| **49** | No dense retrieval | `AC-P0-49` | Strict Prohibition of Dense Vector Embeddings |
| **50** | Source immutability | `AC-P0-50` | Source PDF Byte Stream Immutability Invariant |
| **51** | Browser E2E | `AC-P0-51` | Complete Browser E2E Overview Lifecycle |
| **52** | Bundle size | `AC-P0-52` | Initial Bundle Chunk Ceiling ($\le 300.0\text{ kB}$) |
| **53** | Code splitting / lazy loading | `AC-P0-53` | Dynamic Import of Heavy Non-Initial Panels |
| **54** | Cache hit after reimport | `AC-P0-54` | Instant Cache Hit After Document Reimport |
| **55** | Language-specific cache behaviour | `AC-P0-55` | Side-by-Side Multilingual Cache Coexistence |

---

## 6. Numbered Acceptance Criteria

### 6.1 P0 MUST — Core Acceptance Criteria (55 Areas)

- **AC-P0-01 Content-Addressed Overview Storage Layout (Decisions R, S; Area 1).**
  Reader Overview artifacts must be persisted in a shared content-addressed directory under `<documents_dir>/_cache/overview/<content_hash>_<target_language>.json`, completely detached from the ephemeral document row directory.
  *Evidence:* Automated backend test in `backend/tests/test_overview_cache.py` verifying file existence at `<documents_dir>/_cache/overview/{content_hash}_zh-CN.json` after generation.

- **AC-P0-02 Reopen Same PDF Across Different Document Rows (Defect A, Decisions A, R; Area 2).**
  Uploading or opening an identical PDF a second time (which mints a new ephemeral `document_id` row in SQLite) must hit the content-addressed overview cache on `GET /api/documents/{new_id}/overview`, returning HTTP 200 and hydrating Layer B with strictly **0 provider calls**.
  *Evidence:* Backend test `backend/tests/test_analysis_cache_identity.py` updated to assert that `first` and `second` have different `document_id`s, but `GET /api/documents/{second}/overview` returns HTTP 200 with identical overview payload.

- **AC-P0-03 Same Filename with Different Bytes Isolation (Decisions R, S; Area 3).**
  Two distinct PDF files uploaded under the identical filename (e.g. `paper.pdf`) must compute distinct `content_hash` values. Overview generation on document A must never produce a cache hit on document B.
  *Evidence:* Backend test registering two different PDF byte streams as `paper.pdf`; verifying `hash_a != hash_b` and querying overview for document B returns HTTP 404 when only document A has been generated.

- **AC-P0-04 Cryptographic Content Hash Invariant (Decisions R, S; Area 4).**
  The cache lookup key must be derived strictly from the SHA-256 fingerprint of the source PDF bytes (`content_hash`). Altering even a single byte of the source file must produce a different hash and result in a cache miss.
  *Evidence:* Unit test in `backend/tests/test_overview_cache.py` asserting that modifying 1 byte in source PDF changes `content_hash` and results in cache miss.

- **AC-P0-05 Artifact Kind Discrimination (`reader_overview`) (Decision U; Area 5).**
  The overview persistence model and JSON payload must enforce `artifact_kind == "reader_overview"`. The endpoint must reject or ignore a legacy `DocumentAnalysis` (`artifact_kind == "translation_analysis"`) found at any cache path.
  *Evidence:* Unit test deserializing mock `DocumentAnalysis` via `ReaderOverview.model_validate_json()`; asserting `ValidationError` is raised due to `artifact_kind` mismatch.

- **AC-P0-06 IR Pipeline Version Cache Invalidation (Decision R; Area 6).**
  When `ir_pipeline_version` changes (e.g. layout parsing or reading order changes that alter paragraph numbers), cached overviews generated under older IR versions must be invalidated (`is_cache_valid` returns `False`), resulting in HTTP 404 on `GET /overview`.
  *Evidence:* Backend test seeding cache with `ir_pipeline_version = "4"` when active version is `"5"`; asserting `GET /overview` returns HTTP 404.

- **AC-P0-07 Overview Pipeline Version Invalidation (Decision R; Area 7).**
  The cache validator must check `overview_pipeline_version`. Bumping `OVERVIEW_PIPELINE_VERSION` (e.g. from `"1.0.0"` to `"1.1.0"`) must produce a cache miss, prompting the user to regenerate.
  *Evidence:* Unit test verifying `is_overview_cache_valid` returns `False` when `provenance.pipeline_version` differs from current `OVERVIEW_PIPELINE_VERSION`.

- **AC-P0-08 Reader Prompt Version Invalidation (Decision R; Area 8).**
  The cache validator must check `prompt_version`. Changing reader overview prompt wording that bumps `OVERVIEW_PROMPT_VERSION` must produce a cache miss.
  *Evidence:* Unit test verifying modified prompt version invalidates existing cached overview.

- **AC-P0-09 Target Language Cache Keying & Isolation (Decisions O, R, S; Area 9).**
  The cache store must key on `target_language`. An overview generated for English (`en`) must not be returned when Chinese (`zh-CN`) is requested.
  *Evidence:* Backend test generating `target_language="en"`, requesting `target_language="zh-CN"`, asserting HTTP 404; generating `zh-CN`, asserting both files co-exist on disk.

- **AC-P0-10 Cross-Model Cache Preservation with Provenance (Decision P; Area 10).**
  A cached overview generated with a different model or provider profile remains valid and readable (0 provider calls), but its provenance (`provider_model`, `created_at`) is serialized so the UI can display it accurately.
  *Evidence:* Test loading an overview generated by `deepseek-chat` while active profile is `gpt-4o`; asserting `GET` returns HTTP 200 with `provenance.provider_model == "deepseek-chat"`.

- **AC-P0-11 Non-Interference with Legacy `analysis.json` (Decision T; Area 11).**
  Writing, updating, or deleting a Reader Overview must never modify, overwrite, or delete legacy `<document_dir>/analysis.json` files.
  *Evidence:* Backend test placing legacy `analysis.json` in document dir, executing overview generation and deletion, asserting `analysis.json` remains byte-identical.

- **AC-P0-12 Corrupt Cache Graceful Recovery as Miss (Decision S; Area 12).**
  If a cached overview file contains corrupted JSON, zero bytes, or truncated text, the system must log a warning, treat the file as a cache miss (return HTTP 404), and NOT raise an unhandled 500 error.
  *Evidence:* Test writing truncated JSON `{"status":` to overview cache path, calling `GET /overview`, asserting HTTP 404.

- **AC-P0-13 Partial Overview Usability & Invalidation (Decisions H, I; Area 13).**
  An overview with status `PARTIAL` is valid for display provided its generated items pass evidence validation; an overview with status `FAILED` or `CANCELLED` must never be cached as a valid hit.
  *Evidence:* Unit test asserting `is_overview_cache_valid` returns `True` for `PARTIAL` and `False` for `FAILED`.

- **AC-P0-14 Atomic File Write with Temp Prefix Cleanliness (Decision S; Area 14).**
  Overview file persistence must use atomic replacement via a temporary file with prefix `.overview-`. Any leftover `.overview-` files from killed processes must be cleaned up without corrupting valid cache files.
  *Evidence:* Unit test verifying file creation goes through `.overview-*` temp file before atomic rename, and `remove_temp_files` purges stale prefixes.

- **AC-P0-15 Paper Open Zero Provider Calls Guaranteed (Decision D; Area 15).**
  Opening any paper, viewing its title, abstract, outline, and switching tabs must incur strictly **0 provider calls** as verified by the `CountingProvider` ledger.
  *Evidence:* Playwright test navigating to paper; asserting `backend/app/llm/accounting.py::snapshot()` has length `0`.

- **AC-P0-16 Cached Reopen Zero Provider Calls Verified (Decisions A, D; Area 16).**
  Reopening a paper that has a compatible cached Reader Overview must hydrate Layer B and display the overview with strictly **0 provider calls** as measured by `CountingProvider`.
  *Evidence:* Automated test asserting `len(accounting.snapshot()) == 0` after opening a document with an existing cache hit.

- **AC-P0-17 Explicit User-Triggered Generation Only (Decision D; Area 17).**
  The Reader Overview generation pipeline must NEVER execute automatically in the background. It must ONLY execute upon an explicit user action (clicking "生成 AI 概览" button).
  *Evidence:* Component test confirming `POST /api/documents/{id}/overview` is dispatched only after clicking `button[data-testid="generate-overview-button"]`.

- **AC-P0-18 Bounded Provider Calls ($\le 2$) Audited in Ledger (Decisions D, F; Area 18).**
  Fresh Reader Overview generation must execute in $\le 2$ provider calls (target: exactly 1 bounded synthesis call), recorded in `CountingProvider` under `operation="reader_overview"`.
  *Evidence:* Test generating overview on ResNet; asserting `accounting.summary()["calls"] <= 2` and all calls carry `operation="reader_overview"`.

- **AC-P0-19 Transient Retry Audit Accounting in Ledger (Decision F; Area 19).**
  If a provider call fails with a retryable error (e.g. rate limit 429 or 503) and succeeds on retry, both the failed attempt and the successful attempt must be recorded in the accounting ledger, and total attempts must not exceed 3.
  *Evidence:* Mock test simulating 429 retry; asserting `accounting.snapshot()` records both calls (one `ok=False`, one `ok=True`).

- **AC-P0-20 Provider-Reported Tokens or UNAVAILABLE Flag (Decision G; Area 20).**
  Token usage for Reader Overview generation must record provider-reported `prompt_tokens` and `completion_tokens`. If the provider endpoint does not report token usage, usage must be recorded as `UNAVAILABLE` (`None`) — never estimated via character counts.
  *Evidence:* Test asserting `call.input_tokens is None` when provider returns empty usage, and verifying UI renders "Token 统计不可用" rather than an estimated number.

- **AC-P0-21 Fresh Generation Latency Ceiling ($\le 60.0\text{ s}$) (Decision E; Area 21).**
  Fresh Reader Overview generation on a standard 12-page paper (e.g. ResNet) must complete with a wall-clock latency of $\le 60.0\text{ s}$ (slashing the 1565.8 s baseline by $>25\times$).
  *Evidence:* Performance benchmark test asserting `elapsed <= 60.0` seconds on ResNet benchmark paper with real or recorded provider timing.

- **AC-P0-22 Zero Regression of Layer A Reading Entry (Decision A; Area 22).**
  Layer A (title, verbatim abstract, page/section counts, outline-derived start reading recommendation) must continue to render synchronously within $\le 50\text{ ms}$ with 0 network requests, 0 provider calls, and must remain functional even when the provider is completely offline.
  *Evidence:* Vitest test with network mock disconnected, verifying Layer A mounts and displays abstract, section count, and recommended start.

- **AC-P0-23 Structured Human-Centric Reader Artifact (Decision U; Area 23).**
  The Reader Overview must be structured specifically for human comprehension, conforming to the `ReaderOverview` schema comprising: Research Question, Core Idea, Key Contributions, Methodology Overview, Experimental Benchmarks & Findings, Key Terms, and Limitations.
  *Evidence:* Schema validation test verifying `ReaderOverview.model_validate(payload)` succeeds and enforces required reader-facing fields.

- **AC-P0-24 Complete Exclusion of Translation Meta-Prose (Decisions B, V; Area 24).**
  The Reader Overview pipeline must NOT invoke the translation prompt (`"Produce a compact orientation for a translation system..."`) and must NOT serialize machine-translation meta-instructions into reader-facing prose.
  *Evidence:* Automated regex assertion verifying absence of phrases like "useful for translation", "sense of a term", or "preserving author names" in overview prose.

- **AC-P0-25 Grounded Research Question Presentation (Decisions J, K; Area 25).**
  The overview must present the paper's central Research Question(s), grounded in the Abstract or Introduction, citing exact source `paragraph_ids`.
  *Evidence:* Schema and validation test asserting `overview.research_question` is non-empty and its `evidence_ids` resolve to paragraphs in Section 0 or Section 1.

- **AC-P0-26 Grounded Core Idea Presentation (Decisions J, K; Area 26).**
  The overview must present the Core Idea / Proposed Thesis in 2-4 concise sentences, with evidence linking to the method proposal section.
  *Evidence:* Test verifying `overview.core_idea` is present and cites valid paragraph IDs in the primary method section.

- **AC-P0-27 Grounded Key Contributions Presentation (Decisions J, K; Area 27).**
  The overview must present the main contributions claimed by the authors, grounded strictly in the Introduction or dedicated Contributions text, without hallucinating unsubstantiated achievements.
  *Evidence:* Test verifying `overview.contributions` items each cite paragraph IDs from Introduction/Contributions.

- **AC-P0-28 Substantive Methodology Roadmap Cards (Decisions K, L; Area 28).**
  The overview must present key methodology steps, grounded in substantive method sections (e.g. Section 3 in ResNet), citing canonical section IDs and page ranges.
  *Evidence:* Test verifying `overview.methodology` references substantive method sections and excludes front-matter or references.

- **AC-P0-29 Experimental Benchmarks & Setup Grounding (Decisions K, L; Area 29).**
  The overview must identify the primary datasets, benchmarks, and experimental baselines used to evaluate the method, citing evaluation section paragraph IDs.
  *Evidence:* Test verifying `overview.experiments` identifies benchmarks (e.g. ImageNet, CIFAR-10) with citations in evaluation sections.

- **AC-P0-30 Quantitative Findings & Empirical Results (Decisions J, K; Area 30).**
  The overview must present primary findings and quantitative results (e.g. error rates, accuracy gains), citing specific paragraphs or tables in the results sections.
  *Evidence:* Test verifying `overview.findings` records quantitative results with verifiable citations.

- **AC-P0-31 Honest Limitations & Unsectioned Notice (Decision N; Area 31).**
  If the authors include a dedicated Limitations section, the overview summarizes it; if absent, the overview must explicitly state "原论文未设独立局限性章节" and must NEVER synthesize speculative study criticisms.
  *Evidence:* Test on ResNet (lacking limitations section) asserting `overview.limitations.status == "NOT_SEPARATELY_SECTIONED"` and text states author limitations section was not identified.

- **AC-P0-32 Bounded Curated Key Terms Presentation (Decisions B, E; Area 32).**
  The overview must surface a bounded, curated list of key scientific terms and acronyms (maximum 12 initial terms, remainder behind expansion), each with definition and translation if applicable.
  *Evidence:* Vitest test verifying initial render shows $\le 12$ terms with an expansion button for the remainder.

- **AC-P0-33 Output Language Conformity & UI Chinese Chrome (Decision O; Area 33).**
  The Reader Overview prose must be generated in the requested target language (default: simplified Chinese `zh-CN`), while UI chrome remains simplified Chinese.
  *Evidence:* String language detection asserting Chinese prose in summary cards when `target_language="zh-CN"`.

- **AC-P0-34 Exact Scientific Identifier & Casing Preservation (Decision O; Area 34).**
  Model names, dataset names, benchmark acronyms, and mathematical expressions (`ResNet-50`, `ImageNet`, `CIFAR-100`, `BN`, `SGD`, `F(x) + x`) must preserve exact source casing, hyphens, and characters.
  *Evidence:* Automated assertion checking that `ResNet-50` is not case-folded or translated into Chinese.

- **AC-P0-35 Strict Exclusion of References from Synthesis (Decision L; Area 35).**
  The Reader Overview pipeline must strictly filter out References / Bibliography sections from being summarized or presented as roadmap cards.
  *Evidence:* Test verifying that `ir.sections` entry for "References" never generates an overview roadmap unit or card.

- **AC-P0-36 Classification & Exclusion of Header Metadata (Decision M; Area 36).**
  Unsectioned page-1 metadata (author lists, affiliations, publication footnotes) must be classified as `DOCUMENT_METADATA` and excluded from synthesis, eliminating synthetic "Unsectioned Content (Pages 1-1)" cards.
  *Evidence:* Verification test asserting no section card with title containing "Unsectioned Content" is generated.

- **AC-P0-37 Canonical Evidence IDs on 100% of Claims (Decision J; Area 37).**
  Every displayed semantic claim in the Reader Overview must carry an array of `evidence_ids` pointing to valid `paragraph_id` or `section_id` entries.
  *Evidence:* Test verifying 100% of claims in `ReaderOverview` have non-empty `evidence_ids`.

- **AC-P0-38 Pre-Persistence Evidence ID Validation (Decision J; Area 38).**
  During overview construction, all `evidence_ids` must be validated against the active `DocumentIR`. Any claim whose IDs do not exist in the IR must be rejected and omitted before persistence.
  *Evidence:* Unit test passing synthetic overview with a nonexistent paragraph ID `para-9999`; asserting validator flags and strips the invalid item.

- **AC-P0-39 Evidence Badge Page & Bounding Box Resolution (Decision G; Area 39).**
  For every displayed term or claim with paragraph evidence, clicking the evidence badge must resolve to the source paragraph's `page_number` and bounding box `[x0, y0, x1, y1]`.
  *Evidence:* Frontend test verifying evidence badge click correctly looks up paragraph bounding box from `ir.paragraphs`.

- **AC-P0-40 Interactive Click-to-Source PDF Viewport Jump (Decision G; Area 40).**
  Clicking any section page badge or term evidence link in the Reader Overview must trigger `requestJump`, scrolling the PDF reader viewport to the target page and paragraph.
  *Evidence:* Playwright test clicking section jump badge; asserting viewer scrolls to the exact target page.

- **AC-P0-41 Zero Meta-Claims & $\le 2.0\%$ Unsupported Claims (Decision H; Area 41).**
  In a standard claim audit of 50 generated claims on benchmark papers (ResNet), the rate of UNSUPPORTED claims must be $\le 2.0\%$ (target: 0), and machine meta-instruction claims must be strictly 0% (slashing historical 12.5% failure).
  *Evidence:* Automated audit script running `test_semantic_audit.py` on benchmark overview; asserting `unsupported_count / total <= 0.02` and `meta_claims == 0`.

- **AC-P0-42 Visual Caveat Pill for Partially Supported Claims (Decision I; Area 42).**
  Claims classified as `PARTIAL` (e.g. author hypothesis where empirical verification was limited) must render with an amber caveat pill ("部分证据支持") and cite the partial source paragraphs.
  *Evidence:* DOM test verifying presence of `[data-testid="claim-caveat-pill"]` for partial claims.

- **AC-P0-43 Real-Provider Three-State Claim Audit Protocol (Decision H; Area 43).**
  The semantic audit protocol must evaluate real-provider generated overviews across three discrete states: SUPPORTED, PARTIALLY_SUPPORTED, and UNSUPPORTED, recording citation evidence for each.
  *Evidence:* Execution of `backend/tests/test_reader_overview_audit.py` recording structured audit results.

- **AC-P0-44 Rapid Document-Switch Abort & State Isolation (Decisions N, O; Area 44).**
  If a reader triggers Overview generation for Paper A and immediately switches to Paper B, Paper A's generation request must be aborted via `AbortController`, and any late-arriving response for Paper A must be discarded without polluting Paper B's state.
  *Evidence:* Playwright test initiating overview on Doc A, switching to Doc B at $t=200\text{ ms}$; asserting Doc B Overview remains in clean Layer A state and abort is signaled.

- **AC-P0-45 Tripartite Provider Failure Classification (Decision J; Area 45).**
  When overview generation fails, the UI must report one of three precise failure modes (`PROVIDER_ERROR`, `EXTRACTION_ERROR`, `CANCELLED_ERROR`) with actionable guidance, never collapsing to a generic error string.
  *Evidence:* Frontend mock test asserting specific error messages for HTTP 502, 422, and Abort errors.

- **AC-P0-46 Partial Synthesis Graceful Degradation (Decision H; Area 46).**
  If synthesis partially succeeds (e.g. method cards generated but findings timed out), the overview must render available sections with an informative badge ("部分概览已生成") and never crash or display a blank screen.
  *Evidence:* Component test mounting overview with status `PARTIAL`; verifying rendered cards and warning banner.

- **AC-P0-47 Complete Exclusion of User Notes Marginalia (Decision S; Area 47).**
  The Reader Overview pipeline must NOT query SQLite `annotations` or `annotation_targets`. User notes must never be injected into provider prompts or displayed in overview cards.
  *Evidence:* Automated test creating 10 user notes in SQLite; generating overview; asserting zero note text tokens appear in provider request or overview payload.

- **AC-P0-48 Paper QA Session & Scope Independence (Decision C; Area 48).**
  Generating, viewing, or interacting with the Reader Overview must have zero side effects on Paper QA state (preserving `activeQaTurn`, history, and `ScopeSelector`).
  *Evidence:* Test performing a QA question, switching to Overview, triggering generate, returning to QA; asserting QA history is unchanged.

- **AC-P0-49 Strict Prohibition of Dense Vector Embeddings (Decision Core; Area 49).**
  The Reader Overview subsystem must not invoke vector embeddings, dense retrieval models, or vector database engines.
  *Evidence:* Codebase audit asserting 0 imports of `sentence_transformers`, `chromadb`, `faiss` in overview pipeline.

- **AC-P0-50 Source PDF Byte Stream Immutability Invariant (Decision Core; Area 50).**
  Generating, caching, and serving a Reader Overview must never mutate the source PDF file on disk. The SHA-256 hash of `source.pdf` must remain bit-for-bit identical before and after overview operations.
  *Evidence:* File hash assertion in `tests/test_overview_persistence.py` verifying source PDF hash invariant.

- **AC-P0-51 Complete Browser E2E Overview Lifecycle (Decisions C, D, G; Area 51).**
  Playwright E2E test verifying complete user journey: open ResNet; observe instant Layer A; click "生成 AI 概览"; observe honest progress timer; verify Layer B reader cards render; click jump badge; verify viewer scrolls to target page.
  *Evidence:* Playwright test `tests/e2e/reader-overview-lifecycle.spec.ts` passes with exit code 0.

- **AC-P0-52 Initial Bundle Chunk Ceiling ($\le 300.0\text{ kB}$) (Decision Q; Area 52).**
  With code splitting enabled, the initial JavaScript bundle chunk (`index-*.js`) must not exceed **300.0 kB** minified, regaining $\ge 49\text{ kB}$ of headroom under the 350.0 kB total ceiling.
  *Evidence:* `npm run build` output confirms initial chunk size $\le 300.0\text{ kB}$.

- **AC-P0-53 Dynamic Import of Heavy Non-Initial Panels (Decision Q; Area 53).**
  Heavy assistant panels (`NotesPanel`, `ConversationArea`/`Composer`, translation UI) must be split using React `lazy()` and `Suspense`, ensuring they are only loaded when their respective tab or feature is activated.
  *Evidence:* Vite build output shows distinct dynamic chunks (e.g. `notes-*.js`, `qa-*.js`) and codebase check confirms `lazy()` usage.

- **AC-P0-54 Instant Cache Hit After Document Reimport (Defect A, Decision R; Area 54).**
  Deleting a document record from the database and re-importing the same PDF file must immediately hit the content-addressed overview cache without re-prompting the provider.
  *Evidence:* Backend test importing PDF A, generating overview, deleting document A row via API, re-importing PDF A (minting new document ID), querying `GET /overview`, asserting HTTP 200 and cache hit with 0 provider calls.

- **AC-P0-55 Side-by-Side Multilingual Cache Coexistence (Decisions O, R, S; Area 55).**
  Generating an overview in Chinese (`zh-CN`) and subsequently in English (`en`) for the same PDF file must store both overviews side-by-side in content-addressed storage (`<content_hash>_zh-CN.json` and `<content_hash>_en.json`), allowing instant zero-call switching between languages.
  *Evidence:* Backend test generating both `zh-CN` and `en` overviews for the same `content_hash`; asserting both files exist on disk and querying each language returns its respective cached artifact with 0 provider calls.

---

### 6.2 P1 SHOULD — Usability & Extended Workflows

- **AC-P1-01 Markdown Overview Export.**
  Provide an "导出概览" (Export Overview) button in the panel header that downloads a clean, structured Markdown file containing the Research Question, Core Idea, Contributions, Roadmap, and Key Terms.
  *Evidence:* Browser test clicking export; verifying downloaded `.md` content structure.

- **AC-P1-02 In-Place Overview Language Switcher.**
  Provide a language toggle in the Overview header allowing readers to switch between Chinese (`zh-CN`) and English (`en`) overviews with instant cached hydration.
  *Evidence:* Clicking language selector loads cached English overview without page reload.

- **AC-P1-03 Quick Question Scoping from Overview Card to Paper QA.**
  Provide an "以此提问" button on each Method and Finding card that switches to the QA tab and prefills the query composer with the selected topic.
  *Evidence:* Clicking button switches to QA tab with composer populated.

- **AC-P1-04 Curated Terms Category Filtering (Models, Datasets, Metrics).**
  Provide filter pills in the Key Terminology card to filter terms by category (`model`, `dataset`, `benchmark`, `metric`).
  *Evidence:* Clicking "模型" filter displays only model identifiers (e.g. `ResNet-50`, `VGG-19`).

- **AC-P1-05 Collapsible Method & Findings Detail Cards.**
  Allow readers to expand and collapse individual methodology and finding cards in the roadmap to customize reading density.
  *Evidence:* Clicking card accordion collapses details.

- **AC-P1-06 User Preference Auto-Hydrate Setting.**
  Provide an opt-in toggle in Settings: "打开论文时自动加载已缓存的概览" (default: ON).
  *Evidence:* Unit test verifying localStorage setting behaviour.

---

### 6.3 P2 OPTIONAL — Advanced Exploration & Multi-Paper Aggregation

- **AC-P2-01 Multi-Paper Comparative Overview Shelf.**
  A global library view comparing the Core Idea, Method, and benchmark results across multiple analyzed papers side by side.
  *Evidence:* Library view rendering comparative table for 3 papers.

- **AC-P2-02 Interactive Method Architecture Flow Visualizer.**
  An interactive lightweight SVG diagram showing connections between methodology steps mentioned in the paper.
  *Evidence:* Flow diagram renders within canvas.

- **AC-P2-03 Text-to-Speech Audio Read-Aloud for Core Idea.**
  Provide an audio play button allowing readers to listen to the Core Idea and Research Question synthesis.
  *Evidence:* Clicking play triggers Web Speech API speech synthesis.

- **AC-P2-04 Cross-Document Terminology Linker.**
  Highlight terms in the Overview that share definitions or conflicting usages across different papers in the reader's library.
  *Evidence:* Term pill displays cross-paper reference count.

---

## 7. Verification Protocol

Every verification step below is executable, non-tautological, and capable of failing.

### 7.1 Content-Addressed Identity Test (`backend/tests/test_overview_cache_identity.py`)

```python
import tempfile
from pathlib import Path
from fastapi.testclient import TestClient
from tests.test_api_documents import make_pdf, upload

def test_same_pdf_reopened_hits_content_addressed_overview(client: TestClient) -> None:
    with tempfile.TemporaryDirectory() as folder:
        data = make_pdf(Path(folder) / "paper.pdf").read_bytes()

    first = upload(client, data).json()["document_id"]
    
    # Generate overview on first open
    gen_resp = client.post(f"/api/documents/{first}/overview", json={"profile_id": "test"})
    assert gen_resp.status_code == 200
    
    # Reopen identical bytes -> new ephemeral document row
    second = upload(client, data).json()["document_id"]
    assert second != first, "reopening must mint a new row"
    
    # Query overview on second row -> must hit cache instantly
    get_resp = client.get(f"/api/documents/{second}/overview")
    assert get_resp.status_code == 200
    assert get_resp.json()["content_hash"] == gen_resp.json()["content_hash"]
    assert get_resp.json()["core_idea"]["text"] == gen_resp.json()["core_idea"]["text"]
```

### 7.2 Zero Provider Calls on Reopen Verification

```python
from app.llm import accounting

def test_reopen_overview_incurs_strictly_zero_provider_calls(client: TestClient, pre_seeded_doc) -> None:
    accounting.reset()
    
    # Open document and read overview
    resp = client.get(f"/api/documents/{pre_seeded_doc}/overview")
    assert resp.status_code == 200
    
    # Assert ledger recorded zero provider calls
    assert accounting.total() == 0
    assert len(accounting.snapshot()) == 0
```

### 7.3 Real-Provider Semantic Audit Protocol (`backend/tests/test_reader_overview_audit.py`)

```python
from enum import Enum
from pydantic import BaseModel

class ClaimStatus(str, Enum):
    SUPPORTED = "SUPPORTED"
    PARTIAL = "PARTIAL"
    UNSUPPORTED = "UNSUPPORTED"

class AuditRecord(BaseModel):
    claim_id: str
    claim_text: str
    status: ClaimStatus
    source_citation: str
    is_meta_claim: bool = False

def test_semantic_audit_zero_meta_claims_and_low_unsupported():
    records: list[AuditRecord] = run_resnet_reader_overview_audit()
    
    total = len(records)
    meta_claims = [r for r in records if r.is_meta_claim]
    unsupported = [r for r in records if r.status == ClaimStatus.UNSUPPORTED]
    
    # Strict thresholds: 0 machine claims, <= 2% unsupported
    assert len(meta_claims) == 0, f"Found {len(meta_claims)} machine meta-claims in reader overview"
    assert (len(unsupported) / total) <= 0.02, f"Unsupported rate {len(unsupported)/total:.1%} exceeds 2.0%"
```

---

## 8. Non-Goals & Explicit Boundary Exclusions

To ensure strict execution focus and prevent architectural bloat, the following areas are designated as **explicit non-goals** for DS-QA-015:

1. **No Dense Vector / Embedding Indexing:** No vector database (`chromadb`, `faiss`, `qdrant`) or embedding models will be introduced.
2. **No Interactive Chat Synthesis in Overview:** Overview is a structured orientation panel; it does not introduce a conversational chat interface. Chat remains exclusively in Paper QA.
3. **No Modification of Paper QA Retrieval Contract:** Paper QA's retrieval engine, ranking algorithms, citation verification, and answer prompts are untouched.
4. **No Modification of Notes SQLite Database:** The SQLite schema (`annotations`, `annotation_targets`) and persistent anchor reattachment logic are untouched.
5. **No Speculative / Hallucinated Limitations:** The system will never speculate about study flaws if the authors did not include a dedicated limitations section.
6. **No Fourth Sidebar Column:** The application layout remains strictly one sidebar at `SIDEBAR_WIDTH_PX = 340`.
7. **No Heavy External Charting or Markdown Libraries:** Libraries like `react-markdown` or `recharts` remain forbidden.
8. **No Automatic Background Provider Calls:** Opening papers, changing tabs, or navigating pages will never trigger automatic provider calls.
