# DS-DOC-011 — Acceptance Disposition

- **Date:** 2026-10-12
- **Predecessor:** `docs/acceptance/DS-DOC-011.md` (PROPOSED — 10 P0 · 4 P1 · 2 P2; never frozen)
- **Status:** **CLOSED — ACCEPTED AS IMPLEMENTED.** The tranche's purpose is delivered by a different
  mechanism than the one the contract specifies. Four of its criteria are met as written, six are
  met in intent by other means, and the rest are recorded below as not done, each with its reason.
- **Maintainer decision (2026-10-12):** the implemented route — the parser's HTML, sanitized and
  drawn as a table — is the contract. The KaTeX `array` route of the original document is
  withdrawn and will not be built. What §3 lists as open stays open as roadmap items, not as debts
  against this tranche.

---

## 0. What changed underneath the contract

The contract was written on 2026-09-27 against a premise stated in its §0.2: *KaTeX is the only
renderer available, and KaTeX has no `\multicolumn`, `\multirow` or `\cline`* — therefore a table
can only be typeset as an `array`, and a merged cell must be flattened and the loss recorded (D2,
AC-P0-03).

Its §0.3 also named its own precondition: *the IR must carry a table's grid*, "a proposal, to be
reconciled with ADR-003; if that decision lands a different one, this document is amended in the
open."

ADR-003 landed, and it landed a different one. A MinerU parse delivers each table as **HTML**
(`TextBlockIR.html`), and the reflowed reading draws that HTML as a table
(`frontend/src/bilingual/reflow/Recovered.tsx`), rebuilt from a tag whitelist. HTML has
`colspan` and `rowspan`. So the route the contract ruled out as impossible is the one that exists,
and it is strictly better on the contract's own terms: **a merged cell is reproduced, not
flattened**, and the table is selectable, copyable, searchable and readable by assistive
technology — the affordances §2.5 says are the entire reason to typeset.

Converting that HTML to a KaTeX `array` now would throw the merges away to satisfy D2. That is a
regression, and it was not done.

---

## 1. Criterion by criterion

| AC | Verdict | How, or why not |
|---|---|---|
| **P0-01** Deterministic, model-free | **MET (by other means)** | No conversion step exists to be non-deterministic: the parser's HTML is sanitized by a pure function (`sanitizeTableHtml`) and drawn. 0 provider calls. |
| **P0-02** KaTeX subset only | **NOT APPLICABLE** | Nothing is emitted as LaTeX. |
| **P0-03** Span flattening recorded | **NOT APPLICABLE — improved on** | Spans are kept (`colspan`/`rowspan` survive the whitelist; test: *keeps structure and spans*). Nothing is flattened, so nothing needs recording. |
| **P0-04** No unrecognized glyph | **MET IN INTENT** | The failure this guards against — a mark drawn as a box — was observed in a different form: private-use code points (a PDF font's own bracket glyphs) arrived in cells and drew as `▯`. They are removed (test: *drops glyphs that only a PDF font can draw*). `✗`/`✓` are ordinary Unicode in HTML and need no map. |
| **P0-05** Parse before render | **MET (by other means)** | The HTML is parsed by `DOMParser` and **rebuilt** from a whitelist before it reaches the DOM; scripts, handlers, links, images and styles do not survive (test: *drops anything that could run or load*). |
| **P0-06** Fit rule: ≥ 0.70, else crop | **MET, with one change** | Measured in the browser, per table. Order: fits → let prose cells wrap → scale down to **0.70 and never below 11 px text** → otherwise natural size in its own scroller. The change: the fallback below the floor is *the table at natural size, scrolling*, not *the crop* — the crop is one click away either way. |
| **P0-07** Never shrunk below natural size | **MET** | A table under the floor keeps its natural size inside a focusable horizontal scroller; the reading column's `scrollWidth === clientWidth` in every case measured (§2). |
| **P0-08** Figure crop scale column-derived | **NOT DONE** | Untouched. With a MinerU parse a figure is the parser's own image at `max-w-full`, which is column-derived already; the in-house extractor's `CropItem` still uses the ink rule. Left for the tranche that touches crops. |
| **P0-09** Formula magnification unchanged | **MET** | Not touched; the existing tests pass unmodified. |
| **P0-10** Independent artifact, 0 calls, provenance + flip | **MET IN PART** | 0 calls on open and scroll: yes. Provenance badge and one-click flip to the paper's own crop: yes (`recovered-toggle`, "MinerU 识别 · 点击看原图"). Independent `_cache/tables/` artifact: **not created** — there is no conversion output to store; the HTML lives in the IR. |
| **P1-01** Contrast | **MET** | Table text inherits `--foreground`; both themes are checked at AA from the shipped tokens (`theme.test.tsx`). |
| **P1-02** Copy | **MET, as a table** | "复制表格" copies tab-separated rows (pastes into a spreadsheet), not LaTeX — there is no LaTeX. |
| **P1-03** `Alt+T` between tables | **NOT DONE** | |
| **P1-04** Degradation notice | **NOT APPLICABLE** | Nothing is degraded. A table shown at natural size says so ("表格较宽，按原尺寸显示，可横向滚动"). |
| **P2-01** Numeric columns right-aligned | **MET** | Decided per column, never per cell; a table with merged cells is left as it was (test: *right-aligns a column only when every value in it is a number*). |
| **P2-02** Row tint on hover | **MET** | CSS only. |

---

## 2. Measured

One paper, not the contract's two fixtures: **ResNet (arXiv 1512.03385), MinerU 4.0.7, `basic`
tier**, reading column at 1440 × 900, slot 564 px, base table text 13 px.

| Outcome | Tables | Notes |
|---|---|---|
| fits as extracted | 10 / 15 | |
| fits once prose cells wrap | 1 / 15 | a 5-column comparison whose cells are sentences |
| scaled | 2 / 15 | 0.978 and 0.992 → 12.7 px and 12.9 px text |
| natural size, scrolling | 2 / 15 | a 7-column table of stacked blocks (912 px) and a 25-column one (1147 px) |

The reading column never scrolled sideways (`scrollWidth === clientWidth`).

**What this does not establish.** The contract's split — 14 typeset / 6 crop of 20 — was measured
on two other papers and on KaTeX output at a different base size; it was **not re-measured**, and
the numbers above must not be read as confirming it. The Mamba fixture's 19-column table was not
run.

---

## 3. What is still open

1. **Papers read by the in-house extractor get no table at all.** Their `table` blocks carry
   flattened text, exactly as §0.3 describes, and are still shown as crops. The contract's
   precondition — a grid in the IR — is met only by a MinerU parse. Whether to build a grid
   extractor of our own is the question ADR-003's alternatives table already records.
2. **A parser can misread a cell, and this cannot fix it.** Measured on ResNet Table 1: the `basic`
   tier returned the bracketed 3 × 3 blocks as `33××33,, 6644×`. The text is wrong in the HTML
   itself. The crop is one click away; nothing warns the reader that this particular table needs it.
3. **Inline math in cells.** No `basic`-tier table on the sample contained any, so the path is
   unexercised; a tier that emits `<eq>` runs would currently show their LaTeX source as text.
4. AC-P0-08 (figure crops) and AC-P1-03 (keyboard step), as above.

The contract as written — KaTeX `array`, spans flattened, an artifact under `_cache/tables/` — was
considered against this and withdrawn (maintainer decision, 2026-10-12): it would give up the
merged cells the implemented route keeps, and items 1–3 above would have stood either way.
