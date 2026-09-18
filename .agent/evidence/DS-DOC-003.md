# Evidence — DS-DOC-003 Stable Canonical Source Identity

- **Date:** 2026-09-18
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-DOC-003.md` (Gemini, authored
  **before** implementation, with three `AC_CHANGE_REQUEST`s, all resolved before
  any code was written)
- **Baseline:** `eb7eb1d` (DS-DOC-002 closed)
- **Verdict:** **STABLE SOURCE IDENTITY READY**, and **READY_FOR_NOTES**. On the
  one real extraction change this repository has, 150 of 160 anchors were
  bit-identical and the other ten reattached by their own text, with **zero wrong
  attachments**.

## Pre-task baseline — the checks DS-DOC-002 did not run

Recorded as *this* task's baseline, not retroactively as DS-DOC-002's acceptance:

```
Selection drag + citation suite (e2e-qa.mjs)   48/48 on IR v3
Outline, ResNet / Diffusion Policy / Mamba     26/26 each
retrieval benchmark, same harness, only the extraction differs:
                 Hit@1  Hit@3  Hit@5  Hit@10   MRR   NOT_RETRIEVED
  IR v2 (pre)     49%    64%    70%    81%   0.578        9
  IR v3 (post)    49%    64%    70%    79%   0.580       10
```

Two of 47 questions changed rank, and I diffed them: `How is a robot policy
represented?` 3 → 2, and `What datasets are used for evaluation?` 10 → out of the
top ten. Ranking code is byte-identical between the runs, so the difference is
the corpus. The reading-order repair did not damage retrieval; it moved two
questions, one each way at that resolution.

## The anchor

```
sha256( anchor_version | content_hash | page | quantized bbox | canonical text )
```

`ParagraphIR.id` is **untouched**. It is opaque to all 30-odd consumers — nothing
parses it, exactly one place builds it — so the change is additive and no
downstream code had to move.

**Canonical text** delegates to `normalize.join_wrapped_lines`, the repository's
own rule. That matters more than it sounds: the criteria specified
`re.sub(r'-\s*\n\s*', '', text)`, and `normalize.py` already documents and rejects
that rule, naming the case. Measured: `"a self-\ncontaining module"` becomes
`"a selfcontaining module"` under the criteria and `"a self-containing module"`
under the repository's. The one addition is removing U+00AD — a break hint with no
content, which occurs in **none of the 577 benchmark paragraphs**.

**Geometry** is quantized to 2.0 pt. That number is not load-bearing and I am not
claiming it is: measured collisions are **0 at 0.0, 0.25, 0.5, 1.0, 2.0 and
4.0 pt**, and cross-version stability is **150/150 at every one of them**. It is
insurance against a jitter nothing here has produced, and the plateau is reported
rather than the choice justified.

## The historical replay — the benchmark that matters

Diffusion Policy at gutter 8.0 → 6.0 is the only case in this repository where one
PDF was extracted by two materially different pipelines. It renumbered 145 of 160
paragraphs. Correspondence is established by normalized text and page, **never by
ordinal** — the ordinal is the thing being escaped.

```
old 160 -> new 155 paragraphs
  EXACT        150      the anchor is bit-identical
  REATTACHED    10      re-segmented; found on the same page by its own quote
  AMBIGUOUS      0
  ORPHANED       0
  WRONG          0   <- the only outcome the brief treats as failure
