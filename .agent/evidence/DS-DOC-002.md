# Evidence — DS-DOC-002 DocumentIR Reading-Order Audit & Stability Gate

- **Date:** 2026-09-18
- **Agent:** DeepSeek (Claude Code CLI)
- **Baseline:** `1d76313` (DS-QA-008 closed)
- **Verdict:** **READING ORDER REPAIR ACCEPTED**, and **IDENTITY_HARDENING_REQUIRED**
  before any feature persists user data against paragraph ids. The repair is one
  constant; the reason it is not the whole answer is that every canonical id in
  this repository is a reading position.

## What changed

```
backend/app/document/extract.py   _MIN_GUTTER_PT 8.0 -> 6.0; IR_PIPELINE_VERSION -> 3
backend/app/qa/index.py           the FTS index now keys on the IR pipeline version
backend/app/context/models.py     AnalysisProvenance.ir_pipeline_version
backend/app/context/persistence.py, pipeline.py, service.py   the check itself
backend/tests/test_document_reading_order.py   +16 tests
```

## The defect, reproduced

Audited against a gold derived **independently of `_column_split`** — the page's
own gutter found at page level, with a band two-column only when its blocks sit
beside each other (overlapping in y) across that gutter:

```
paper              bands  exact-order  pairwise  missed  false   (baseline, 8.0 pt)
resnet                12     10/12      0.9542      0      2
diffusion-policy      16      4/16      0.8158     12      0
ppo                    5       4/5      0.9667      0      1
mamba                  8       5/8      0.8875      1      0
```

Diffusion Policy's twelve misses are the known defect. The handover's figure was
13 of 24 bands; this audit counts 16, because it evaluates bands of three or more
blocks and skips rotated pages. The difference is in the counting, not the finding.

## The sweep, and what it refutes

Every value from 2.0 to 12.0 pt, over ten real papers:

```
threshold   resnet      diffusion     ppo         mamba
 2.0-7.0    0 missed    0 missed      0 missed    0 missed
 7.5-9.0    0 missed   12 missed      0 missed    1 missed
10.0-12.0   0 missed   15 missed      0 missed    1 missed
false splits  2          0-1           1           0-2   <- identical at every value
```

Two things fall out. Missed splits collapse between 7.0 and 7.5 and stay collapsed
— the cliff the 0.6 pt story predicted. And **false splits do not move at all**,
so the ones observed are disagreements with my gold, not artefacts of the floor.
The floor is now **6.0**: below the cliff rather than on it, because a value
placed exactly at the observed boundary would be fitted to these papers.

**Normalization is unmeasured, not rejected.** `page width x 0.010` and
`median font x 0.60` give identical results to the absolute 6.0 on every paper
here — because every paper here is 595-612 pt wide at 10 pt type. The corpus
cannot tell the two apart, so adopting a normalized rule would be an argument
rather than a measurement. Recorded as the first thing to revisit when a corpus
with a different page geometry exists.

## The result

```
paper              bands  exact-order  pairwise  missed        resnet/SAM-style
diffusion-policy      16     15/16      0.9833      0          4/16 -> 15/16
mamba                  8       8/8      1.0000      0          5/8  -> 8/8
resnet                12     10/12      0.9542      0          unchanged
ppo                    5       4/5      0.9667      0          unchanged
```

**Zero missed splits across every paper.** ResNet and PPO are bit-identical
before and after.

**Held-out** (run once, after the candidate was chosen): SAM and ConvNeXt are
genuinely two-column camera-ready papers, unlike the first three arXiv preprints
I downloaded — Attention, DDPM and DETR are all single-column arXiv format, so
they barely exercise column detection and are reported as such rather than as
evidence. SAM: 24 bands, 24/24 exact, pairwise 1.0000. ConvNeXt: 12 bands, 11/12,
0.9762. Both **identical at 8.0 and 6.0**, zero churn.

## Canonical identity — the measurement that decides the Notes gate

`ParagraphIR.id` is `p_<doc>_NNNN`, its **position in the paragraph sequence**;
`TextBlockIR.id` is `b_<doc>_pN_NNN`, its **reading position within the page**.
Nothing is content-addressed. So the question is not "does the fix work" but "what
does it renumber".

