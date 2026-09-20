# Evidence — DS-QA-014 Paper Overview / Reading Entry

- **Date:** 2026-09-19
- **Commits:** `docs(acceptance)` (criteria), `feat(overview)` (implementation), this file
- **Acceptance criteria:** `docs/acceptance/DS-QA-014.md` — Gemini authored 38 P0;
  **four `AC_CHANGE_REQUEST`s** were raised and resolved before the list was frozen.
- **Verdict:** **DETERMINISTIC READING ENTRY READY, AI OVERVIEW QUALITY
  INSUFFICIENT.** Both halves of that sentence are measured, and the second is not
  a quality judgement — it is two defects with numbers.

## What works, and how it was measured

**The instant layer is real and it costs nothing.** `.agent/results/overview-e2e.log`,
real Edge, real bundle, real backend, the real ResNet paper:

```
the paper opens on the overview tab
the title is the paper's own            "Deep Residual Learning for Image Recognition"
the abstract is the paper's own words   "Deeper neural networks are more difficult to train…"
structural metrics                      12 页 · 9 个一级章节
a reading recommendation                "从正文第一章开始：3. Deep Residual Learning"
the recommendation scrolls the paper    scrollTop 0 -> 2983
opening the paper reached no provider   0 provider call(s)
```

Everything there comes from the `DocumentIR` the application already held. No
request, no spinner, no model — and the recommendation names the paper's own
section, because the real outline has none called "Method" or "Experiments".

The **provider-call counter was on the wrong boundary** and this is worth
recording. It watched the page's requests for a provider host; the page never
talks to a provider — the backend does. Measured server-side instead:

```
POST /api/documents/{id}/analysis
status: ok          elapsed: 1565.8s         (~26 minutes)
analysis status: PARTIAL    summary 1579 chars    sections 10
glossary 197    acronyms 26    ir_pipeline_version 5
```

## Two defects, both measured

**1. A cached analysis cannot be reached after reopening the paper.**
`app/context/persistence.py` stores it at `<document_dir>/analysis.json`, and the
directory comes from the document **row** — `uuid4().hex`, minted fresh every time
a file is opened. So the second open of a PDF the reader already paid to analyse
finds nothing, offers to generate, and spends the full cost again. This is
DS-QA-010-FIX-001's exact defect, fixed there for annotations by keying on
`content_hash` and never fixed here because nothing used the analysis. Measured in
the browser: an analysis installed under the paper's own directory is not fetched
by the panel, because the panel's document is a different row.

**2. The analysis is a translation artefact, not a paper summary.**
`document_synthesis_messages` opens with *"Produce a compact orientation for a
**translation system** that must choose the right sense of a term."* The claim
audit (`.agent/results/claim-audit.txt`) classified 48 claims by lexical coverage
against the paper's 101 paragraphs — 30 SUPPORTED, 12 PARTIAL, 6 UNSUPPORTED — and
the lowest-scoring three are the finding:

```
[0.00] (References)          "It includes paper titles, author names, venues, and years."
[0.12] (Unsectioned p1)      "It is useful for preserving author names and affiliation
                              spelling during translation."
[0.29] (References)          "For translation, venue acronyms and model/library names
                              should be preserved…"
```

Those are sentences written **to a machine**, in a reading entry, next to a
summary of the bibliography. The document-level `summary` is genuinely good and
accurate for this paper; the per-section layer is not reader-facing.

## Measured

```
backend                    1012 passed, 0 flakes
frontend                   282 passed  (257 + 25)
typecheck                  PASS
build                      exit 0
bundle                     348.97 kB of 350 kB   (1.03 kB headroom)
overview browser E2E       14/14, 0 provider calls
provider calls on open     0
real generation            ok, PARTIAL, 1565.8 s
source PDF                 byte-identical
```

## Known limitations

1. **No Overview criterion could be satisfied for Layer B** — the two defects
   above are structural, and neither is a tuning problem.
2. **The bundle has 1.03 kB of headroom.** The opening page moved to 概览, and its
   panel plus client measures ~11.5 kB. It passes, and it is close.
3. **The claim audit is lexical coverage, not entailment.** A paraphrase that
   inverted a number while keeping its words would score high; the low-scoring
   claims are printed in full so a human reads them. It is reported as coverage.
4. **The generation was run once**, server-side, against `deepseek-flash`.

## Next task

**Make the analysis reachable and make it reader-facing.** Two concrete,
evidenced pieces: key the cache on `content_hash` so a paid analysis survives a
reopen (the DS-QA-010 fix, applied to the artefact it was never applied to), and
give the Overview its own prompt — the task's own decision D — so the section
layer says something to the reader rather than to the translator.
