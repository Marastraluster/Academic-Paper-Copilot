# Evidence — DS-QA-007 Hybrid Semantic Retrieval Experiment

- **Date:** 2026-09-18
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-QA-007.md` (Gemini, frozen before
  implementation, with four `AC_CHANGE_REQUEST`s, all resolved)
- **Baseline:** `80c753c` (DS-QA-006 final)
- **Verdict:** **The experiment passed its own gate and the adoption gate failed.**
  Dense retrieval recovers evidence that no lexical path reaches — and changes
  exactly nothing a reader can see, because the rewrite cascade was already
  answering those questions. The specified hybrid fusion ranks *worse* than the
  dense arm alone.

## What was built

```
backend/app/qa/dense.py              the experiment: ONNX E5-small, scope-masked,
                                     canonical-id corpus, fingerprinted cache
backend/app/qa/retrieval.py          +dense_ranking (default None), +sources provenance
backend/app/qa/answering.py          +dense_ranking passthrough (default None)
backend/app/qa/models.py             +EvidenceItem.sources, +2 Diagnostics fields
backend/pyproject.toml               +[experiment] extra: tokenizers
backend/tests/test_qa_dense.py       +27 tests, model-free
```

The default production path is unchanged, and that is **measured, not asserted**:
the lexical arm re-run after the `retrieval.py` change is bit-identical to the run
before it (Hit@1/3/5/10 49/64/70/81%, MRR 0.578, same per-question ranks).

## Verification

```
backend       844 passed   (817 before this task)
frontend      150 passed
typecheck     PASS
build         exit 0
bundle        307.03 kB initial (ceiling 350 kB) — unchanged; frontend untouched
real browser  48/48, including byte-identical stored source PDFs
```

## The three arms

Whole-paper scope, candidate depth 20, evidence window 10, same questions, same
gold. `dev` is the 33-question diagnostic set; `held-out` is 14 fresh questions on
Mamba (arXiv 2312.00752), **authored before any dense retrieval existed**.

```
                        Hit@1   Hit@3   Hit@5   Hit@10    MRR
all 47 questions
  lexical                23/47   30/47   33/47    81%     0.578
  dense                  29/47   36/47   37/47    87%     0.700
  hybrid                 28/47   33/47   35/47    85%     0.669

held-out Mamba (14)
  lexical                 5/14    7/14    8/14    71%     0.463
  dense                   9/14   11/14   11/14   100%     0.726
  hybrid                  7/14   10/14   10/14    93%     0.613

cross-language (8)
  lexical                  0/8     0/8     0/8     1/8     0.014
  dense                    1/8     1/8     1/8     2/8     0.146
  hybrid                   1/8     1/8     1/8     2/8     0.143
```

## The finding that decides the task

**Dense retrieval beats the shipped lexical path on every aggregate metric, and
the product outcome is identical.** Measured end-to-end through the real provider
and the real answer generator:

```
cross-language avoidable abstentions    0 -> 0      (all 8 already ANSWERED)
unanswerable under hybrid              19/19 abstain
false supported answers                    0
```

The premise this task inherited from DS-QA-006 was **wrong at product level**. The
five `NOT_RETRIEVED` cases were classified `NOT_RETRIEVED` by
`rank_diagnosis.py`, which measures the *local lexical path in isolation*. The
shipped path is not that: `generate_answer` runs a rewrite cascade, `needs_rewrite`
fires on a CJK query against English text, and the rewritten query retrieves fine.
So "no query variant retrieved the gold" was true of the arm being measured and
false of the product — the exact confusion DS-QA-006's own evidence warned about,
reappearing one layer up.

This is the second consecutive task where retrieval metrics moved and answers did
not. The first time it was because neighbouring paragraphs carried the content;
this time it is because a different component had already solved it.

## Why hybrid is worse than dense alone — and how my first explanation was refuted

Dense alone beats the specified hybrid, which is a surprising result and was
investigated at the source before anything was concluded.

**Hypothesis 1 (mine, and wrong):** coverage dominates the fusion. DS-QA-006
measured that `α = 0.05` exceeds the entire RRF band [0.0125, 0.0328], so a
term-overlap bonus would penalise exactly the dense-contributed candidates.
Measured on five disagreements: **true on 2 of 5**. On the others the coverage
signal is *saturated* — every leading candidate ties at 1.00 or 0.50, so it adds a
constant and RRF decides — and on the two Chinese probes it is 0.00 for everything
and contributes nothing at all. It cannot explain the cross-language behaviour,
which is where the arm actually loses. Recorded as refuted.

**Hypothesis 2 (measured, and it holds):** equal-weight fusion cannot beat its
better component unless the worse one contributes unique correct answers, so
hybrid should land strictly between its arms. It does, on all four measurements:

```
                 Hit@5                 MRR
