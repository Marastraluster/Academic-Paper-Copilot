# Acceptance Criteria — DS-CTX-002: Context-Aware Academic PDF Translation

- **Author:** project maintainer
- **Reviewed and frozen by:** project maintainer, before any implementation code was written
- **Date:** 2026-09-17
- **Baseline:** `940ae5b`
- **Authoring input:** the actual `DocumentIR`, `DocumentAnalysis`, `ContextBuilder`,
  `BoundedOpenAIlikedTranslator`, upstream's `converter.py` and `cache.py`, and the
  translation HTTP API — plus translation units captured from a real run.
- **Status:** **FROZEN.** **24 P0 · 4 P1 · 3 P2.**

Baselines this task must not regress:

```
backend   618 passed
frontend   75 passed
```

## Review before implementation

The criteria review inspected the real code and **corrected the task brief twice**, both times
correctly. It also independently confirmed the placeholder finding.

### Correction 1 — the cache hook is `translate()`, not `do_translate()`

My authoring prompt said context is injected at `do_translate(self, text)`. The review:
*"Injecting context only in `do_translate()` is too late for context-aware caching.
Upstream's `translate()` calls `self.cache.get(text)` before `do_translate(text)`."*

**Verified and accepted.** `BaseTranslator.translate()` consults the cache first, so
context resolved inside `do_translate` would arrive after the cache decision had
already been made with unaugmented parameters — which is exactly how the existing
defect survives. Context resolution, the effective-context hash, and the cache
evaluation all belong in `translate()`, which `BoundedOpenAIlikedTranslator`
**already overrides**. No new seam is needed.

### Correction 2 — `add_params` is shared mutable state

My prompt proposed fixing cache identity with
`add_cache_impact_parameters("base_url", ...)`. The review flagged that doing so per-unit
inside `translate()` would race across upstream's 4 worker threads.

**Verified and accepted.** `TranslationCache.add_params` does `self.params[k] = v`
then re-serialises into `self.translate_engine_params`, which is a *single* string on
a *shared* instance and is part of the table's UNIQUE constraint. Upstream's own
comment concedes the assumption: *"The program typically starts multi-threaded
translation only after cache parameters are fully configured, so thread safety doesn't
need to be considered here."*

**The consequence shapes the implementation.** Global identity — `base_url`, `model`,
`prompt_version`, `context_mode` — is registered **once at construction**. Per-unit
context identity cannot go through `add_params` at all; it must be folded into the
**text passed to the cache**, as `hash + separator + source_text`. That keeps the
per-unit distinction (AC-P0-14) without mutating shared state, and it is what makes
AC-P0-17 and AC-P0-18 achievable rather than aspirational.

### Independently confirmed — the placeholder is single-brace `{vN}`

The brief recorded this from captured text. The review reached it from the source and
cited the line. Both are right, and the two agree:

```
converter.py:275,334   sstk[-1] += f"{{v{len(var)}}}"
```

In an f-string `{{` and `}}` are escapes, so this produces `{v0}`, `{v1}`, … The
`get_formular_placeholder` methods returning `{{vN}}` and the base class's `<bN>`
markers are **dead code for this path**. A validator written from those methods would
reject 100% of valid production translations. AC-P0-10 pins the real format.

### Accepted — "Deep" mode is rejected

The brief permitted Deep "only if a real semantic difference exists". The review:
*"In a pipeline processing isolated units in parallel, there is no technical mechanism
for Deep other than inflating token budget or dumping distant glossary terms."*

Accepted. `OFF` and `STANDARD` only. Adding a mode that means "spend more tokens"
would be inventing a capability to look thorough — the same reasoning that refused
fabricated progress bars and a fake retry endpoint.

### Verified — the cache's storage and key

```
UNIQUE (translate_engine, translate_engine_params, original_text) ON CONFLICT REPLACE
```

`translate_engine_params` is a JSON string of the accumulated params. Today it holds
`temperature`, `stop`, `max_tokens`, `prompt`, `think_filter_regex` — and neither
`base_url` nor `model`. That is the defect, located to the line.

---

# P0 — must pass (24)

## A. Context modes and invariance

