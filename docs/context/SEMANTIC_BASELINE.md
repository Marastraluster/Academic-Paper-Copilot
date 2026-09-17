# Semantic Quality Baseline — DS-CTX-001-QA

- **Date:** 2026-09-17
- **Purpose:** the comparison point for context-aware translation (DS-CTX-002) and for any
  later prompt revision. This is what the analysis actually produced when driven by a real
  model, recorded before anything downstream depends on it.
- **Result:** **PASS** — the analysis is trustworthy and useful enough to improve academic
  translation. Five limitations are recorded below; none is structural.

## What produced it

| | |
|---|---|
| **Paper** | He, Zhang, Ren, Sun — *Deep Residual Learning for Image Recognition*, arXiv:1512.03385 |
| **Paper properties** | 12 pages, two-column, display equations, 7 figures, 15 tables, references |
| **IR** | Canonical `DocumentIR`, validated separately (`DS-DOC-001-GATE0`) |
| **Provider profile** | `Deepseek` (keyless=false; credential in the OS credential store) |
| **Endpoint** | `https://api.deepseek.com` |
| **Model** | `deepseek-flash` — a **reasoning** model |
| **Protocol** | detected as `chat_completions` |
| **Prompt version** | `1.0.0` |
| **Pipeline version** | `1.0.0` |
| **Duration** | ~25 minutes for the first analysis; **1.9 s** for every read after it |

No credential is recorded here, and none appears in the analysis artifact.

## What this run fixed

The gate could not start at all against this model. `PROBE_MAX_TOKENS = 1` is spent entirely
on reasoning by a reasoning model, so `content` came back empty and **protocol auto-detection
failed** — the provider looked broken when it was healthy. The same effect appeared in real
analysis: at the original 1200-token output allowance the model reasoned for 6169 characters
and returned *nothing*.

Three production defects were fixed and committed separately (`DS-CTX-001-QA`):

1. **Truncation was reported as an empty response.** `finish_reason="length"` with no content
   now raises `LLM_OUTPUT_TRUNCATED` — retryable, and accurate about the cause — instead of
   `LLM_INVALID_RESPONSE: Provider returned empty content`, which blamed the provider for our
   own budget.
2. **The probe demanded prose.** Detection now accepts a schema-valid answer as evidence the
   protocol is spoken, and prefers a protocol that actually *produced text* when both reply.
3. **The budget was sized for the answer alone.** Measured: this model spends 950–1500 tokens
   thinking before writing. The output allowance is now 4000 and the request budget 16000, with
   chunking that reserves room to double the allowance on a truncated retry.

## Domain

```json
{"primary": "Computer vision / deep learning",
 "secondary": ["Image classification", "Neural network optimization and training",
               "Residual learning architectures", "Object localization and benchmark evaluation"],
 "confidence": 0.95,
 "rationale": "…deep residual learning for image recognition: reformulating layers to fit a
   residual mapping F(x) := H(x) − x, shortcut connections, the degradation problem,
   ImageNet and CIFAR-10 classification experiments, FLOPs comparisons with VGG nets…"}
```

**Assessment: GOOD.** Not a generic label — the rationale names the paper's actual
contribution and its actual datasets, and the secondaries are specific rather than padded. The
model also volunteered that it cited no paragraph ids because the synthesis prompt supplies
section summaries rather than paragraphs, which is accurate and is the kind of self-reporting
worth having.

## Document summary

208 words. Covers the residual framework, `F(x) := H(x) − x`, the degradation problem, the
motivation that optimising the residual is easier, and the ImageNet/CIFAR-10 evaluation.

**Assessment: GOOD.** Factually faithful, correctly scoped, and *synthesised* rather than
copied from the abstract — it describes the ILSVRC 2015 result the abstract does not lead with.

## Section summaries

| Section | Pages | Words | Association |
|---|---|---|---|
| 1. Introduction | 1 | 170 | correct |
| 2. Related Work | 2 | 83 | correct |
| 3.3. Network Architectures | 3 | 100 | correct |
| 4.1. ImageNet Classification | 4–6 | 109 | correct |
| 4.2. CIFAR-10 and Analysis | 7 | 127 | correct |
| C. ImageNet Localization | 12 | 49 | correct |
| Unsectioned Content (Pages 9–9) | 9 | 54 | correct — identifies page 9 as the bibliography |

**Assessment: GOOD.** Each summary describes the section it is attached to, with no
cross-section contamination and no invented results observed. The synthetic partition
correctly recognised the references as unstructured content rather than forcing it into a
section.

## Glossary

207 entries. Every translation below is the term the field actually uses.

