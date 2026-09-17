# DS-CTX-002 — Context-Aware Academic PDF Translation

- **Phase:** 5 (Document Intelligence) — connects context to the translation kernel
- **Status:** Ready — criteria frozen in `docs/acceptance/DS-CTX-002.md` before implementation
- **Owner:** DeepSeek (implementation) · Gemini (acceptance criteria)
- **Created:** 2026-09-17
- **Baseline:** `940ae5b`

## Goal

Make each translation unit translate **with academic context** instead of in isolation:

```
Source PDF → DocumentIR → DocumentAnalysis → ContextBuilder
           → context-aware translator → PDFMathTranslate layout/rendering → PDF
```

Upstream keeps layout, formulas, placeholders and rendering. This application owns the
provider, the academic context, the prompt, the semantic cache identity, placeholder
validation and safe failure.

## Ground truth captured before implementation

A 12-page paper produces **149 translation units** (min 317, median 555, max 3608 chars)
against **101 IR paragraphs** — the two segmentations do not correspond, and a unit arrives
as *text only*, with no page, bbox or id.

Placeholders are **single-brace `{vN}`**, confirmed two independent ways: captured from a
real run, and by the f-string that builds them (`f"{{v{len(var)}}}"` → `{v26}`). The
`get_formular_placeholder()` accessor returning `{{vN}}` is dead code for this path — a
validator written from it would reject every valid translation.

Upstream's cache is keyed `UNIQUE (translate_engine, translate_engine_params, original_text)`,
and `translate_engine_params` holds `temperature, stop, max_tokens, prompt, think_filter_regex`
— **not the endpoint or the model**. That is the defect, located to the line.

## Two corrections from the criteria review

**The cache hook is `translate()`, not `do_translate()`.** Upstream consults the cache
*before* calling `do_translate`, so context resolved there would arrive after the cache
decision. Recorded because the authoring prompt said otherwise.

**`add_cache_impact_parameters` is shared mutable state.** Calling it per unit from four
worker threads would race; upstream's own comment concedes it assumes configuration happens
before translation starts. So global identity is registered once at construction and
per-unit identity travels in the cache *key text*.

## Files modified

```
backend/app/context/unit_mapper.py            new — unit → IR paragraph
backend/app/context/translation_context.py    new — per-unit context + effective hash
backend/app/context/prompts.py                translation envelope, v2.0.0
backend/app/pdfkernel/placeholders.py         new — {vN} extraction and validation
backend/app/pdfkernel/contextual_translator.py new — the translator
backend/app/pdfkernel/context_registry.py     new — per-run provider lookup
backend/app/pdfkernel/adapter.py              additive: context_provider parameter
backend/app/documents/tasks.py                context mode, typed refusal, diagnostics
backend/app/api/documents.py                  context_mode on the translate request
backend/tests/test_context_translation.py     45 tests
```

## Constraints

- **Off must be byte-identical** to the previous behaviour: no context, no delimiters, the
  same envelope. It is the compatibility and A/B baseline.
- **No upstream fork.** The substituted class and `add_cache_impact_parameters` are the
  sanctioned surface (ADR-001).
- **No "Deep" mode.** A mode that means "spend more tokens" is a label, not a capability.
- **Credentials are not semantics.** The API key never affects cache identity.
- Formula correctness outranks translation completeness.

## Known risks

- **Wrong context is worse than none.** The mapper refuses ambiguous matches rather than
  guessing, and an unresolved unit gets document-level context only.
- **A per-unit race.** Four worker threads share one translator; anything mutable on the
  instance would cross contexts.
- **Cache poisoning across providers**, which this task is also responsible for fixing.
