You are the independent Acceptance Criteria author for a local-first academic PDF
reader + bilingual translator ("Academic PDF Copilot").

Define objective P0 / P1 / P2 acceptance criteria for the next task.

**Do NOT write production code.** Return acceptance criteria only.

---

# TASK — DS-CTX-002: Context-Aware Academic PDF Translation

Make the existing translation pipeline translate each source unit **with academic
context** instead of in isolation:

```
Source PDF → DocumentIR → DocumentAnalysis → ContextBuilder
           → context-aware translator → PDFMathTranslate layout/rendering → PDF
```

This is the product-differentiating feature. Everything upstream of the translator
already exists and is verified; this task connects it.

## Where the project is

```
backend   618 passed
frontend   75 passed
```

All of the following are complete, verified and **must not be redesigned**:
usable reader · real translation · provider system · bounded provider failure ·
DocumentIR (validated on a real paper) · DocumentAnalysis (validated against a real
model) · ContextBuilder · persistence and invalidation.

---

# VERIFIED GROUND TRUTH — measured, not read

## Translation units, captured from a real run

A 12-page paper produced **149 translation units** (min 317, median 555, max 3608
characters). The longest are reference lists.

**Placeholders are `{vN}` — single brace.** Verified by capturing the text actually
handed to the model:

```
"...Deeply- supervised nets. {v26}, 2014. [25] M. Lin... Network in network. {v27}..."
```

Note this **contradicts the source**: `OpenAIlikedTranslator.get_formular_placeholder()`
returns `"{{v" + str(id) + "}}"` — double brace — and the base class uses `<bN>` /
`</bN>` rich-text markers. The text that actually reaches the model is single-brace.
A validator written from the source would be wrong. **Assume nothing; validate
against captured text.** The prompt upstream sends even says *"Keep the formula
notation {v*} unchanged."*

Every unit is delivered inside a fixed instruction envelope:

```
You are a professional, authentic machine translation engine. Only Output the
translated text, do not include any other text.

Translate the following markdown source text to zh. Keep the formula notation {v*}
unchanged. Output translation directly without any additional text.

Source Text: <the actual unit>

Translated Text:
```

## Where context can be injected

| Piece | Fact |
|---|---|
| Hook | `do_translate(self, text)` — the per-unit method; `BoundedOpenAIlikedTranslator` already overrides `translate()`. Each translator implements `do_translate`. |
| Envelope | `self.prompt(text, self.prompt_template)` builds the messages. The template is supplied at construction. |
| **Cache** | `self.cache = Cache(...)` keyed on the source text plus `add_cache_impact_parameters(k, v)` entries. `translate()` returns the cached value unless `ignore_cache`. |
| Cache parameters today | `OpenAIlikedTranslator` contributes `temperature`, `stop`, `max_tokens`, `prompt`, `think_filter_regex`. **It does not contribute `base_url` or `model`.** |
| Retry | Upstream wraps the worker in `@retry(wait=wait_fixed(1))`, which catches `Exception`. |
| Concurrency | `thread=N` (we run 4). Multiple units translate in parallel. |
| Substitution | Our adapter swaps the class on `pdf2zh.converter`; upstream is never edited (ADR-001). |

**The cache defect is now located precisely**: the same source text translated through
two different endpoints, or two different models, can return whichever ran first. Our
current workaround is `ignore_cache=True` on every API translation, which is correct
but discards caching entirely. `add_cache_impact_parameters("base_url", ...)` is
upstream's own API for fixing this, in a class we already own.

## DocumentAnalysis — what the context actually contains

Validated against a real model on a real paper, then frozen as
`docs/context/SEMANTIC_BASELINE.md`:

```
status PARTIAL (2 sections truncated) · domain Computer vision / deep learning (0.95)
207 glossary entries (204 supported by their cited paragraph, 0 fabricated)
29 acronyms — 24 honestly left unexpanded, 5 verifiably stated
56 entities · 208-word document summary · 7 section summaries
```

```python
GlossaryEntry(source_term, suggested_translation, definition, is_translatable,
              category, paragraph_ids, confidence)
AcronymEntry(acronym, expansion | None, paragraph_ids)
EntityEntry(name, kind, paragraph_ids)
SectionAnalysis(section_id, title, summary, page_range, synthetic)
AnalysisProvenance(pipeline_version, prompt_version, provider_base_url,
                   provider_model, provider_protocol, target_language, ...)
```

## ContextBuilder — already built, bounded, tested

```python
ContextBuilder(ir, analysis).build_context(paragraph_id, max_tokens=1500)
```

returns

```python
TranslationContext(
    paragraph_id, page_number, section_id, section_title, section_summary,
    document_summary, academic_domain, glossary: list[ContextGlossaryTerm],
    previous_paragraph, next_paragraph, shed: list[str])
```

Properties, each with a test:

