You are the independent Acceptance Criteria author for a local-first academic PDF
reader + bilingual translator ("Academic PDF Copilot").

Define objective P0 / P1 / P2 acceptance criteria for the next task.

**Do NOT write production code.** Return acceptance criteria only.

---

# TASK — DS-CTX-004: Academic Prompt Translation Baseline

Separate the **proven** value of the academic translation instructions from the
**expensive** document-context payload, and decide which should be the product's
default academic translation behaviour.

```
BASIC       upstream's minimal envelope — fastest, cheapest, no instructions
ACADEMIC    the improved academic prompt only — no DocumentAnalysis dependency,
            no summary, no neighbours, no glossary payload
CONTEXTUAL  the existing DS-CTX-002 context-aware mode — retained, not default
```

## Where the project is

```
backend   666 passed
frontend   75 passed
```

## What DS-CTX-003 measured, and why this task exists

**Mapping is not the bottleneck.** 432 translation units from three real papers,
classified by what each unit *is*: 96.3% of body prose resolves to an IR paragraph,
against a bar of 85%. 90% of unmatched units are captions, headings, tables and
running headers — correctly refused.

**Context was not justified.** Diffusion Policy (arXiv:2303.04137), 15 units × 3
repeats × 2 modes, `deepseek-flash`, 90 real calls:

```
BETTER  4      SAME  10      WORSE  1  (a provider failure, not a bad translation)

Off prompt        186 tokens
Standard prompt  1226 tokens     multiplier 6.58x
Analysis          392 s for 3 pages
Failures          Standard 2/45 · Off 0/45
```

**No ambiguous term was rendered differently between modes.** The feature's stated
purpose is disambiguation — choosing the right sense of `policy`, `action`,
`observation` for the paper's domain — and it did not do that.

**A third arm decided it.** Standard changes the prompt *and* the payload at once, so
the same envelope was run with every context field empty:

```
              identifier kept   citation kept
off                6/15              —
standard           7/15              —        unit 14: True
prompt-only        6/15              —        unit 14: True
```

The prompt-only arm matches Standard on every signal that produced a BETTER call —
on one unit the outputs are character-identical — and matches Off on another. **The
observable gain comes from the prompt, not the payload.**

This is a reduction, not a refutation of the context work. The payload is what the
measurement said does not pay; discarding it from the translation path says nothing
about the Document Intelligence artifacts, which remain.

## An inventory constraint, not an invitation

**Do not delete or weaken `DocumentIR`, `DocumentAnalysis`, `ContextBuilder`,
sections, glossary, domain inference or evidence mapping.** DS-CTX-003 showed they do
not justify being sent with *every translation unit*. It did not show they are
useless. They remain the foundation for Paper QA, whole-paper understanding, section
explanation and citation-aware answers — which is where the strong artifact
(96.3% evidenced glossary, 24 of 29 acronyms honestly left unexpanded, zero
fabrications) is expected to pay.

**This task must not attempt to save Contextual mode by adding more context.**

---

# VERIFIED GROUND TRUTH

## The current implementation

```python
# app/context/translation_context.py
MODE_OFF = "off"; MODE_STANDARD = "standard"; VALID_MODES = (MODE_OFF, MODE_STANDARD)

# app/context/prompts.py
TRANSLATION_PROMPT_VERSION = "2.0.0"
def translation_messages(*, target_text, target_language, document_summary=None,
                         academic_domain=None, section_title=None, section_summary=None,
                         glossary=None, previous_paragraph=None, next_paragraph=None)
```

`translation_messages` already renders correctly with **every context field empty** —
that is exactly what the DS-CTX-003 third arm called, and it is what ACADEMIC mode
should send. Its envelope is:

```
=== ACADEMIC CONTEXT (REFERENCE ONLY - DO NOT TRANSLATE) ===
=== GLOSSARY (use these renderings where the term occurs) ===
=== PREVIOUS PARAGRAPH (reference only, do not translate) ===
=== TARGET SOURCE TEXT (TRANSLATE THIS ONLY) ===
=== NEXT PARAGRAPH (reference only, do not translate) ===
```

with a system message instructing identifier, citation, placeholder and notation
preservation, and forbidding summary, explanation and commentary.

**With no context supplied, the reference and neighbour sections are simply absent**
— the envelope degrades to instruction plus target. That is the mode.

## Where behaviour is decided

```python
# app/pdfkernel/contextual_translator.py
class ContextualOpenAIlikedTranslator(BoundedOpenAIlikedTranslator):
    def __init__(...):
        self._provider = lookup(envs[RUN_ID_ENV])
        mode = "off" if provider is None else provider.mode
        self.add_cache_impact_parameters("base_url", ...)
        self.add_cache_impact_parameters("model", ...)
        self.add_cache_impact_parameters("prompt_version", TRANSLATION_PROMPT_VERSION)
        self.add_cache_impact_parameters("context_mode", mode)

    def translate(self, text, ignore_cache=False):
        unit = self._provider.for_unit(text)
        if unit is not None and not ignore_cache:
            hit = self.cache.get(unit.cache_key)      # namespaced by context hash
            if hit: return hit
        ...
    def prompt(self, text, prompt_template=None):
        context = getattr(_UNIT_CONTEXT, "value", None)
        if context is None:
            return super().prompt(text, prompt_template)   # upstream's envelope
        return prompts.translation_messages(...)            # the academic envelope
```

**The important detail**: the academic envelope is currently reachable *only* when a
context object exists. With no provider, or in Off, `prompt()` falls through to
upstream's minimal envelope. ACADEMIC mode needs the envelope **without** a
`UnitContextProvider` — no IR, no analysis, no mapper.

