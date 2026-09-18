# Acceptance Criteria — DS-CTX-004: Academic Prompt Translation Baseline

- **Author:** Gemini (`gemini-3.8-flash-high`), via the standing two-agent workflow
- **Reviewed and frozen by:** DeepSeek, before implementation
- **Date:** 2026-09-18
- **Baseline:** `4811ae9`
- **Status:** **FROZEN.** **8 P0 · 4 P1 · 3 P2.**

## DeepSeek review

Gemini answered both questions with reasoning rather than preference, and its premise
critiques are sharper than the brief's own framing in two places. One is wrong.

### Corrections

**Gemini's P0.8 diagnoses the flake from a test it did not read.** It attributes the
single unreproduced failure to NTFS `mtime` tick resolution and mandates a clock mock
or a bounded time advance.

`test_force_regenerates_and_leaves_every_other_artifact_alone` asserts **file
contents**:

```python
before = {name: (directory / name).read_bytes() for name in ("source.pdf", "ir.json")}
...
assert (directory / name).read_bytes() == content
```

There is no timestamp assertion anywhere in it, so a timestamp-resolution flake is not
a possible explanation and the prescribed remedy would fix nothing. **P0.8 is amended**
to a diagnosis-agnostic protocol: run it repeatedly, record the result honestly, and
diagnose only if it reproduces.

Measured so far, after the flake: **12 isolation runs and 3 full-suite runs, all
green, not reproduced.**

### Premise critiques accepted

**"Per-unit payload injection is the wrong vehicle for document intelligence."**
Accepted, and better stated than the brief's own conclusion. The DS-CTX-003 result is
not "context is useless" — it is that repeating a 1,000-token summary for *every
sentence* is an architectural anti-pattern. Context belongs in whole-document
understanding, which is where Paper QA will use it.

**"392 seconds conflates an implementation defect with a cost ceiling."** Accepted.
That figure is a *first-run* cost, synchronous with the translation trigger, and my own
DS-CTX-003 criteria already required distinguishing cold from cached. What actually
disqualifies Contextual as a default is the **perpetual 6.58× multiplier and the
elevated failure rate on every call thereafter**, not the one-off wait.

**"Academic mode must bypass cache prefixing entirely."** Accepted, and it is the trap
the authoring prompt identified. Academic sends pure `source_text` to the cache;
`context_mode` in the params column keeps it separate from Basic. A mode that consumes
no analysis must not be invalidated when analysis changes.

### Answer 1 — should Academic become the default?

**Provisionally yes, formally gated on the three-arm benchmark.** Gemini's gates:

```
BETTER > WORSE for Academic vs Basic          (>= 20% net win)
Academic prompt tokens <= 2.0x Basic          (<= 350 tokens/unit)
Analysis duration for Academic = 0 s          (vs 392 s contextual)
Academic failure rate <= 2.2%                 (<= 1 / 45)
```

Representative of the evidence without encoding the conclusion — which is what the
brief asked for. The default does not move until these are met.

### Answer 2 — Contextual mode's product status

**EXPERIMENTAL**, not "Visible Advanced" and not hidden. Gemini's reasoning is right in
both directions: labelling it "Advanced" would imply production-ready superiority when
it costs 6.58× and waits 392 seconds for no observed disambiguation gain; hiding it
would prevent the evaluation on genuinely polysemous papers where a document glossary
*might* help, and would let the machinery rot before Paper QA needs it.

The UI must disclose the cost. 392 seconds without warning is user abandonment.

---

# P0 — must pass (8)

| ID | Requirement | Verification |
|---|---|---|
| **P0.1** | Three modes — `off`, `academic`, `standard` — in `VALID_MODES`. Stored legacy values still deserialize. An unknown mode is rejected **before** a job is scheduled. | Round-trip the three; an invalid string fails fast with a descriptive error. |
| **P0.2** | `academic` dispatches straight to `prompts.translation_messages` with **every context argument `None`**, requires **no** `UnitContextProvider`, and reads no thread-local context. No `DocumentAnalysis`, `DocumentIR` or `ContextBuilder` invocation. | Monkeypatch the analysis pipeline to raise if touched; an Academic translation completes without it. |
| **P0.3** | **Cache identity.** Academic passes **pure `source_text`** to the cache — no context hash, no NUL prefix — and registers `context_mode` and the prompt version as parameters. Mutating `DocumentAnalysis` must still yield a **hit**. `off`, `academic` and `standard` never return each other's entries. Contextual keeps its composite key. | Produce an entry in each mode; mutate the analysis; assert hit for Academic, miss across modes. |
| **P0.4** | **Versioned academic envelope.** `TRANSLATION_PROMPT_VERSION` bumped. With all context `None`, the reference/glossary/neighbour headers are **omitted entirely** — no empty sections. `target_language` is a parameter; **no hardcoded language literal** anywhere in the template. | Render with `Japanese` and `German`; neither contains `Simplified Chinese`; both name their target. |
| **P0.5** | **Placeholder and layout non-regression.** Single-brace `{vN}`; multiset comparison; rewritten shapes (`{{v0}}`, `<b0>`) rejected; exactly one repair; on second failure the **source unit** is returned. | Existing suites pass; malformed responses exercise each branch. |
| **P0.6** | **End-to-end PDF translation in Academic mode.** Mono and dual produced; page count matches source; figures and tables intact; CJK renders; source byte-identical; **no analysis artifact written**. | Real run on a real paper. |
| **P0.7** | **Three-arm benchmark with an objective gate.** Diffusion Policy, `deepseek-flash`, the same 15 units, 3 repeats: Basic / Academic / Contextual. Cost, latency, per-arm provider failures, and pairwise `BETTER`/`SAME`/`WORSE`. The default may not move until the gates above are met. | A persisted result log and score card. |
| **P0.8** | **Flake protocol**, amended: stress the test repeatedly, record the outcome honestly, diagnose only on reproduction. The assertion must not be weakened, skipped or deleted. | The run log. |

# P1 (4)

**P1.1** frontend exposes the three modes with honest labels and an `[Experimental]`
badge on Contextual; switching to Academic or Basic never shows an analysis progress
bar. **P1.2** lazy analysis: opening, reading or Basic/Academic translation never
triggers `DocumentAnalysis`. **P1.3** non-prose units in Academic get the clean
envelope, never a synthetic section or summary. **P1.4** per-job telemetry (mode,
tokens, latency, analysis latency, cached vs live units).

# P2 (3)

A benchmark CLI harness · non-CJK target-language invariant tests · a cache-metadata
inspection utility.

# Explicitly not applicable

Paper QA · embeddings or vector stores · **deleting or weakening Document
Intelligence** · context-payload expansion of any kind · a second PDF parser ·
hardcoded per-paper terminologies.