* Neighbours are the **actual adjacent paragraphs in canonical IR reading order**.
* It deliberately has **no field for the target paragraph's own text**.
* Glossary is filtered to terms occurring in the target paragraph (protected), then
  the surrounding section.
* Shedding order when over budget: distant glossary → document summary → section
  summary → neighbour text. The section title and in-paragraph terms are never shed.
* `shed` records what was dropped, so a thin context is distinguishable from a
  context that was truncated.
* Measured on real paragraphs: 1214 / 965 / 994 tokens against a 1500 budget.

## The mapping problem — the crux of this task

Upstream builds a translation unit from characters grouped by a **pixel-level layout
mask**. The IR's paragraphs come from a different segmentation. For the same
12-page paper: **149 translation units vs 101 IR paragraphs.** They do not correspond
one-to-one.

`do_translate(text)` receives **only the text** — no page, no bbox, no id. So the
association must be recovered from the text itself, or the design must accept a
fallback.

An IR↔unit mapping that is merely approximate would attach the wrong paragraph's
section summary and neighbours — **wrong context is worse than none**.

## Constraints

* Do not fork or deeply patch upstream. `BoundedOpenAIlikedTranslator` and upstream's
  extension APIs are the sanctioned surface (ADR-001).
* The translation kernel is otherwise frozen; existing tests must pass unchanged.
* No Paper QA, no embeddings, no vector store, no frontend rewrite.
* Credentials are authorization, not semantics: **an API key must never affect cache
  identity.**
* Source immutability and placeholder/formula safety are standing invariants.

---

# THE QUESTION THAT MUST BE ANSWERED EXPLICITLY

The task brief asks, and the criteria must settle:

> **Must translation cache identity use a per-translation-unit effective-context hash
> rather than only a document-level analysis hash?**

Evaluate it properly rather than for convenience. The argument for per-unit: context
is built per paragraph, so the glossary subset, the neighbours and the section summary
all vary by unit, and a document-level hash would let a unit keep a translation
produced under different context. The argument against: `Cache` is keyed on the source
text, several units share a document, and a context hash that is too fine would
invalidate the whole cache whenever the analysis is regenerated even if the effective
context for that unit is unchanged.

State which you require and why. If the honest answer is "it depends on something the
implementation must decide", say what, and make the criterion testable either way.

---

# WHAT THE CRITERIA MUST COVER

Context modes (**Off** and **Standard**; **Deep** only if a real semantic difference
exists — do not add it to look thorough). Off must preserve today's behaviour exactly.

The prompt contract: translate only the target text; use context merely to resolve
terminology and ambiguity; preserve placeholders, math, citations, model/dataset
names, acronyms, identifiers, URLs and DOIs; do not summarise, explain or annotate;
output only the translation. Explicit delimiters between document context, glossary,
previous paragraph, **target text** and next paragraph. Versioned.

Context leakage: sentinel strings placed only in context must never appear in the
translated output. This is a P0.

Placeholder safety: validate identities, counts, ordering and rich-text balance
between source and translation; one bounded repair attempt with an explicit
instruction; on a second failure, **do not emit corrupted text** — keep the source
unit and record the error. Formula correctness outranks translation completeness.

The mapping: how a unit is associated with an IR paragraph, what confidence means,
and what happens when it cannot be — the fallback must never attach arbitrary context
and must never claim context-aware translation occurred when it did not.

Concurrency: context must be explicit, task-scoped and never global. Two units
carrying distinct sentinels, translated in parallel, must not see each other's context.

Cache identity: source text, source and target language, endpoint, model, protocol
where relevant, prompt version, context mode, glossary hash, effective/context hash,
and generation parameters. **Never the key.**

Missing or failed analysis: choose explicit semantics. Do not silently downgrade and
do not claim context was used when it was not.

Plus: bounded provider failure; source immutability; mono and dual PDF generation;
page-count regression; deterministic mocked tests; a real-provider Off-vs-Standard A/B
that is *measured* rather than assumed; performance overhead; and no Paper QA scope
expansion.

## Out of scope

Paper QA · embeddings · vector database · AI sidebar · Tauri · a glossary editor UI ·
synchronised scrolling · Deep mode if it has no real meaning.

---

# OUTPUT FORMAT

Return:

1. **P0 criteria** — numbered, objectively verifiable, each with a short rationale.
2. **P1 criteria** — important, deferrable with a stated reason.
3. **P2 criteria** — polish.
4. **Explicitly not applicable**, and why.
5. **A direct answer to the effective-context-hash question**, with reasoning.
6. **Any premise you believe is wrong** — including anything in the ground truth above
   you think is mistaken, or any requirement you believe cannot be met without forking
   upstream.

Be specific about observable behaviour. Where a mapping or a judgement genuinely
cannot be certain, require an honest fallback over a plausible guess, and say so.
