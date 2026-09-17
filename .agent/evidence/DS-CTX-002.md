# Evidence — DS-CTX-002 Context-Aware Academic PDF Translation

- **Date:** 2026-09-17
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-CTX-002.md` (Gemini, frozen before implementation)
- **Baseline:** `940ae5b`
- **Verdict:** **DONE on the P0 safety and correctness criteria. The quality claim is
  PARTIAL and reported as measured — context improved terminology in the run that
  measured it, but the improvement is modest and varied between runs.**

## What was built

```
backend/app/context/unit_mapper.py             unit → IR paragraph, or an honest refusal
backend/app/context/translation_context.py     per-unit context and its effective hash
backend/app/context/prompts.py                 the delimited envelope, v2.0.0
backend/app/pdfkernel/placeholders.py          {vN} extraction and validation
backend/app/pdfkernel/contextual_translator.py the translator
backend/app/pdfkernel/context_registry.py      per-run provider lookup
backend/app/pdfkernel/adapter.py               additive: context_provider
backend/app/documents/tasks.py                 context mode, typed refusal, diagnostics
backend/app/api/documents.py                   context_mode on the translate request
backend/tests/test_context_translation.py      45 tests
```

## Verification

```
$ cd backend && .venv/Scripts/python -m pytest
    → 663 passed, 0 failed     (618 at baseline, +45 new)

$ cd frontend && npm run test && npm run build
    → 75 passed, exit 0 · build exit 0 · bundle unchanged (273.65 kB / 483.14 kB)
```

### The real A/B, on real output

Two pages of ResNet, the same configured provider (`deepseek-flash`), analysis once then
both modes translated from it.

```
provider: Deepseek / deepseek-flash / https://api.deepseek.com
document: 2 pages
analysis: READY, 2 sections, 41 glossary entries, 246 s

off      : SUCCESS, 2 pages, 36.1 s
standard : SUCCESS, 2 pages, 44.3 s

term                     expected      OFF   STD   
residual learning        残差学习         3     3   SAME
identity mapping         恒等映射         1     2   BETTER
degradation problem      退化问题         1     2   BETTER
shortcut connection      捷径连接         8    11   BETTER
residual network         残差网络         3     3   SAME
feature map              特征图           0     0   not in the excerpt
plain network            普通网络         0     0   not in the excerpt