| ID | Requirement | Verification |
|---|---|---|
| **AC-P0-01** | **Off parity.** `context_mode="OFF"` must be behaviourally equivalent to today: no context assembly, no IR lookup, no context tokens in the prompt, upstream's default envelope. | Captured outgoing prompt matches the baseline template with zero context sections. |
| **AC-P0-02** | **Standard activates.** Every unit mapped to an IR paragraph is enveloped with the bounded package from `ContextBuilder.build_context`. | Intercepted requests contain domain, section summary, local glossary and neighbours. |
| **AC-P0-03** | **Source and IR immutable** under every mode, including failure and abort. | `source.pdf` and `ir.json` sha256 + mtime identical before and after, on success and on an injected 500. |

## B. Unit↔IR mapping and honest fallback

| ID | Requirement | Verification |
|---|---|---|
| **AC-P0-04** | **Normalised text matching.** Units are associated with IR paragraphs by stripping `{v\d+}`, collapsing whitespace, case-folding, then containment against IR paragraph text. | Units carrying `{v0}`/`{v1}` resolve to the correct canonical `paragraph_id`. |
| **AC-P0-05** | **Conservative ambiguity ceiling.** Below 0.80 overlap, equal-scoring candidates, or no match → `MAPPING_UNRESOLVED`. | Duplicate short headings resolve to `None` rather than a guess. |
| **AC-P0-06** | **Honest fallback.** An unresolved unit falls back to document-level context only (domain + document summary), or empty context — never a section summary or neighbours. Provenance records `FALLBACK_DOCUMENT_ONLY` or `UNMAPPED`. | An unmapped unit has `section_id=None`; output never claims paragraph-level context. |

## C. Prompt delimitation and anti-leakage

| ID | Requirement | Verification |
|---|---|---|
| **AC-P0-07** | **Versioned delimited envelope.** Strict non-colliding delimiters separate reference context from target text; `PROMPT_VERSION = "2.0.0"`. | Envelope contains the reference and target markers; context is marked reference-only. |
| **AC-P0-08** | **Zero context leakage.** Sentinels placed only in context fields never appear in translated output. | Five distinct sentinels injected; zero occurrences in any translation. **Zero tolerance.** |
| **AC-P0-09** | **No conversational filler.** `"Here is the translation:"`, fences and the like are stripped or rejected; only the translation is emitted. | A mock returning a preamble yields output containing only the translation. |

## D. Placeholder and formula safety

| ID | Requirement | Verification |
|---|---|---|
| **AC-P0-10** | **Single-brace `{vN}` invariant**, matching the real converter. `{{v0}}` and `<b0>` are *invalid*. | Regex accepts `{v0}`, `{v12}`; rejects double-brace and tag forms. |
| **AC-P0-11** | **Placeholder identity and multiplicity conserved.** `Counter(placeholders_translation) == Counter(placeholders_source)`. | Dropping, duplicating or inventing a placeholder fails validation. |
| **AC-P0-12** | **Bounded single repair.** On failure, exactly **one** repair request naming the missing/corrupted ids. | Exactly one repair call; a valid repair is accepted. |
| **AC-P0-13** | **Fail-safe source preservation.** A failed repair preserves the **untranslated source unit**, logs it, and continues the document. Corrupted markers must never reach the renderer. | Output contains the original text for that unit; the task records the fallback. |

## E. Per-unit effective-context cache identity

| ID | Requirement | Verification |
|---|---|---|
| **AC-P0-14** | **Per-unit effective-context hash** over the canonicalised context handed to that unit (domain, document summary, section title and summary, filtered glossary, neighbours). | Identical source text under different context yields distinct keys; editing one section's summary invalidates that section's units only. |
| **AC-P0-15** | **Semantic cache key** = `(source_text, source_lang, target_lang, base_url, model, protocol, prompt_version, context_mode, effective_context_hash, temperature, max_tokens, stop)`. | Switching endpoint, model or mode is a miss; a valid hit makes **zero** provider calls. |
| **AC-P0-16** | **Credential invariance.** Rotating the API key never alters cache identity. | Same translation under key A then key B → 100% hits, zero calls. |

