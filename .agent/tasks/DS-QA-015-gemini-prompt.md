# DS-QA-015 — Acceptance Criteria authoring task (Gemini)

You are the independent Acceptance Criteria author for the Academic PDF Copilot
repository at `D:\marti\SciPrograms`. DeepSeek owns all production code. **You do
not write production code.** Your only deliverable is one document.

## Your deliverable

Write:

    D:\marti\SciPrograms\docs\acceptance\DS-QA-015.md

P0 MUST / P1 SHOULD / P2 OPTIONAL criteria, each numbered, each independently
verifiable, each stating its evidence. Follow `docs/acceptance/DS-QA-014.md`.

## Time budget — read before you start

Hard 25-minute wall clock. **Do not run the test suites, the build, `pytest` or
`vitest`.** A previous round was lost to an agent that spent its budget launching
suites and returned no document. Read source, decide, write.

## The task

**DS-QA-015 · Reader Overview Pipeline + Content-Addressed Analysis Cache.**

Two defects, both measured, both architectural rather than cosmetic:

**A. The analysis cache is bound to an ephemeral identity.** Verified in
`tests/test_analysis_cache_identity.py`: `app/context/persistence.py` stores an
analysis at `<document_dir>/analysis.json`, and the directory derives from the
document **row** (`uuid4().hex`, minted fresh on every open). Reopening a
byte-identical PDF makes the paid-for artifact unreachable. The artifact is not
deleted — the lookup identity is wrong. This is DS-QA-010-FIX-001's defect exactly
(the notes list was keyed on the document row and fixed by keying on
`content_hash`); the analysis never received that fix because nothing used it.

**B. The analysis is written for a translation system, not a reader.** Its
prompt opens *"Produce a compact orientation for a translation system that must
choose the right sense of a term."* Measured on real output for ResNet, a claim
audit classified 48 items: 30 SUPPORTED, 12 PARTIAL, **6 UNSUPPORTED**, and the
three lowest-scoring were sentences addressed to a machine —
*"It is useful for preserving author names and affiliation spelling during
translation."* It also produced reader-facing summaries of **References** and of
**Unsectioned Content (Pages 1-1)**.

## MEASURED — the 26-minute baseline, explained structurally

`.agent/results/analysis-measure.log`: a real generation for ResNet took
**1565.8 s**, returned `PARTIAL`, and produced a 1579-char document summary, 10
section records, 197 glossary terms, 26 acronyms. Token usage was **not
captured** — that run predates the ledger.

Reading `app/context/pipeline.py::analyse` explains the time without a rerun
(the task explicitly permits this):

```
if total_tokens <= SINGLE_PASS_TOKEN_LIMIT:
    domain, summary = await self._single_pass(...)          # short papers: 1 call
else:
    for unit in self._build_units(ir):                      # SERIAL, one call each
        unit_summary = await self._analyse_unit(unit, accumulated)
    domain, summary = await self._synthesise(...)           # + 1 synthesis call
```

- **One provider call per section unit, strictly serial**, each receiving the
  *accumulated* prior summaries — so the prompt grows with every unit.
- Plus one synthesis call. ResNet has ~10 units, so ~11 calls at ~2 minutes each.
  That is the 26 minutes.
- **`_build_units` is also the source of three of the four bad-output classes:**
  every `ir.sections` entry with paragraphs becomes a unit (that is why
  **References** was summarised), and paragraphs with no `section_id` are grouped
  into synthetic partitions titled `f"Unsectioned Content (Pages {first}-{last})"`
  (that is where the page-1 metadata summary came from).
- A unit failure is recorded and the run continues, which is why `PARTIAL` exists.

So: the cost and the content defects come from **the same structure** — "every
section, unconditionally, one serial call each, for a translator".

## MEASURED — provider accounting now exists at the right boundary

`app/llm/accounting.py` (committed at `85207e8`). `CountingProvider` wraps every
provider `detection._build_provider` constructs — verified by search to be the
only construction point. It records operation, model, protocol, outcome and
provider-reported usage; never prompts, completions or credentials. Verified
zero-call paths, asserted against this ledger rather than a browser counter:
paper open, notes list, notes search/export, cached analysis read.

**Any criterion you write about provider calls must be measured against this
ledger**, and token counts must be `UNAVAILABLE` rather than estimated where the
endpoint does not report usage.

## MEASURED — the bundle

```
index-sAPAT8fv.js   349.14 kB   (ceiling 350 kB — 0.86 kB headroom)
pdf-CfP-JzcY.js     483.14 kB   already lazy-loaded
pdf.worker.min.mjs 1265.41 kB   already lazy-loaded
```

**The application has no code splitting at all.** A search finds no `lazy(` and
no `Suspense` in `src/app` or `src/assistant`: the QA panel, Notes panel, outline,
translation UI and the DS-QA-014 Overview are all in the single initial chunk.
React's `lazy` and dynamic `import()` are already available; no dependency is
needed to split them.

## MEASURED — what DS-QA-014 already shipped and must not regress

The deterministic Reading Entry renders synchronously from the `DocumentIR` with
**0 provider calls**: title (from `metadata.title`), the verbatim Abstract, page
and section counts, and a reading recommendation derived from the paper's own
outline. Verified in a real browser. It must keep working when the provider is
unreachable, and it must not become lazily loaded.

## WHAT EXISTS TODAY, precisely