## Cache identity, and the trap this task must avoid

Upstream's cache is keyed `(engine, params, original_text)`, where `params` holds
`base_url`, `model`, `prompt_version`, `context_mode`, and `temperature/stop/max_tokens/
prompt/think_filter_regex`. Per-unit identity travels in the **cache key text** as
`context_hash + NUL + source_text`, because `add_cache_impact_parameters` mutates
shared instance state and four worker threads calling it per unit would race.

**The trap**: if ACADEMIC mode reuses the per-unit context hash, a mode that consumes
no context would be invalidated whenever `DocumentAnalysis` changes. The criteria must
require that ACADEMIC's cache identity **excludes** analysis, section, paragraph and
glossary hashes, and includes only the academic prompt version and the generation
parameters. Contextual keeps its richer identity.

## Safety machinery that must not regress

* Placeholders are **`{vN}`, single-brace**, confirmed from a captured run and from
  `converter.py:275` `f"{{v{len(var)}}}"` whose doubled braces are f-string escapes.
  Validation compares multisets, rejects rewritten shapes (`{{v0}}`, `<b0>`), allows
  **one** targeted repair, and on a second failure returns the **source unit**.
* Unmatched units receive **no context** (the DS-CTX-003 correction) and share the
  off-mode cache entry. Headings, captions, tables and headers must not receive a
  document summary.
* Concurrency: context in a thread-local, per-unit identity in the cache key argument.
* Source and IR immutable. No second PDF parser.

---

# WHAT THE CRITERIA MUST COVER

The academic prompt: a concise **versioned** envelope carrying the intent in the brief
— rigorous natural academic language; preserve technical meaning, mathematical
notation, placeholders, citations, model names, dataset and benchmark names, acronyms
where appropriate, code identifiers, URLs and DOIs; do not summarise, explain, add
commentary; output only the translation. Where terminology is ambiguous, choose the
reading appropriate to the immediate sentence and to academic usage.

**The target language must be a parameter.** Nothing may hardcode Simplified Chinese
into the abstraction.

**ACADEMIC mode must not run DocumentAnalysis.** Clicking Translate must start
translating, not wait 392 seconds for a paper analysis. That is one of the main
reasons the mode exists. DocumentAnalysis stays lazy — created when Contextual
translation or a future analysis feature needs it.

**Mode naming must not be ambiguous internally**, and an existing enum must not be
changed in a way that breaks stored tasks unnecessarily.

**Default mode is decided by measurement, not by expectation.** The evidence points
toward Academic; the criteria must require the three-arm comparison before the
default moves.

The real benchmark reuses the same paper and model to control variables: Diffusion
Policy, `deepseek-flash`, the same evaluation subset, **three repeated runs**, with
`BETTER`/`SAME`/`WORSE` classifications for **Academic vs Basic** and **Contextual vs
Academic**. Cost measured as tokens and latency across all three, with Contextual
split into first-run (includes analysis) and cached-run. Provider failures tracked
separately **by mode** — DS-CTX-003 observed 2/45 for Contextual and 0/45 for Basic,
and conflating a provider failure with a poor translation would be wrong.

**A real PDF end-to-end** in Academic mode: no analysis required, mono and dual PDFs
produced, page counts valid, placeholders valid, citations preserved, figures intact,
CJK present, source byte-identical.

**One unreproduced test failure was observed** in DS-CTX-003
(`test_force_regenerates_and_leaves_every_other_artifact_alone` — failed once in a
full run, passed four times elsewhere). The brief requires running it repeatedly and
determining whether it is a race, a timing sensitivity or an environment flake, and
recording the result honestly either way. **The criteria should say what evidence
would settle it and what to do when it cannot be reproduced.**

## Out of scope

Paper QA · embeddings or vector stores · deleting or weakening Document Intelligence ·
new context mechanisms · context-payload improvements of any kind.

---

# THE TWO QUESTIONS REQUIRING A DIRECT ANSWER

> **1. Should Academic prompt-only mode become the default translation mode based on
> the DS-CTX-003 evidence?**

> **2. Should Contextual mode remain user-visible, become Advanced/Experimental, or
> remain backend-only for now?**

Answer with reasoning. On the second, weigh: 6.58× tokens, 392 seconds of analysis, no
uniquely observed disambiguation benefit — against the possibility that the experiment
was underpowered (15 units, one paper, one model) and that a mode with a real gain
somewhere would be lost by hiding it.

## The decision this task must end with

```
A. ACADEMIC DEFAULT              best quality/cost tradeoff as a default
B. BASIC DEFAULT, ACADEMIC OPTIONAL   academic gain too small for even its small overhead
C. CONTEXTUAL STILL JUSTIFIED    only if new evidence substantially contradicts DS-CTX-003
D. INCONCLUSIVE                  provider instability or experiment quality prevents a conclusion
```

**Do not select A before measurement.**

## Product status for Contextual mode (a second, separate decision)

```
VISIBLE ADVANCED · EXPERIMENTAL · HIDDEN / DEVELOPER ONLY
```

---

# OUTPUT FORMAT

Return:

1. **P0 criteria** — numbered, objectively verifiable, each with a rationale.
2. **P1 criteria**, 3. **P2 criteria**.
4. **Explicitly not applicable**, and why.
5. **Direct answers to the two questions**, with reasoning.
6. **Any premise you believe is wrong** — including anything in the ground truth here
   you think is mistaken, or any part of this plan you believe would degrade the
   product.

Be specific about observable behaviour. Where a judgement is a matter of degree, say
what threshold is defensible and why.
