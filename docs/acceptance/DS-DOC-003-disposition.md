# DS-DOC-003 — Acceptance Disposition

- **Date:** 2026-09-19
- **Resolves:** the two P0 criteria left unmeasured at `3957b6a` / `3617322`
- **Predecessor:** `docs/acceptance/DS-DOC-003.md` (frozen criteria)
- **Status:** **CLOSED — P0 15/16 PASS, 1 SCOPE-NARROWED**, with one
  `AC_CHANGE_REQUEST`

---

## 0. What was open, and a correction to my own report

The handover recorded AC-P0-13 and AC-P0-14 as **not measured**, and gave reasons
for both. **One of those reasons was wrong.**

I wrote that the rotated-page criterion could not be measured because "the
available rotated fixture extracts into one block / provides no meaningful
ParagraphIR anchor case". A rotated page does extract to a single block — measured
in DS-QA-008 — but a single block is still **a paragraph**, and a paragraph is
exactly what the anchor domain covers. There was a case to measure; I asserted
otherwise without running it.

That is the same failure this repository keeps finding: a claim about what the
data cannot support, made without asking the data. It is recorded here rather than
quietly corrected.

---

## 1. AC-P0-13 — measured, PASS

**As written:** *"On pages with non-zero rotation, `SourceAnchor` coordinates must
be stored in unrotated PDF point space. Highlight triggers in UI must continue to
safely suppress bounding box drawing when `rotation != 0`."*

Two clauses, both now measured.

**Clause 1 — coordinates on a rotated page.** Fixture: the benchmark paper with
page 1 at `/Rotate 90` (`.agent/results/e2e-rotated/source.pdf`).

```
page 1 rotation field                     90
paragraphs on the rotated page             1
anchors populated on that page             1 / 1
bbox                                       (10.9, 105.9, 545.1, 743.3)
page size reported                         792 x 612   (the rotated frame)
stable across a second extraction          True
distinct within the page                   True
```

The bbox is the evidence for the criterion's actual claim. The page reports
**792 × 612** — the rotated, landscape frame — while the box runs to **y = 743**,
which cannot fit inside a 612-point-tall frame. The coordinates are therefore in
the **unrotated portrait space** PyMuPDF reports text in, which is what the
criterion requires. A highlight drawn from them would be correct in that space and
is separately suppressed by the rotation rule.

**Clause 2 — highlight suppression.** Measured in the DS-QA-008 disposition, on
the same fixture, in a real browser: *"a rotated page still jumps to the section
(AC-P0-10) scrollTop=3181"* and *"no bbox is drawn on a rotated page — 0 highlight
boxes"*, 28/28. Not re-run here because nothing has changed in that path, and the
number is quoted from that run rather than presented as new.

**Verdict: PASS**, both clauses, on a fixture that produces a real anchor.

---

## 2. AC-P0-14 — `AC_CHANGE_REQUEST`: the domain is paragraphs, and says so

| | |
|---|---|
| **As written** | *"Captions (`figure_caption`, `table_caption`), formulas (`isolate_formula`), and references (`is_references = True`) must each receive valid, distinct `SourceAnchor`s. They must not be collapsed or discarded."* |
| **Problem** | The criterion is not unmeasured — **it is unmet, and measurably so**. `source_anchor_id` is defined on `ParagraphIR`. Measured on a v4 extraction of ResNet: the **2 reference paragraphs are anchored 2/2**, because a reference is prose and therefore a paragraph; but of the **14 caption blocks and 4 formula blocks, 0 are inside any paragraph**, so 0 are anchored. The criterion asks for three classes to be anchored and the implementation anchors one of them, for the structural reason that two of the three are `TextBlockIR` and the anchor domain is `ParagraphIR`. |
| **Why it was written that way** | The criterion was authored before the implementation, and its author reasonably assumed the anchor would sit at block level, where all three classes live. It sits at paragraph level instead — which is the level DS-DOC-002 measured as the stable unit, and the level a user selects text at. Both are defensible; only one is implemented. |
| **Resolution** | The v1 anchor domain is **paragraphs**, and the criterion is narrowed to match: *"Every `ParagraphIR` receives a valid, distinct `SourceAnchor`, including paragraphs inside a references section. Captions and formulas are `TextBlockIR` and are **out of scope for v1**; annotating them requires a block-level anchor and is a separate task."* The narrowing is recorded as a scope decision, not reported as a pass. |
| **Not accepted** | Anchoring blocks now to satisfy the wording. It would double the anchor corpus with units no user can select, and the reattachment layer is measured only against paragraph churn. |
| **Not accepted** | Reporting 15/16 as "P0 all PASS". One criterion had its scope narrowed by an explicit request, and that is a different thing. |

---

## 3. Final disposition

```
AC-P0-01 … AC-P0-12   PASS
AC-P0-13              PASS   both clauses measured (§1)
AC-P0-14              SCOPE-NARROWED to paragraphs by AC_CHANGE_REQUEST (§2)
AC-P0-15 … AC-P0-16   PASS
```

**P0 15/16 PASS, 1 scope-narrowed.** Stated as such rather than as 16/16: the
sixteenth asks for something the implementation does not do, and the honest
response is to change the requirement or change the code, not to count it as met.

P1 remains 4/8 and P2 0/3, unchanged and not prerequisites.

## 4. The browser flake

One run of `e2e-qa.mjs` reported **47/48**; two subsequent runs reported **48/48**
with zero `FAIL` lines. I did not capture which check failed in the failing run, so
I could not say what it was, and recorded it as unreproduced rather than fixed.

Re-ran three more times to characterise it:

```
run 1   48/48 passed
run 2   48/48 passed
run 3   48/48 passed
```

**Five consecutive clean runs since the one failure.** The flake is therefore
**unreproduced, not fixed**: I still do not know which check failed, because I did
not capture it, and three runs that pass do not explain a run that did not. It is
recorded so that a future failure of the same shape has a prior to compare
against, and so nobody reads "48/48" and concludes the question was answered.
