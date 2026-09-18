# DS-QA-008 — Acceptance Disposition

- **Date:** 2026-09-18
- **Resolves:** the one P0 left open at `40f2b51` / `8fff083`
- **Predecessor:** `docs/acceptance/DS-QA-008.md` (frozen criteria)
- **Status:** **CLOSED — P0 15/15**, with one `AC_CHANGE_REQUEST`

---

## 0. Which criterion was open, and a correction

The handover named two candidates for the open P0: AC-P0-08's missing suppression
timer, and AC-P0-10's un-re-measured rotated-page behaviour. **Neither was the
open criterion.** The disposition reported at `8fff083` was:

```
P0 14/15 PASS, 1 PARTIAL
```

and the PARTIAL was **AC-P0-09 — Reader mode navigation invariance**, whose
Translation and Bilingual clauses could not be reached in the browser fixture.
AC-P0-08 and AC-P0-10 were both reported PASS.

That distinction matters, because the two named candidates need different
treatment from the one that was actually open, and treating the wrong one as the
PARTIAL would have "resolved" a criterion that was never in doubt while leaving
the real gap untouched. Both named concerns are nonetheless real, and are
addressed below on their own merits.

---

## 1. AC-P0-08 — `AC_CHANGE_REQUEST`

| | |
|---|---|
| **As written** | *"Programmatic jumps initiated by clicking an outline item must suppress scroll-driven active node changes for $\ge 500$ ms to prevent feedback jitter."* |
| **Problem** | The criterion mandates a **mechanism**. The implementation contains no timer, and no timer is needed — and this is a property of the jump, not a coincidence. `PdfViewerHandle.scrollToPage` calls `container.scrollTo({ top, behavior: "auto" })`: the move is **instantaneous**. There are no intermediate scroll positions, so there is no window during which the reader is somewhere they did not ask to be, and nothing for a suppression period to suppress. A timer here would guard against an animation the code does not perform, and would introduce a new failure mode of its own — a real scroll by the reader, inside the window, ignored. |
| **Measured** | Browser, ResNet: after clicking `1. Introduction` the active node **is** `1. Introduction`; the 5-transition scroll sequence contains **no repeated** section; the active node is never left unset. No jitter was observed in any of the four browser runs (ResNet, Diffusion Policy, Mamba, rotated fixture). |
| **Resolution** | The criterion is restated as the observable it protects: *"After a programmatic jump the active node must reflect the jumped-to section, and a scroll-driven sequence must not revisit a section it has already left. Conveyed by `aria-current`, verified from the DOM."* That is what a reviewer can evaluate, and it cannot be satisfied by an implementation that merely sleeps. |
| **Not accepted** | Adding a 500 ms timer to satisfy the wording. The task brief is explicit: *"Do NOT implement a useless timer merely to satisfy stale wording."* |

---

## 2. AC-P0-10 — measured, PASS with evidence

AC-P0-10 was reported PASS on inherited behaviour. That is not good enough, and it
was re-measured on a purpose-built fixture.

**Fixture:** the benchmark paper with **page 1 set to `/Rotate 90`** and the rest
untouched — `fitz`, 12 pages, saved to `.agent/results/e2e-rotated/source.pdf`.
The first attempt rotated *every* page and produced **0 sections**: the layout
model reaches a rotated page sideways and classifies the whole page as one
`plain text` block, so no headings are detected and there is nothing to click.
That makes the criterion's path **unreachable by construction** on a fully
rotated document, and the reachable variant is one rotated page in an otherwise
upright document.

**Measured, real browser, rotated fixture:**

```
PASS  a rotated page still jumps to the section        scrollTop=3181
PASS  no bbox is drawn on a rotated page               0 highlight boxes
PASS  clicking a section lands inside the page it names   1132 in page 2 [883, 1694]
28/28 passed
```

So the requirement holds: the reader is moved, and the box is dropped rather than
misplaced — the DS-QA-005 rule, now measured for the outline path rather than
assumed from it.

**Recorded limitation, found while building the fixture:** the pane's rotation is
read from **page 1's viewport**, so a single rotated page disables heading
highlights for the *whole document*. That is the safe direction — no box is
better than a wrong box — but it is coarser than the criterion implies, and it is
recorded rather than left implicit.

---

## 3. AC-P0-09 — the criterion that was actually open

No translated artifact exists anywhere in the repository or the user's data, so
`selectEffectiveMode` can never return `"translation"` and the clause cannot be
reached in a browser run. **Producing one is a full translation of a real paper**
— a provider call with a wall-clock cost — which is disproportionate to
verifying three assertions.

**Resolution: verified against the real `jumpToSection` and the real mode
resolution, in component tests, with the translation state seeded directly.**

| Clause | Verified by | Result |
|---|---|---|
| Original | real browser (ResNet, Diffusion Policy, Mamba, rotated) | **PASS** |
| Translation | component test — mode becomes `original`, the notice names the page and section, the source heading box travels with the jump | **PASS** |
| Bilingual | component test — mode is unchanged, the original pane gets the box, the translated channel carries a page and **no box at all** (asserted on the channel's own key set) | **PASS** |

The tests exercise the production function, not a copy of it. What they cannot
prove is that a real translated artifact renders as expected — that is a
translation-pipeline concern, and the honest statement is that this clause is
verified at the state-and-navigation layer, not end-to-end through a translation.

---

## 4. Final disposition

```
AC-P0-01 … AC-P0-08   PASS   (AC-P0-08 restated, see §1)
AC-P0-09              PASS   Original browser; Translation + Bilingual by
                             component test against the production function
AC-P0-10              PASS   measured on a purpose-built rotated fixture
AC-P0-11 … AC-P0-15   PASS
```

**P0 15/15**, with the verification method stated per clause and one limitation
recorded in §2. P1 remains 5/8 and P2 1/3, unchanged: the unimplemented items
(outline search, analysis summaries, telemetry) were out of scope, not failures.

The count moved from 14/15 + 1 PARTIAL to 15/15 by **measuring the clause that was
open**, not by redefining it.
