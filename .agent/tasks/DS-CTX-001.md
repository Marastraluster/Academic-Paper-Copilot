# DS-CTX-001 — Academic Context Foundation

- **Phase:** 5 (Document Intelligence) — the first AI-derived layer
- **Status:** Ready — criteria frozen in `docs/acceptance/DS-CTX-001.md` before implementation
- **Owner:** DeepSeek (implementation) · Gemini (acceptance criteria)
- **Created:** 2026-09-17
- **Baseline:** `ff744ab` (DS-DOC-001 + Gate 0 fix)

## Goal

Build the first AI-derived semantic layer on top of the canonical Document IR: document
analysis, hierarchical summarisation, section summaries, domain inference, glossary candidates,
acronyms, named entities, provenance, deterministic invalidation, persistence, and a
`ContextBuilder` for future translation.

**Not** in this task: modifying the translation kernel, Paper QA, embeddings, vector search,
frontend work.

## The architectural boundary

```
DocumentIR         what the PDF physically contains — source truth, immutable
DocumentAnalysis   what a model made of it — derived, replaceable, rebuildable
```

Nothing is written back into the IR. The IR is never re-parsed into a competing representation.
Documents are analysed without being translated, and translated without being analysed.

## Gate 0 — completed first

DS-DOC-001 closed with `AC-DOC-32` partial: the IR had never been validated on a genuine
two-column, formula-heavy paper, and Context Engine quality depends directly on IR quality.
That validation ran against ResNet (arXiv:1512.03385) and found five defects, including a
criterion wrongly reported as passing. All fixed in `ff744ab` before this task began.
Record: `.agent/evidence/DS-DOC-001-GATE0.md`.

## Files allowed to modify

```
backend/app/context/**          (new package)
backend/app/storage/atomic.py   (new — one atomic-write implementation)
backend/app/api/documents.py    (four analysis/context routes)
backend/tests/test_context_analysis.py
.agent/tasks/DS-CTX-001.md
.agent/evidence/DS-CTX-001.md
```

## Files forbidden to modify

```
backend/app/pdfkernel/**       (frozen — translation kernel)
backend/app/llm/**             (reused as-is; the abstraction boundary)
backend/app/db.py              (no schema change; SCHEMA_VERSION stays 3)
backend/tests/test_db.py, backend/tests/test_isolation.py
frontend/**                    (no frontend work in this task)
_reference/**
```

## Requirements

R1. `DocumentIR` immutable under analysis.
R2. No second PDF parser; the IR is the only document input.
R3. Hierarchical, bounded analysis; a long paper never sent in one request.
R4. Paragraph-respecting chunk boundaries and an enforced token budget.
R5. Structured output with validation; malformed or empty output never persisted.
R6. Granular partial failure — `READY` / `PARTIAL` / `FAILED` / `CANCELLED`.
R7. Provenance persisted; no credential in it.
R8. Deterministic invalidation: source, prompt version, pipeline version, model and endpoint.
    **Changing only the API key must not invalidate.**
R9. Analysis rebuildable without touching source, IR or translation artifacts.
R10. Exact source spelling preserved for identifiers.
R11. Evidence by paragraph id; expansions and quotations only where the paper supports them.
R12. Domain may be `Unknown`; uncertainty is a result, not a failure.
R13. ContextBuilder: real neighbours from the IR, bounded, shedding in a defined order,
     and never carrying the target paragraph's own text.
R14. Provider failures reuse the existing normalised hierarchy and stay bounded.
R15. No paper text in logs; no credential anywhere.
R16. No new SQLite table.

## Known risks

- **Invented structure** — a plausible glossary entry the paper does not contain. The evidence
  check exists for this; it was verified live by a stub citing a fabricated paragraph id.
- **Losing most of a paper to one bad request** — the reason `PARTIAL` exists.
- **A fatal provider error treated as a per-section failure**, turning one rejected key into one
  doomed request per section. Found and fixed during implementation.
- **Budget drift** — a context that silently exceeds its bound, or one that sheds material it
  should not.

## Open item

**§79/§80 real-provider verification was not performed**: no provider is configured on this
machine and none was invented. The mechanical path is verified end to end through a real HTTP
round trip; model *judgement* is not.