all 47     33 < 35 < 37      0.578 < 0.669 < 0.700
held-out    8 < 10 < 11      0.463 < 0.613 < 0.726
```

## Gate evaluation

**GATE 1 — EXPERIMENT SUCCESS: PASS.** Baseline reproduced exactly, three arms
measured over 47 questions, candidate-pool recall recorded for all nine
`NOT_RETRIEVED` golds, 100% local CPU, artifacts recorded.

**GATE 2 — PRODUCTION ADOPTION: FAIL**, on three clauses:

```
FAIL  G2.1a  dense recovered 3/5 diagnostic NOT_RETRIEVED into pool@20  (needs >= 4)
FAIL  G2.1b  hybrid put 0/5 of them into Top-5                          (needs >= 3)
FAIL  G2.2d  1/3 unretrieved held-out cross-language into Top-5         (needs >= 2)
PASS  G2.2a  held-out Hit@5 71.4%      PASS  G2.2b  held-out Hit@1 50.0%
PASS  G2.2c  MRR delta +0.151          PASS  G2.3  zero regressions
PASS  G2.5   hybrid retrieval p95 23.2 ms, max 29.4 ms
```

G2.2a and G2.2b land **exactly** on their thresholds, which is worth naming: a
gate that is met to the decimal by a configuration that fails three other clauses
is not evidence of a near miss, it is evidence that the thresholds were guessed.

## Cost (Phases 38–42, 75, 76)

Two costs, kept separate: the first document pays embedding, every later query
pays one query embedding and a matrix product.

```
model                intfloat/multilingual-e5-small  (XLM-R, 384 dims, vocab 250k)
runtime              onnxruntime CPUExecutionProvider, AVX2 (no AVX512-VNNI)
model cache          487.4 MB  (fp32 470.3 MB + tokenizer 17.1 MB)
quantized weights    118.1 MB  (25.1% of fp32, dynamic int8, done locally)

                      units   build_s   cached_load_ms   on-disk
  ResNet                115      4.37            2.25     0.164 MB
  Diffusion Policy      186      4.19            2.83     0.264 MB
  PPO                    58      1.85            0.91     0.083 MB
  Mamba                 295      6.64            3.26     0.418 MB

query embedding      median 4.2 - 41.3 ms across runs, p95 6 - 158 ms
dense search         median 0.16 - 0.36 ms   (295 candidates, NumPy matmul)
hybrid retrieval     p95 23.2 ms, max 29.4 ms  (through the real `retrieve()`)

storage              mean 0.233 MB/document;  100 papers ~ 23.3 MB + 487 MB once
```

**The query-embedding spread is real and is reported as a spread.** Repeated runs
of the identical measurement gave median 4.25 / 7.51 / 10.62 / 41.35 ms, with the
**minimum consistently 4.2–4.5 ms** and the p95 ranging 6–158 ms. ONNX Runtime runs
with its default thread count (16 cores visible), so it competes with everything
else on the machine — including, during these measurements, a Chromium instance
from the browser suite. The minimum is the uncontended cost; the p95 figures above
50 ms are contention, not the model. Reporting only the best run would have made
AC-P1-05's 50 ms ceiling look comfortably met; reporting only the worst would have
made it look failed. Neither is the measurement.

The matmul itself — the part that would justify a vector database — is
consistently **0.16–0.36 ms** for 295 candidates. That is 100× below the criterion,
and it is the number that settles Phase 71.

**Memory, and a criterion that is not reachable.** Working set in a *fresh*
process, at each stage:

```
                     fp32      int8
fresh process         16 MB     16 MB
after imports        102 MB    102 MB
after session load   835 MB    503 MB     <- AC-P1-06 ceiling: 300 MB
after document build 1545 MB   1213 MB
```

AC-P1-06 permits fp32 on disk (≤500 MB) and caps resident memory at 300 MB. Both
precisions fail the memory clause; the runtime's own arena and loaded graph cost
more than the weights. AC_CHANGE_REQUEST 3 resolved this in favour of the memory
ceiling and made int8 required — and int8 still misses by 200 MB. The disk clause
is also internally inconsistent for the same reason.

**Quantization is not free.** Re-running every arm against int8:

```
                    fp32            int8