- `app/context/persistence.py`: `analysis_path(document_dir)`, `read_analysis`,
  `write_analysis`, `delete_analysis`, `is_cache_valid(...)` — validity already
  compares `content_hash`, `pipeline_version`, `prompt_version`,
  `ir_pipeline_version`, provider identity and `target_language`. The *semantics*
  are right; the *location* is wrong.
- `app/context/models.py`: `DocumentAnalysis` (summary, sections, glossary,
  acronyms, entities, domain, errors, status) and `AnalysisProvenance`.
- `POST|GET|DELETE /api/documents/{id}/analysis`. GET reads, never generates.
- `frontend/src/overview/OverviewPanel.tsx`, `session.ts`, `roadmap.ts`,
  `api/analysis.ts` — the DS-QA-014 panel. It reads a stored analysis, shows a
  bounded view (document summary, section list, first 8 glossary terms behind an
  expand), and offers a generate button. It refuses an analysis whose
  `ir_pipeline_version` or `content_hash` no longer matches.
- Notes are annotations keyed on `content_hash` — the pattern defect A needs.

## Decisions you must make explicitly

- **A.** May the Reader Overview reuse the existing document-level `summary`?
  (Measured: it is useful and accurate for ResNet.)
- **B.** May the translation-oriented **per-section** summaries be reused as
  reader-facing prose? (Strong hypothesis: no.)
- **C.** May they be reused as *internal intermediate data* instead?
- **D.** What generation architecture: one bounded synthesis call, a staged
  hierarchy, selected canonical sections, existing intermediates, or another?
  Given the measured structure, say what it costs.
- **E.** Maximum acceptable fresh latency.
- **F.** Maximum acceptable provider-call count.
- **G.** Token/cost expectations, given usage may be unreported.
- **H.** Maximum acceptable unsupported-claim rate.
- **I.** How PARTIAL claims are presented to the reader.
- **J.** Must every displayed semantic item carry evidence?
- **K.** Which source sections are eligible for synthesis?
- **L.** Are References excluded?
- **M.** Is unsectioned metadata excluded, and how is it classified?
- **N.** How is the absence of a Conclusion or an explicit Limitations section
  represented — omitted, or stated as not identified?
- **O.** Output language requirements, and how identifiers survive.
- **P.** Cache behaviour when the model or provider changes. (Is an old-model
  artifact still shown? Is it labelled?)
- **Q.** Must the bundle regain *meaningful* headroom, or merely stay under
  350 kB? Freeze the number.

Also decide and state:

- **R.** The cache identity: which dimensions invalidate a Reader Overview, and
  which are recorded only for display. Distinguish **source identity** from
  **generation configuration**.
- **S.** Where the artifact lives, without inventing a framework larger than the
  problem.
- **T.** What happens to existing per-document `analysis.json` files.
- **U.** Whether the Reader Overview is a new artifact kind or a versioned
  replacement for `DocumentAnalysis`.
- **V.** Whether an existing translation-oriented analysis may be *shown* to a
  reader at all, or only used as intermediate data.

## Acceptance criteria must cover at least these 55 areas

1 content-addressed Reader Overview cache, 2 same PDF / different document row,
3 same filename / different bytes, 4 content hash, 5 artifact kind, 6 IR pipeline
version, 7 Reader Overview pipeline version, 8 prompt version, 9 target language,
10 model/provider cache semantics, 11 legacy `analysis.json`, 12 corrupt cache,
13 partial cache, 14 atomic cache writes, 15 paper open zero provider calls,
16 cached reopen zero provider calls, 17 explicit generation only, 18 exact
provider call accounting, 19 retry accounting, 20 provider-reported token usage,
21 latency, 22 deterministic Reading Entry regression, 23 dedicated reader-facing
artifact, 24 translation-analysis separation, 25 Research Question, 26 Core Idea,
27 Contributions, 28 Method, 29 Experiments, 30 Findings, 31 Limitations policy,
32 Key Terms, 33 output language, 34 identifier preservation, 35 References
handling, 36 Unsectioned Content handling, 37 evidence IDs, 38 evidence
validation, 39 source page/bbox resolution, 40 source jump, 41 unsupported-claim
threshold, 42 partial-claim handling, 43 real-provider semantic audit,
44 document-switch race, 45 provider failure, 46 partial generation, 47 Notes
isolation, 48 Paper QA isolation, 49 no dense retrieval, 50 source immutability,
51 browser E2E, 52 bundle size, 53 code splitting / lazy loading, 54 cache hit
after reimport, 55 language-specific cache behaviour.

Out-of-scope areas must be named as **explicit non-goals**.

## Rules

- Every P0 criterion must be **observable**. "The Overview is grounded" is not
  one. "Every displayed item's evidence IDs resolve to paragraphs in the current
  IR, and the panel renders 0 items whose IDs do not" is.
- State the **evidence** for each P0: which command, which browser observation,
  which test file.
- Do not invent thresholds. Where a number is needed, say what measurement
  justifies it, and remember that the baseline to beat is **1565.8 s and 11 serial
  calls** and that the historical unsupported-claim rate is **12.5%**.
- Do not add a dependency. React's lazy/Suspense and dynamic `import()` are
  already present.
- Do not modify Paper QA's retrieval, ranking, answer prompt, abstention or
  citation contract. Do not add embeddings or a vector database.
- Notes must never reach the Overview.
- The source PDF is never modified.

Write the document now. Return, as your final message, only the list of P0
criteria ids with one line each.