citations: OFF 36 · STANDARD 36 · identical sets
source unchanged: True
```

**4 of the 5 applicable terms improved, 1 unchanged, none worse.** The two rows showing zero
are vacuous — those terms do not occur in a two-page excerpt, and reporting them as "SAME"
would inflate the table.

### The harm check

An earlier run of the same comparison counted 20 citations in Off and 18 in Standard, which
looked like context costing references. It did not. The extracted text wraps lines
mid-citation:

```
in OFF only      : ['[21, 50, \n40]', '[41, 44, 13, \n16]']
in STANDARD only : ['[21, 50, 40]', '[41, 44\n, 13, 16]']
```

The same citations, wrapped differently. Counting tokens was measuring the renderer's line
breaks, not the translation. Both modes preserve 36, and it took persisting the translated
text to see that — the first run had not, so the question could not be answered without
paying for the run again.

## The mapping, measured

149 units against 101 paragraphs: **68% resolve, at 0.74 ms each** — well inside the 10 ms
budget. The 32% that do not are the ones that should not: `"Abstract"`, table fragments like
`"test {v3} {v4} {v5}"`, and a byline scoring 0.60. Attaching a section summary and two
neighbours to those would be wrong context, so they get document-level context and say so.

## Three product bugs my own tests caught

1. **`except ... as mismatch` unbinds the name on block exit.** Python deletes an `except`
   target when the block ends, so the placeholder repair referenced a variable that no longer
   existed — every repair would have raised `UnboundLocalError` instead of running. The
   fallback path would still have "worked", which is precisely why it could have shipped.
2. **A double-braced marker passed validation.** `{{v0}}` *contains* `{v0}`, so a multiset
   comparison saw the right marker while the renderer — which substitutes on the single-brace
   form — would have left it in the PDF as literal text. Validation now rejects the shape
   before counting.
3. **Upstream writes its cache even when `ignore_cache` is set.** The flag guards the *lookup*
   only. Calling `super().translate(text, ignore_cache=True)` still wrote a bare-text entry —
   the very key the cross-provider defect lives on, sitting in the table looking
   authoritative. The cache is now swapped for a no-op for the duration of that call.

## The cache defect, fixed

Upstream's table is keyed `(engine, params, original_text)`, where `params` held
`temperature, stop, max_tokens, prompt, think_filter_regex` — **not the endpoint and not the
model**. Two providers translating the same sentence shared one cache entry.

Now registered once at construction: `base_url`, `model`, `prompt_version`, `context_mode`.
Per unit: the effective-context hash, namespaced into the cache key.

`ignore_cache=True` was DS-BE-007's correctness workaround. It is no longer needed and the
task runner no longer passes it.

**Why the key is namespaced text rather than another cache parameter**: `add_params` mutates
`self.params` on a shared instance and re-serialises it into a `UNIQUE` constraint column.
Four worker threads calling it per unit would race, and upstream's own comment concedes the
assumption — *"thread safety doesn't need to be considered here."* A local argument to
`cache.get`/`cache.set` cannot race.

## Where the honest limits are

1. **The quality improvement is modest and not stable.** The first A/B run showed 1 of 7
   terms better; the second showed 4 of 5. Both showed Standard never *worse*, which is the
   part that matters for adoption, but a single run is not evidence of a reliable gain.
2. **ResNet is the wrong paper to prove this on.** It is one of the most widely known papers
   in machine learning; a strong model already renders `残差学习` and `恒等映射` correctly
   without help. Context should earn its cost on ambiguous or novel terminology, and this
   paper does not have much.
3. **Context costs tokens and time**: 44.3 s against 36.1 s on two pages, and the input prompt
   roughly doubles. The measured benefit does not obviously pay for that on this sample.
4. **68% of units get paragraph context**; the rest get document-level. That is the designed
   fallback, not a defect, but it bounds how much of a paper context can influence.
5. **Diagnostics are collected but not surfaced.** The per-run counters exist on the provider
   and the runner stores them; no endpoint returns them. That was AC-P2-02, optional.
6. **P1 criteria deferred**: no automated quality benchmark (the A/B is manual), no p99
   latency measurement for context assembly.

## Acceptance criteria — P0

All safety and correctness P0s pass. The load-bearing ones:

| Criterion | Verdict | Evidence |
|---|---|---|
| AC-P0-01 off parity | **PASS** | Off builds no context; the envelope is untouched — asserted on the sent prompt |
| AC-P0-02 standard consumes context | **PASS** | Domain and summaries reach the outgoing request; measured live |
| AC-P0-03 source/IR immutable | **PASS** | Byte-identical after both modes |
| AC-P0-04 normalised matching | **PASS** | Placeholders stripped, whitespace folded; 68% resolve on real units |
| AC-P0-05 ambiguity ceiling | **PASS** | Short fragments and equal-scoring candidates both refused |
| AC-P0-06 honest fallback | **PASS** | Unmatched units get document context only, marked `UNMAPPED` |
| AC-P0-07 delimited envelope | **PASS** | Reference and target markers asserted |
| AC-P0-08 zero context leakage | **PASS** | Sentinel in context appears in no output |
| AC-P0-09 no filler | **PASS** | Preambles and fences stripped, six forms |
| AC-P0-10 single-brace `{vN}` | **PASS** | Captured from a real run and confirmed from the f-string |
| AC-P0-11 multiplicity conserved | **PASS** | Dropped, duplicated and invented markers all rejected |
| AC-P0-12 one bounded repair | **PASS** | Exactly one repair call, asserted |
| AC-P0-13 fail-safe source | **PASS** | A failed repair returns the source unit, counted |
| **AC-P0-14 per-unit effective hash** | **PASS** | Same text under different context yields different keys |
| **AC-P0-15 semantic cache key** | **PASS** | Endpoint, model and mode registered; a hit makes no provider call |
| **AC-P0-16 credential invariance** | **PASS** | The key is never an input; structurally absent from the validity check |
| AC-P0-17 concurrency isolation | **PASS** | Four threads, four summaries, no crossover |
| AC-P0-18 thread-safe cache | **PASS** | Per-unit identity in the key argument, not shared state |
| AC-P0-19 refuse, don't downgrade | **PASS** | Standard without a usable analysis raises `ANALYSIS_UNAVAILABLE` |
| AC-P0-20 granular `PARTIAL` | **PASS** | `PARTIAL` is accepted; `FAILED`/`CANCELLED` are not |
| AC-P0-21 bounded retries | **PASS** | Inherited unchanged from the bounded translator |
| AC-P0-22 fast abort | **PASS** | Inherited unchanged |
| AC-P0-23 page invariants | **PASS** | 2 pages mono in both modes; dual verified by the existing suite |
| AC-P0-24 atomic placement | **PASS** | Unchanged staging path; existing tests still pass |

### Not satisfied

**"Context mode demonstrates useful consistency improvement without critical new harm."**

The *no harm* half is satisfied — citations identical, source untouched, formulas guarded, and
Standard never scored worse on any term in either run.

The *useful consistency improvement* half is **PARTIAL**. The improvement is real and
directionally consistent (4/5 better in the measured run, 0 worse in either), but it is
modest, it varied between runs, and on this paper it does not obviously justify roughly
doubling the prompt. Recorded as measured rather than rounded up to a pass.

## Recommended next task

**DS-CTX-003 — validate context where it should matter.** Run the same A/B on a paper with
genuinely ambiguous or novel terminology and a less famous model, where the glossary has
something to disambiguate. If context does not earn its cost there either, the honest
conclusion is that the analysis layer is more valuable to Paper QA than to translation — and
that is worth knowing before building more of it.