```
paper              paragraphs     id+text+blocks unchanged   re-segmented   section table
resnet             101 -> 101               101                    0          identical
ppo                 47 ->  47                47                    0          identical
mamba              274 -> 274               274                    0          identical
sam                212 -> 212               212                    0          identical
convnext            99 ->  99                99                    0          identical
attention/ddpm/detr   unchanged            unchanged                0          identical
diffusion-policy   160 -> 155                 3                  145          DIFFERS
```

**On every paper whose reading order was already correct, the repair changes
nothing at all** — not one paragraph, not one section. Only the broken paper
re-segments, and that is the point: with the columns read in the right order its
sentences genuinely rejoin differently, which is why five paragraphs disappear.

That churn is why the same commit carries two invalidation fixes, both found by
asking *what else holds a paragraph id*:

- **The FTS index** keyed freshness on `content_hash`, which hashes the PDF. Same
  PDF, same schema — so it stayed "fresh" while its `chunk_id`s came to name
  different paragraphs. Every citation built from it would have pointed at text
  that does not support the claim, silently.
- **`analysis.json`** points at paragraphs by id in its glossary, acronyms and
  entities, and was guarded by the *analysis* pipeline version, which cannot see
  the IR. An entity would have been attributed to text that no longer mentions it.

Both now compare the IR pipeline version. `IR_PIPELINE_VERSION` is `"3"`.

## Downstream

```
ResNet section assignment   PASS   16 sections; the only zero-paragraph sections are
                                   the containers 3. and 4.; Abstract and References
                                   own paragraphs — the historical defect stays fixed
Outline hierarchy            PASS   16/50/16/34 sections, every heading box resolves,
                                   parents unchanged, 0 dangling, 0 inverted
Current-section tracking     PASS   DP: 1 -> 2 -> 2.2 -> 2.3 -> 3.1, monotonic
Browser, ResNet/DP/Mamba     PASS   26/26 each, 0 console errors
Determinism                  PASS   3 extractions, identical paragraph ids
Source immutability          PASS   byte-identical after every browser run
```

**Not re-run by this task, and therefore not claimed:** the Selection QA drag
harness and the citation-jump browser suite (`e2e-selection.mjs`, `e2e-qa.mjs`).
The frontend mapping tests pass, and the repair does not touch the frontend, but
"not measured" is not "measured".

## Product decision

### A — READING ORDER REPAIR ACCEPTED

A general repair — one constant, no new algorithm, no paper-specific logic —
eliminates every measured missed split, leaves six real papers bit-identical, and
survives two genuinely two-column held-out papers unchanged.

### Persistent annotation gate

### IDENTITY_HARDENING_REQUIRED

Not because the ids are unstable in use — they are deterministic, and stable
across this repair on every paper that was correct. Because **identity is
positional**, and this task is the second extraction change to renumber it. A
note stored against `p_doc_0042` is a note about "the forty-second paragraph of
this paper", not about a region of the page. The next improvement to extraction —
heading detection, caption linking, paragraph assembly — re-points or orphans it,
and the user finds their note on someone else's sentence.

The evidence is in the table above: a one-constant change re-segmented 145 of 160
paragraphs on the paper it fixed. Any feature that persists user data must wait
for identity that survives that.

## Known limitations

1. **The corpus cannot distinguish absolute from normalized gutter rules.** Every
   paper in it has the same page geometry to within 3%.
2. **The false-split metric is only as good as my gold**, and the gold disagrees
   with the rule on 4 bands across 4 papers at every threshold from 2 to 12. I
   did not resolve those four by hand, so they are reported as gold disagreements
   rather than as pass or fail.
3. **Three of the five held-out papers are single-column** and exercise almost
   nothing; they are listed for completeness, not as evidence.
4. **Selection and citation browser suites were not re-run.**
5. **Retrieval quality was not re-benchmarked.** The index rebuild is tested; what
   BM25 returns from the rebuilt corpus was not measured.
6. **The gutter floor is still an absolute point value**, chosen below the
   observed cliff on ten papers. A page at a very different scale could still be
   misread.

## Recommended next task

**DS-DOC-003 — Stable Canonical Source Identity**, as a prerequisite for
DS-QA-010 (Notes / Persistent Highlights).

The shape is already indicated by the measurements: identity should derive from
content and geometry the page itself supplies — the document fingerprint, the
page, a normalized source region, the block provenance — rather than from a global
ordinal that any upstream improvement can shift. This task has already shown what
such a change must contend with: the FTS index and `analysis.json` both hold
paragraph ids and both needed invalidating for a repair far smaller than an
identity scheme.

Do not start multi-turn conversation.