## F. Concurrency and isolation

| ID | Requirement | Verification |
|---|---|---|
| **AC-P0-17** | **Unit concurrency isolation.** Under upstream's thread pool, context lookup and prompt construction are thread-safe and strictly unit-scoped. No global "current context". | Four parallel units with distinct sentinels: no request ever carries another's context. |
| **AC-P0-18** | **Thread-safe cache operations.** Concurrent lookups and writes for distinct context hashes complete without races or lock errors. | Four concurrent writers; no `database is locked`; all entries present. |

## G. Missing, partial or failed analysis

| ID | Requirement | Verification |
|---|---|---|
| **AC-P0-19** | **Refuse rather than silently downgrade.** Standard mode with no usable analysis fails immediately with a typed error (`ANALYSIS_UNAVAILABLE`). | Raises in ≤ 50 ms without invoking upstream. |
| **AC-P0-20** | **Granular use of `PARTIAL`.** Units in successfully analysed sections get full context; units in failed sections fall back to document level and record it. | Units in analysed sections carry section context; others carry document context and a diagnostic. |

## H. Bounded failure

| ID | Requirement | Verification |
|---|---|---|
| **AC-P0-21** | **Bounded retries per unit.** Retryable errors cap at 3 total attempts; 401/403/400/invalid-model fail on attempt 1. | 401 → 1 call; 500 → exactly 3. |
| **AC-P0-22** | **Document fast-abort.** The first terminal failure aborts all workers; no further HTTP calls. | With 149 units and 4 threads, a terminal failure on unit 1 bounds total calls to roughly threads + retries. |

## I. Artifacts

| ID | Requirement | Verification |
|---|---|---|
| **AC-P0-23** | **Page invariants.** `pages(mono) == N` and `pages(dual) == 2N`, interleaved, in both modes. | PyMuPDF page counts on a two-page fixture. |
| **AC-P0-24** | **Atomic artifact placement.** Outputs staged and `os.replace`d; an aborted run leaves no partial PDF. | A killed run leaves neither artifact and no staging directory. |

---

# P1 — should pass (4)

**AC-P1-01** measured Off-vs-Standard quality benchmark (terminology consistency and
disambiguation, no placeholder loss) · **AC-P1-02** context assembly ≤ 10 ms mean,
25 ms p99 per unit · **AC-P1-03** unsectioned/bibliography units get document context
without an irrelevant section title · **AC-P1-04** opt-in `-m real_llm` end-to-end test,
offline by default.

# P2 — optional (3)

**AC-P2-01** debug endpoint returning the resolved context and hash for a given text ·
**AC-P2-02** context metrics in the task completion event (`units_total`,
`units_context_aware`, `units_fallback`, `cache_hits`, `repairs_*`) ·
**AC-P2-03** record which glossary terms were injected per unit.

---

# The effective-context-hash question — answered YES

> *Must translation cache identity use a per-unit effective-context hash rather than
> only a document-level analysis hash?*

**Yes.** The reasoning, accepted in full:

1. **Correctness.** Generic strings repeat across sections. Keyed only on source text
   plus a document hash, whichever unit translates first poisons every later identical
   string, ignoring its own section summary and neighbours.
2. **Avoiding invalidation thrashing.** A document-level analysis hash changes whenever
   *any* section changes — a `PARTIAL`→`READY` transition or one corrected summary would
   miss on all 149 units. Per-unit, an unchanged section keeps hitting.
3. **Fallback discrimination.** A unit that later becomes mappable moves from
   `H_fallback` to `H_rich`, so the cache correctly misses and it gets a real
   translation instead of being served the low-context one forever.
4. **Viability.** `BoundedOpenAIlikedTranslator` already owns `translate()`, so this
   needs no upstream change — and per the review above, it is also the *only*
   thread-safe place to put it.

---

# Explicitly not applicable

**Deep mode** (no mechanism exists; rejected rather than inflated) · Paper QA ·
embeddings and vector stores · Tauri and frontend UI (backend-only task) · glossary
editing UI · synchronised scrolling · **modifying upstream source** (ADR-001).