```

**Coverage 160/160, wrong attachments 0.** Every reattached paragraph was
verified to actually carry the source text, not merely to have been found.

## What the criteria got wrong, caught before implementation

Three defects, all in the anchor recipe, all found by implementing the recipe
*from the document* and running it on inputs the document does not consider
(`.agent/results/qa/probe_gemini_anchor.py`):

1. **Not scoped to the document.** Decision C lists `content_hash` among the
   inputs; the formula `anc_{page}_{sha256(text)[:12]}_{disambiguation}` does not
   carry it. Measured: the same sentence on page 1 of two papers produced the
   identical id. Brief Phase 5 forbids exactly this. **The corpus would never have
   caught it** — 0 of 885 paragraphs appear in two documents.
2. **`disambiguation_index` is an ordinal.** A count of prior same-text
   occurrences renumbers the ones below the moment a duplicate appears above.
   Measured: an existing caption moved `_00 → _01`. That is the fragility the task
   exists to remove, reintroduced for the case the brief singles out. Replaced by
   geometry, which an insertion cannot shift.
3. **The de-hyphenation rule contradicted the repository's own**, as above.

The first is the one worth naming: an acceptance document that states its inputs
correctly and then transcribes a formula that omits one of them is a defect no
amount of reading finds, and only executing it does.

## Determinism, collisions, duplicates

```
repeated extraction, same process    274/274 bboxes and texts bit-identical
across the version change            150/150 anchors stable at every quantum
anchor collisions, 577 paragraphs    0 at every quantum
duplicate normalized text, 885 paras 0 same-page, 0 cross-page, 0 cross-document
```

Duplicate text does not occur in this corpus at paragraph granularity. **The
disambiguation is therefore tested synthetically and that is stated rather than
implied** — the design separates two identical captions by their geometry, which
the tests assert directly.

## Downstream

```
Section hierarchy / Outline / current-section   PASS  browser 26/26 ResNet, 26/26 DP
Selection drag, citation jump, QA               PASS  48/48
Retrieval                                       PASS  metadata only; no ranking change
FTS / DocumentAnalysis                          PASS  both keyed on IR_PIPELINE_VERSION
Source immutability                             PASS  byte-identical after every run
```

**Not implemented:** AC-P1-04's additive `stable_source_id` on citations and
Selection payloads. It is P1 and no P0 depends on it; the anchor is reachable from
the IR, which is what a Notes implementation would read.

## Product decision

### A — STABLE SOURCE IDENTITY READY

Exact identity covers 94% of the measured historical change and reattachment
covers the rest, with zero wrong attachments and zero ambiguity. The design is
additive, deterministic, versioned and scoped to the document.

### Persistent annotation gate

### READY_FOR_NOTES

The requirement DS-DOC-002 left open — identity that survives an extraction change
— is now met and measured against a real one. Two caveats a Notes implementation
must carry rather than assume away: an anchor is exact for the paragraph it was
taken from, so a note spanning a *selection* needs the same treatment per
paragraph; and reattachment is page-scoped, so a re-laid-out paper that moves
content across a page break yields ORPHANED, which is the honest answer and the
one the UI must be able to show.

## Known limitations

1. **One historical change, one paper.** The replay is the strongest evidence
   available and it is a sample of one. Five other papers were unchanged by that
   change, so they prove nothing about the anchor under churn.
2. **The corpus cannot distinguish the geometry quantum.** Six values give
   identical results.
3. **Duplicate-text disambiguation is asserted, not observed** — zero instances in
   885 real paragraphs.
4. **Reattachment does not cross pages.** A paragraph moved by a page break
   during re-layout is reported ORPHANED rather than found.
5. **A flake I did not capture.** One browser run of `e2e-qa.mjs` reported 47/48;
   two subsequent runs reported 48/48 with zero FAIL lines. I did not record which
   check failed in that run, so I cannot say what it was. Reported because it
   happened, not explained away.
6. **AC-P1-04 not implemented** (see Downstream).
7. **`source_anchor_id` is a full sha256 in every paragraph**, which grew the IR.
   The size delta was not measured.

## Recommended next task

**DS-QA-010 — Notes + Persistent Highlights**, on the contract this task fixes:
an annotation persists the document fingerprint, the stable anchor, the selected
quote, its rects, and prefix/suffix context — never a bare `paragraph_id`.

The one design question the contract should settle first is whether a
*multi-paragraph* selection stores one anchor per paragraph or a span. The
measurements here say paragraphs are the unit that survives; a span does not,
because re-segmentation changes what a span covers.

Do not start multi-turn conversation.