held-out Hit@1      7/14  (50.0%)   6/14  (42.9%)   <- G2.2b passes only on fp32
held-out MRR        0.613           0.579
all-47 MRR          0.669           0.647
```

So the configuration that gets closest to the memory ceiling is the one that
drops Hit@1 below another criterion's floor. Every number in this document's
headline tables is **fp32**; int8 is reported as the ablation it is.

## False semantic matches (Phase 34)

The safety risk is real and was observed at the retrieval layer. For *"What AdamW
weight decay was chosen for the optimizer?"* — a question ResNet does not answer,
since it uses SGD — dense returns, at +0.818, the paragraph *"We use a weight
decay of 0.0001 and momentum of 0.9"*. That is `RELATED_BUT_NOT_EVIDENCE`: it
names the asked-for concept and does not answer the question, which presupposes
AdamW. Similar topically-adjacent hits appear for the camera-focal-length and
training-epochs questions.

**It did not become a false answer.** Feeding exactly those bundles through the
existing generator, 19/19 unanswerable questions still abstained with zero
citations and zero false supported answers. The grounding layer is robust to a
semantically plausible but non-evidentiary paragraph, which is the property the
whole safety argument rests on — and it is measured here against hybrid evidence
specifically, not assumed from the production path being untouched.

## Product decision: **A — REJECT SEMANTIC RETRIEVAL**

Not because dense retrieval does not work. It works: it is a better retriever than
the shipped lexical path on every aggregate measure, it recovers the English
synonym class (`momentum`, lexical absent → dense rank 7), and it ranks the
held-out Mamba paper's golds at Hit@5 11/14 against lexical's 8/14.

It is rejected because:

1. **No product effect.** Avoidable abstentions 0 → 0. The rewrite cascade
   already answers every cross-language question; the class this task was
   chartered to fix was never broken in the product.
2. **The frozen adoption gate failed**, on three clauses, including the one that
   names that class.
3. **The specified architecture is worse than one of its components.** Fusion
   with equal weights drags the better retriever toward the worse one, measured
   on all four aggregate comparisons.
4. **Cost without benefit.** 487 MB downloaded, 503 MB resident, on every user's
   machine, for a change no measurement here shows reaching a reader.

Per Phase 72 and AC_CHANGE_REQUEST 4, a rejected experiment wires nothing into the
default path. The experiment code is committed behind its boundary; the two
`None`-defaulted parameters are the only production-surface change, and the
lexical baseline is bit-identical with them.

**Vector database: NO.** 295 chunks × 384 dims is 0.45 MB and the matmul takes
0.24 ms. Confirmed by measurement, not by convention.

## Known limitations

1. **The experiment's premise was false at product level**, and that was not
   established until Phase 36. A cheaper first step would have been to ask
   whether the `NOT_RETRIEVED` class survives the *shipped* pipeline before
   building anything.
2. **Dense-only's advantage is unexplained.** It beats lexical by 6 points of
   Hit@5 and 0.12 MRR on the held-out paper while changing no answer state. Either
   the benchmark measures something the product does not surface, or the effect is
   real and invisible — this experiment cannot tell which.
3. **The coverage term remains un-retuned for a two-retriever pool.** It was
   designed when every candidate had matched a query term. Its effect here is
   provably small (2/5 probes) but it was never designed for this input.
4. **`AC-P1-06`'s 300 MB ceiling is unreachable at any precision measured.**
5. **int8 costs Hit@1** (50.0% → 42.9% on held-out), so the cheaper artifact is
   also the weaker one.
6. **One embedding model, one benchmark pair.** E5-small on three tuning papers
   plus one held-out paper. Nothing here generalises to other models.
7. **Long paragraphs truncate at 512 tokens.** Mamba's max paragraph is 4960
   characters; the tail of the longest ones is not embedded.
8. **The Mamba extraction has artifacts** (`Cfunctions`, `Nis`); gold phrases were
   chosen to avoid them, but the corpus itself contains them.

## Disposition of artifacts

- `backend/tmp_test/` — **removed.** Six DS-QA-006 analysis scripts preserved to
  the gitignored `.agent/results/qa/ds-qa-006-gemini/`; 3.1 MB of pytest
  `--basetemp` scratch deleted. Every PDF inside was a synthetic 807-byte fixture;
  no credentials, no real paper. Recorded in Phase 0.
- **Model weights are outside the repository** (`%LOCALAPPDATA%`), so they cannot
  be staged by accident. Nothing was committed.
- **`embeddings.npz` was written into the real user document directory** by the
  profiler and has been **deleted** (163,998 bytes); the directory is back to
  `analysis.json`, `ir.json`, `search.db`, `source.pdf` (Phase 74).

## Recommended next task

**DS-QA-008 — Paper Outline / Structured Navigation** (the rejection branch).

Not because retrieval is solved, but because this experiment's most useful result
is negative in an informative way: **the retrieval layer is not the product's
bottleneck.** Every cross-language question answers, 19/19 unanswerable abstain,
counterfactual grounding holds, and a better retriever changed none of it. The
open question is what a reader cannot *do*, not what retrieval cannot find.

The one datapoint worth carrying forward is limitation 2 — dense-only outperforming
the shipped path on the held-out paper while changing no answer state. It is a real
measurement and it is unexplained. It is recorded as a candidate for a future
experiment, not as a recommendation to continue this one.