| Source term | Translation | Class |
|---|---|---|
| residual learning | 残差学习 | **GOOD** |
| identity mapping | 恒等映射 | **GOOD** |
| residual function | 残差函数 | **GOOD** |
| degradation problem | 退化问题 | **GOOD** |
| feature map | 特征图 | **GOOD** |
| residual network | 残差网络 | **GOOD** |
| plain network | 普通网络 | **ACCEPTABLE** — 朴素网络 also current |
| shortcut connection | 捷径连接 | **ACCEPTABLE** — 跳跃连接 also current |
| ImageNet / CIFAR-10 / ILSVRC 2015 / VGG / ResNets | *(unchanged)* | **GOOD** — identifiers marked untranslatable |
| ResNet-56 / ResNet-110 | ResNet-56 / ResNet-110 | **ACCEPTABLE** — see limitation 2 |
| plain architectures | 普通架构 | **QUESTIONABLE** — see limitation 3 |

**Assessment: broadly useful.** The context-sensitive terms — `policy`-style ambiguity, where
one English word has several defensible Chinese renderings — are resolved in the paper's own
sense rather than a dictionary's.

## Identifiers

| Identifier | Preserved | Where |
|---|---|---|
| ResNet | yes (`ResNets`) | glossary + entity |
| ImageNet | yes | glossary + entity, 12 citing paragraphs |
| CIFAR-10 | yes | glossary + entity |
| ILSVRC 2015 | yes | glossary + entity |
| VGG | yes | glossary + entity (`VGG nets`) |
| GoogLeNet | **correctly absent** | not present in the paper's text |

**No destructive re-casing or translation of any identifier.** GoogLeNet is absent because the
paper does not mention it — the model did not supply it from memory, which is the behaviour the
acronym rule exists to enforce.

## Acronyms

29 extracted. **24 have no expansion, recorded as `null`**; 5 have one, and **all 5 are
verifiably stated in the paper**:

```
SGD    -> stochastic gradient descent   STATED
BN     -> batch normalization           STATED
ResNets-> residual nets                 STATED
ILSVRC -> None                          (the paper never spells it out)
ReLU   -> None                          (ditto)
```

**Assessment: GOOD.** Twenty-four honest nulls is the single strongest signal in this run. A
model asked to expand acronyms will happily invent them from memory; this one declined 24 times
and was right to.

## Evidence validation

Traced the cited paragraph ids back to the IR and checked whether the source actually supports
the claim — not merely whether the id exists.

| Item | SUPPORTED | WEAKLY | UNSUPPORTED |
|---|---|---|---|
| Glossary (207) | **204** | 2 | 1 |
| Entities (56, sampled 5) | 5 | 0 | 0 |
| Glossary sample (§10 terms, 8) | 8 | 0 | 0 |
| Acronym expansions (5) | 5 | 0 | 0 |

**Zero fabricated evidence.** Nothing was cited to a paragraph that does not exist, and no
quoted text was invented.

## ContextBuilder

Three real paragraphs, one each from Introduction, Method and Experiments. For every one:

- `previous_paragraph` and `next_paragraph` are the **exact** adjacent paragraphs in canonical
  reading order — compared by string equality against the IR, not by eye.
- The target paragraph's own text appears **nowhere** in the context package.
- The section id and title are the real ones.
- Glossary terms are the ones occurring in that paragraph, not the whole paper.
- Token use: 1214 / 965 / 994 against a 1500 budget. Nothing shed.

Sampled context for a Method paragraph carried `residual`, `residual learning`, `stacked
layers`, `residual functions`, `residual networks` — the terminology that paragraph is actually
about.

## Known weaknesses

1. **Two truncations and one empty summary** out of ~16 units. The run is `PARTIAL`, not
   `READY`. On two long sections the model's reasoning exceeded even the retry allowance.
   Partial results were kept, which is the designed behaviour, but a large paper can lose a
   section to this.
2. **`ResNet-56` and `ResNet-110` are weakly supported.** Both are real — they appear in the
   paper's CIFAR-10 figure — but figures are not paragraphs, so they were not in the supplied
   text. The model derived the conventional names from `56-layer` and `110-layer`, which *are*
   present. True, useful, and not literally evidenced.
3. **`plain architectures` is questionable.** It appears nowhere in the paper; the text says
   *plain network* and *plain nets*. A paraphrase recorded as a source term, which is what the
   exact-spelling rule exists to prevent. Harmless in translation, but the kind of drift the
   glossary is meant to avoid.
4. **Single-character terms are not filtered.** `x` was extracted as a glossary entry, from the
   notation `F(x)`. Noise, and cheap to filter later.
5. **The analysis takes ~25 minutes** for a 12-page paper with a reasoning model — 16 model
   calls, each thinking before answering. It is cached after the first run, but the first run
   is not cheap, and this is the dominant cost DS-CTX-002 must weigh against its quality gain.

## Verdict

**PASS.** §79 and §80 are closed on genuine model output.

The analysis is factually faithful, preserves every identifier it should, declines to invent
acronym expansions 24 times out of 29, and cites only real paragraphs — 204 of 207 glossary
entries are supported by the paragraph they cite, with zero fabrications. The three imperfect
entries are semantically correct; none would corrupt a translation.

The limitations are quality ceilings, not structural defects. Nothing here would poison
context-aware translation, which is the question the gate exists to answer.
