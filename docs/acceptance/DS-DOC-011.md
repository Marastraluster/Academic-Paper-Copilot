# Acceptance Criteria — DS-DOC-011: Tables Typeset, and the Geometry of Non-Prose Elements (表格排版与非正文元素的尺寸规则)

- **Author:** independent acceptance criteria author
- **Reviewed and frozen by:** project maintainer (pending)
- **Date:** 2026-09-27
- **Baseline:** commit `73d7597` / post-DS-DOC-010 (`IR_PIPELINE_VERSION = "5"`, `FORMULA_SCHEMA_VERSION = "1"`, `BILINGUAL_SCHEMA_VERSION = "1"`, initial chunk **304.54 kB** — measured after DS-QA-015's code splitting, 349.14 → 304.54 kB; AC-P0-52's frozen 300.0 kB target is **unmet**, with a proposal to amend the ceiling to 310.0 kB recorded in `DS-QA-015.md` §0.1)
- **Measurement source:** `.agent/evidence/DS-MINERU-001.md` §7 (and §3–§4 for the fixtures it cites)
- **Status:** **WITHDRAWN — superseded by [`DS-DOC-011-disposition.md`](DS-DOC-011-disposition.md)**
  (2026-10-12). Tables are drawn from the parser's HTML, which keeps merged cells; the KaTeX
  `array` route specified below was never built and will not be. This document is kept as the
  record of what was proposed and measured (originally: PROPOSED — 10 P0 · 4 P1 · 2 P2).

---

## 0. Independent Acceptance Author Statement & Review Framing

### 0.1 Process Discipline & Task Boundary

DS-DOC-010 typeset **display formulas** from reconstructed LaTeX, with a provenance badge and a
one-click fallback to the paper's own pixels. The reader's verdict on that tranche was that the
same treatment is wanted for **tables**, and the direction recorded for everything whose pixels are
the content was:

> *tables get the same treatment as formulas — typeset, with the paper's crop one click away;
> figures keep **our** crops, drawn from the PDF's vector source, never an extractor's rasters;
> and the proportions are ours to get right.*

This document is the contract for that. It covers **only**: table typesetting, the provenance and
fallback contract for it, and the size rule for the three non-prose classes (`table`, `figure`,
`isolate_formula`) in the reflow reading column.

- **Strict Invariance:** the paragraph translation pipeline (`app/bilingual/pipeline.py`, its prompt
  and its cache), the formula reconstruction pipeline (`app/formulas/`, its prompt, its artifact and
  its cache), `BILINGUAL_SCHEMA_VERSION`, `FORMULA_SCHEMA_VERSION`, `SCHEMA_VERSION`,
  `IR_PIPELINE_VERSION`, reading-order assembly, caption attachment (`caption_of`), and the
  extractor itself all remain **100 % frozen and untouched**.
- **Production Code Prohibition:** the author of this document writes zero production code.
  Production implementation belongs solely to the main agent once this contract is frozen.
- **Extraction is not this document's subject.** Whether table *structure* comes from a new
  extraction backend is the subject of a separate decision (ADR-003, not yet written) and is
  deliberately **not** decided here. §0.3 states the precondition this contract needs and nothing
  more.

### 0.2 The Hard Fact: A Table's Structure Is Extracted, Not Guessed

DS-DOC-010's formula pipeline exists because a formula's extracted text is *soup*: a compiled PDF
stores glyphs, not mathematics, so the LaTeX has to be reconstructed by a model.

**A table is the opposite case.** Its structure — which cell is in which row, which cell spans two
columns, what the header says — is present in the layout, and can be extracted exactly. Measured on
the two fixtures: an extraction that emits `table_body` HTML converts to KaTeX-parseable LaTeX
**24 tables out of 24** (§2.4), deterministically, with **zero** provider calls. So this tranche has
no reconstruction step and no model in it, and its failure mode is not "the model guessed wrong" but
"the structure was not extracted" — which is visible as a missing structure, not as a plausible
wrong answer.

Two consequences follow, and they are the reason the contract is written the way it is:

1. **Typesetting is free but not universally possible.** KaTeX 0.18.9 — already bundled
   (DS-DOC-010 D4) — supports **less LaTeX than LaTeX does**. Measured: `array` ✓, `\hline` ✓,
   `\text` ✓, `\mathbf` ✓, but `tabular` ✗ (*No such environment*), `\multicolumn` ✗,
   `\multirow` ✗, `\cline` ✗ (*Undefined control sequence*). A merged cell **cannot be typeset as a
   merge**; only its content can be carried.
2. **The constraint on a table is width, not legibility.** The magnification rule that DS-DOC-009
   AC_CHANGE_REQUEST 1 established — `prose_px / ink_pt`, clamped to `[1.0, 2.5]` — was derived from
   narrow formulas (100–215 pt wide) where the question is "is the ink big enough". Applied to a
   464 pt table or a 494 pt figure it produces a number the slot then throws away (§2.5).

### 0.3 Precondition: the IR must carry structure

This contract needs one thing from extraction that the current IR does not have: a `table` block
that carries its **grid** rather than flattened text. Today the reader's paper's first table arrives
as

```text
'Method\nImageNet\nPlaces365\nAircraft\nPets\nInfoNCE\n47.32\n34.46\n8.10\n68.98\nSigLIP\n…'
```

which is exactly the fragmentation DS-QA-013 recorded, and nothing can be typeset from it.

**The shape this document assumes** (a proposal, to be reconciled with ADR-003; if that decision
lands a different one, this document is amended in the open):

```
TableStructure
├── rows: [ [cell, …], … ]
└── cell: { text: str, row_span: int, col_span: int, is_header: bool,
            runs: [ {kind: "text"|"math", text: str}, … ] | None }
```

Everything below is written against *the presence of a grid*, not against any particular extractor.

### 0.4 Measured Fixtures & Repository Inventory

| | Reader's paper (`2607.00784v1`) | Mamba (36 pp) |
|---|---|---|
| Pages | 14 | 36 |
| Tables | **8** | **16** |
| Table width (pt) | 178.3 – 464.4 | 135.9 – 484.7 |
| Table aspect ratio (w/h) | 1.37 – 6.84 | 1.14 – 7.74 |
| Table ink (dominant font size) | 8.5 – 9.3 pt | 8.5 – 9.3 pt |
| Largest table | 6 cols × 5 rows (464 pt wide) | **19 cols × 8 rows**, and 11 cols × 25 rows |
| Figures | **5** (241–494 pt wide, ink 3.4–3.8 pt) | — |
| Display formulas | **7** (101.8–215.8 pt wide, ink 6.5–9.3 pt) | 13 |

Column geometry, from the shipped code: reading column `max-w-[680px]`
(`ReflowBilingualReader.tsx:68`); crop slot `columnWidth − 128` = **552 px**; prose `PROSE_PX = 16`
(`crops.tsx:50`); magnification `clamp(16 / ink_pt, 1.0, 2.5)` (`crops.tsx:77`).

---

## 1. Executive Judgment: Is this task worth doing?

**Yes — and cheaper than DS-DOC-010, because the expensive part is already done.**

KaTeX is bundled, code-split and validated; the provenance-and-fallback pattern is frozen and
tested; the reading column's containment rules are in place. What is missing is a converter (no
model), a size rule that distinguishes a narrow formula from a wide table, and the decision of what
to do when typesetting cannot be honest.

The measurements put that last point in plain numbers: of the **20 tables that pair** across the two
fixtures, **14 typeset** at the 0.70 floor and 6 fall back to the crop — headed by a 19-column table
whose typeset text would be **5.7 px**. Typesetting everything would be worse than typesetting
nothing. And the measurements also say something the first draft of this document got wrong and §6
corrects: **typesetting is never the more legible option** — the crop is prose-sized wherever the
column does not bind. What typesetting buys is a table you can select, copy, search, translate and
read with assistive technology; what the crop buys is the paper itself.

---

## 2. Specifications & Design Decisions

### 2.1 Design Decisions D1–D8

| # | Topic | Verdict | Rationale |
|---|---|---|---|
| **D1** | **Where the LaTeX comes from** | **Deterministic conversion of the extracted grid. No model, 0 provider calls.** | The structure is already in the document; a model could only add error. This is the opposite of DS-DOC-010 D1, and deliberately so: that pipeline reconstructs because a formula has no structure to read, this one converts because a table does. |
| **D2** | **The KaTeX subset is the output contract** | **Emit `array` + `\hline` only.** No `tabular`, no `\multicolumn`, no `\multirow`, no `\cline` (all measured unsupported). | A merged cell is carried by putting its content in the top-left slot of the span and leaving the covered slots empty. The merge is **not reproduced**; the content is, and the artifact records that a span was flattened. |
| **D3** | **Symbol map for marks** | **Required, with a test that proves no unknown glyph is emitted.** | Measured: `✗` (U+2717) occurs 9 times in the Mamba tables, and KaTeX 0.18.9 has **no glyph metrics** for it — it warns `Unrecognized Unicode character "✗" [unknownSymbol]`. A checkmark table is common in this literature; rendering a fallback glyph would replace the paper's mark with something that is not it. |
| **D4** | **Type only when it fits** | **Typeset iff the rendered table fits the slot at scale ≥ 0.70; otherwise keep the crop, at 1:1, inside the existing wide-table scroller.** | Measured on the 20 tables that could be paired across both fixtures: 14 typeset at ≥ 0.70, 6 fall below (0.35–0.59). The floor is not where typesetting becomes *clearer* — the crop is at least as legible in every paired case (§2.5) — it is the legibility loss accepted for selectable, translatable text: exactly `1 − fit`, up to 21 % at the floor, with the paper's pixels one click away. The split is flat from 0.60 to 0.75, so the threshold is robust inside that band. |
| **D5** | **Figures: the ink rule retires** | **A figure's crop is scaled to the column, not magnified by ink.** | Measured: the figures' inks are 3.4–8.0 pt — the *smallest label in the figure*, not its content — and their natural widths (241–494 pt) put every one of them at the column clamp, so the drawn width is the column in 5 of 5 cases at scale 1.25 and the magnification never reaches the page. It also sizes the **raster** at `scale × 2.5` and then displays it smaller, which is the memory DS-DOC-009 already measured at 29.6 MB per page. Note the honest limit of this decision: at column width a 241 pt figure's 3.4 pt labels land at **9.6 px**, and no magnification fixes that inside a 680 px column — the click-to-zoom is the mechanism that does. |
| **D6** | **Formulas: the ink rule stays** | **`isolate_formula` keeps DS-DOC-009 AC_CHANGE_REQUEST 1 unchanged.** | Measured: the rule puts formulas at 233–580 px against a 552 px slot, i.e. it lands on the right size for the class it was derived from. This document must not regress it while fixing its neighbours. |
| **D7** | **Provenance and one-click ground truth** | **A typeset table carries a provenance badge and flips to the paper's own crop on click**, mirroring DS-DOC-010 AC-P0-11. | Converted LaTeX can be wrong in a way that looks right — a flattened span, a lost header, a mangled symbol — and the honest response is the same one the formulas already give: say where it came from, and make the paper's pixels one click away. |
| **D8** | **Artifact and cache isolation** | **`_cache/tables/<content_hash>.json`, its own `artifact_kind`, `schema_version` and `pipeline_version`.** | The same reason DS-DOC-010 D-independent-artifact gives: a table conversion must never invalidate, or be invalidated by, paragraph translations or formula reconstructions. |

---

### 2.2 The Conversion Contract

```
grid (rows × cells, each with text, spans, header flag)
   │  1. escape: \ { } $ & # % _ ^ ~   (and the symbol map, D3)
   │  2. <eq> runs → inline math, verbatim
   │  3. spans → value in the top-left slot; covered slots empty (D2)
   │  4. header row closed with \hline
   ▼
\begin{array}{lccc…}  \hline  …rows…  \hline  \end{array}
```

Deterministic: the same grid produces byte-identical LaTeX, and the conversion is a pure function
with no I/O, so it is unit-testable without a document, a cache or a provider.

**What the conversion may not do:** invent a cell, reorder a column, translate a value, or emit a
macro outside the measured subset. A structure it cannot express is recorded as a degradation in
the artifact (D2), not silently dropped.

### 2.3 Rendering Contract

| Property | Value |
|---|---|
| Container | Full column width (680 px), the table centred in it |
| Base font | Same optical size as DS-DOC-010 AC-P0-09's math (`1.125rem`), scaled by the fit factor from D4 |
| Fit factor | `min(1, W_avail / W_natural)` measured in the browser, not estimated |
| Floor | A typeset table's effective font size is **≥ 11 px**; below that it is a crop, not a table |
| Numbers | Right-aligned in their cells; no `\tag`, no equation-number affordance |
| Captions | Unchanged: the existing caption attachment renders table captions above, figures below |
| Provenance | Badge naming the conversion (`[表格重建]` / `[表格 LaTeX]` — wording settled at implementation), tooltip stating that merged cells are not reproduced |
| Fallback | Click flips to the DS-DOC-009 crop; click returns. Keyboard: `Enter`/`Space` when focused |
| Containment | DS-DOC-010 AC-P0-10 and DS-DOC-009 AC-P0-10 unchanged: the column never scrolls sideways |

### 2.4 Conversion Feasibility — Measured

| Fixture | Tables | Convert to LaTeX | Parse under KaTeX 0.18.9 |
|---|---|---|---|
| Reader's paper | 8 | 8 | **8 / 8** |
| Mamba | 16 | 16 | **16 / 16** |

Row spans occur in 3 of 24 tables; converted LaTeX is 301 characters median, 2237 maximum.
The failures that existed before span flattening (2 of 8) were both `\multicolumn` — which is why
D2 exists.

### 2.5 The Size Rule — Measured

> **Corrected in §6 (Round 1 review).** The first draft of this section used a 96/72 conversion and
> the formula slot for every class. The shipped rule has neither. The paragraph below is the
> corrected arithmetic, read out of `ReflowBilingualReader.tsx:659-666`.

The shipped crop rule is:

```js
const naturalPx = boxWidth * scale;                        // no 96/72 step
const slot      = isFormula && caption ? columnWidth - 64 : columnWidth;   // 616 vs 680
const overflows = naturalPx > columnWidth;
const displayW  = overflows ? naturalPx : Math.min(naturalPx * magnification, slot);
```

Two properties follow, and both matter:

1. **A crop is never drawn below its own 72-dpi natural size.** `displayW ≥ naturalPx` holds for
   every branch whenever `magnification ≥ 1`. The first draft's "net shrink below 1:1" is **false**.
2. **What the clamp costs is text size, and it is computable.** For a table or a figure the slot is
   the whole column (680), so

   ```
   crop text px    = min(16 × scale, ink_pt × 680 / box_pt)
   typeset text px = 16 × min(1, 552 / typeset_width_px)      (measured in a browser)
   ```

**Both paths, same fixtures, at scale 1.0** (crop text is exactly prose-sized until the column
clamps it; typeset text is exactly prose-sized only when the table fits the slot):

| | crop text | typeset text | more legible |
|---|---|---|---|
| Formulas (7) | **16.0 px** (never clamped) | — | — |
| Tables that fit the slot (10 of 20 paired) | 16.0 px | 16.0 px | tie |
| Wide tables (10 of 20 paired) | 11.8 – 16.0 px | 5.7 – 15.6 px | **the crop, in every case** |
| Figures (5) | 9.6 – 11.0 px | — (not typeset) | — |

**The legibility argument for typesetting does not exist.** In all 20 tables that could be paired
across the two fixtures, the crop is at least as legible as the typeset version and usually more.
What typesetting buys is not size — it is **affordance**: a typeset table is selectable, copyable,
searchable, translatable and readable by assistive technology; a crop is a picture and is none of
those at any zoom. What the crop buys is **fidelity**: it is the paper.

That reframes the floor. It is not "the point where typesetting becomes clearer" — it is **the
legibility loss we accept in exchange for affordances**, and the price is exactly `1 − fit`:

| floor | tables typeset | of those, smaller than their own crop | worst typeset text |
|---|---|---|---|
| 1.00 | 14 / 20 | 0 | 16.0 px |
| 0.85 | 13 / 20 | 0 | 13.6 px |
| **0.70** | **14 / 20** | **4** | **12.7 px** |
| 0.60 | 14 / 20 | 4 | 12.7 px |

The split is flat from 0.60 to 0.75 — the measured scales have a gap between 0.59 and 0.79 — so the
threshold is robust inside that band, and 0.70 sits in the middle of it. At that floor four tables
are typeset at up to **21 %** smaller text than their crop would give (12.7 px against 16.0 px), and
the reader still has the paper's pixels one click away, which is what makes the trade acceptable.

---

## 3. Acceptance Criteria

### 3.1 P0 MUST — Conversion, Parse Safety, Fit Rule, Provenance, Cache Isolation

- **AC-P0-01 Deterministic, Model-Free Conversion.**
  Given a `table` block carrying a grid, the converter must produce LaTeX **without any provider
  call** and without I/O, and must be a pure function of the grid: converting the same grid twice
  yields byte-identical output.
  *Evidence:* Backend unit test converting every table of both fixtures twice and asserting byte
  equality; and a `CountingProvider` assertion of `total_calls === 0` across the whole conversion
  of both fixtures.

- **AC-P0-02 KaTeX Subset Discipline.**
  The emitted LaTeX must use `array` and `\hline` only. `tabular`, `\multicolumn`, `\multirow` and
  `\cline` must never be emitted (each is measured unsupported by KaTeX 0.18.9).
  *Evidence:* Backend test asserting the emitted string matches none of those four macros, over
  all 24 fixture tables; plus a frontend test that parses every emitted string with
  `katex.renderToString(…, { throwOnError: true })` and records **24 / 24** passing.

- **AC-P0-03 Span Flattening Is Recorded, Never Silently Lossy.**
  A cell with `col_span > 1` or `row_span > 1` must be emitted with its content in the top-left slot
  of the span and the covered slots empty, and the artifact must record that the table contains
  flattened spans.
  *Evidence:* Backend test on the 3 fixture tables that contain row spans; asserting (a) the content
  appears exactly once, (b) the covered slots are empty, and (c) the artifact's degradation record
  names the flattened span.

- **AC-P0-04 Symbol Map — No Unrecognized Glyph Reaches the Renderer.**
  Characters without KaTeX metrics must be mapped to macros that have them (`✗` → `\times`,
  `✓` → `\checkmark`, and the rest of the map the implementation finds necessary). Rendering the
  fixture tables must produce **zero** `unknownSymbol` warnings.
  *Evidence:* Frontend test capturing `console.warn` while rendering every converted table of the
  Mamba fixture — which contains `✗` nine times — and asserting zero warnings.

- **AC-P0-05 Strict Pre-Render Parse Validation.**
  A converted table must never reach the DOM before parsing. If
  `katex.renderToString(latex, { throwOnError: true, displayMode: true })` throws, the table must
  fall back to the DS-DOC-009 crop and the invalid markup must not be displayed as text.
  *Evidence:* Vitest feeding a deliberately malformed converted string; asserting the crop renders
  and no LaTeX source text is present in the DOM. (Same contract as DS-DOC-010 AC-P0-06.)

- **AC-P0-06 The Fit Rule — Typeset Above 0.70, Crop Below.**
  A table must be typeset only if its measured natural width fits the available slot at scale
  ≥ **0.70**; otherwise it must render as a crop. The floor is a legibility budget, not a
  legibility crossover: measured, the crop is at least as legible as the typeset table in **every**
  paired case, and at a 0.70 floor the four tables that are not flat ties are typeset at up to 21 %
  smaller text than their crop.
  *Evidence:* Browser harness measuring every table's typeset width and the rendered state on both
  fixtures; asserting the split (measured on the paired sample: **14 typeset / 6 crop of 20**) and
  that every typeset table's effective font size is ≥ 11 px. The harness must also report the fit
  per table, so the 4 tables it cannot pair (see §6, AC_CHANGE_REQUEST 4) are visibly unmeasured
  rather than quietly excluded.

- **AC-P0-07 No Table Is Shrunk Below Its Own Natural Size.**
  A table that fails the fit rule must not be scaled down. It renders inside its own horizontal
  scroller at **≥ its natural size** — the invariant the shipped `CropItem` already guarantees
  (`displayWidthPx ≥ naturalPx`, §2.5) — and the reading column itself never scrolls sideways.
  **This AC is a non-regression plus an extension:** the invariant exists for crops today, and this
  tranche must not lose it when a typeset table is added beside it.
  *Evidence:* Browser test on the 19-column Mamba table and on a table whose natural width sits
  between the slot and the column: asserting the drawn width ≥ natural, the wrapper's
  `scrollWidth > clientWidth`, and the reading column's `scrollWidth === clientWidth`.

- **AC-P0-08 Figure Crop Scale Is Column-Derived, Not Ink-Derived.**
  A `figure` crop must be drawn at `min(natural × S_view, column width)`: no ink-derived
  magnification, and no raster allocated at a scale the clamp will discard.
  *Evidence:* Component test with the fixture figures (ink 3.4–8.0 pt, natural 241–494 pt at scale
  1): asserting (a) the drawn width equals the column when the column binds, and (b) the canvas
  backing-store width is within ±2 px of the **drawn** width × `devicePixelRatio` — i.e. no raster
  is allocated for pixels that are never displayed.

- **AC-P0-09 Formula Magnification Unchanged (Non-Regression).**
  `isolate_formula` crops must continue to use the ink-derived magnification of DS-DOC-009
  AC_CHANGE_REQUEST 1 (`prose_px / ink_pt`, clamped `[1.0, 2.5]`), capped as DS-DOC-010 AC-P0-10
  requires.
  *Evidence:* The existing formula magnification tests must pass unmodified — this criterion is
  satisfied by not touching them, and its evidence is that they still pass.

- **AC-P0-10 Independent Artifact, Zero Calls on Open, Provenance and Flip.**
  1. Converted tables are stored at `_cache/tables/<content_hash>.json` with their own
     `artifact_kind`, `schema_version` and `pipeline_version`; generating, upgrading or deleting
     them must not modify `_cache/bilingual/` or `_cache/formulas/`.
  2. Opening a paper and scrolling through its tables costs **0 provider calls**.
  3. Every typeset table carries a provenance badge, and clicking it (or `Enter`/`Space` when
     focused) flips it to the paper's own crop, and clicking again flips back.
  *Evidence:* Backend test asserting byte-identical `_cache/bilingual/` and `_cache/formulas/`
  before and after a table conversion; `CountingProvider` assertion of 0 calls on open and scroll;
  Vitest user-event test asserting the badge is present and the flip swaps the DOM node.

---

### 3.2 P1 SHOULD — Contrast, Keyboard, Clipboard, Hover

- **AC-P1-01 Table Text Contrast.** Typeset table text must inherit `--foreground` and meet the
  DS-DOC-009 AC-P0-11 contrast bar in the shipped theme, including inside `array` cells.
  *Evidence:* Contrast computation over the rendered table's computed colour and background.

- **AC-P1-02 Clean LaTeX Copy.** Hovering a typeset table must offer "复制 LaTeX", copying the raw
  converted string with no badge text, caption or HTML chrome.
  *Evidence:* Vitest clipboard assertion matching the artifact's stored LaTeX verbatim.

- **AC-P1-03 Keyboard Step Between Non-Prose Elements.** `Alt + T` moves focus to the next table in
  the column; a focused table flips with `v`, consistent with DS-DOC-010 AC-P2-01.
  *Evidence:* Component keyboard test asserting focus movement and flip.

- **AC-P1-04 Degradation Notice.** A typeset table whose spans were flattened must say so — a
  discreet note in the provenance tooltip, not a badge of its own.
  *Evidence:* Vitest asserting the tooltip text contains the degradation notice for a table whose
  artifact records flattened spans.

---

### 3.3 P2 OPTIONAL — Presentation Niceties

- **AC-P2-01 Column Alignment by Content.** A column whose cells are all numeric must be
  right-aligned rather than centred, and a column of prose left-aligned, computed from the grid.
  *Evidence:* Unit test over the fixture grids asserting the emitted column spec.

- **AC-P2-02 Numerical Row Highlight on Hover.** Hovering a row tints it for cross-row reading of
  wide numeric tables.
  *Evidence:* Vitest asserting a row-level hover class is applied.

---

## 4. Evidence & Verification Plan

| Criterion | Target Property | Mechanism | Concrete assertion |
|---|---|---|---|
| **AC-P0-01** | Determinism, 0 calls | Backend pytest + ledger | Same grid twice → byte-identical; `total_calls === 0` over both fixtures |
| **AC-P0-02** | KaTeX subset | Backend pytest + frontend vitest | No `tabular`/`\multicolumn`/`\multirow`/`\cline`; **24 / 24** parse |
| **AC-P0-03** | Span honesty | Backend pytest | 3 tables with row spans: content once, covered slots empty, degradation recorded |
| **AC-P0-04** | Symbol map | Frontend vitest | Zero `unknownSymbol` warnings on the Mamba fixture (`✗` × 9) |
| **AC-P0-05** | Parse before render | Frontend vitest | Malformed string → crop, no LaTeX text in the DOM |
| **AC-P0-06** | Fit rule | Browser harness | **6 / 8** and **13 / 16** typeset; every typeset table ≥ 11 px |
| **AC-P0-07** | No shrink | Browser harness | 19-column table at 1:1 in its scroller; column `scrollWidth === clientWidth` |
| **AC-P0-08** | Figure scale | Frontend vitest | Canvas backing width == drawn width × DPR ± 2 px |
| **AC-P0-09** | Formula non-regression | Existing suites | DS-DOC-009 AC-P0-07/AC-P0-08 tests pass unmodified |
| **AC-P0-10** | Artifact, 0 calls, badge, flip | Backend pytest + vitest | Cache bytes unchanged; 0 calls on open; flip both ways |
| **AC-P1-01** | Contrast | Node contrast script | Ratio ≥ 4.5 : 1 in the shipped theme |
| **AC-P1-02** | Clipboard purity | Frontend vitest | Clipboard payload === stored LaTeX |
| **AC-P1-03** | Keyboard | Frontend vitest | `Alt + T` focus, `v` flips |
| **AC-P1-04** | Degradation notice | Frontend vitest | Tooltip contains the notice when the artifact records it |

**Bundle.** No new package. KaTeX is already bundled and code-split (DS-DOC-010 AC-P0-07); the
converter and the table component belong in the same asynchronous chunk. The initial chunk
(`dist/assets/index-*.js`, raw) must not grow: measured before and after, and reported against the
current measurement **304.54 kB** (DS-QA-015 §0.1; AC-P0-52's frozen 300.0 kB target is unmet there,
with an amendment to 310.0 kB proposed and not yet applied — this tranche neither fixes nor worsens
that, and must say which number it was measured against).

**Not measured yet, and therefore not claimed:** how many tables in a *general* paper typeset (24
tables from 2 papers is a sample, not a rate); whether the fit rule's 0.70 floor is the right floor
across a wider corpus; and whether a real extraction backend reproduces the 24/24 conversion. See
`.agent/evidence/DS-MINERU-001.md` §9 for the standing unmeasured list.

---

## 5. Transition & Superseding Declaration

1. **Relation to DS-DOC-009:** this document **amends the scope of** DS-DOC-009's magnification
   rule. The rule itself (`prose_px / ink_pt`, clamped `[1.0, 2.5]`) survives **unchanged for
   `isolate_formula`** (AC-P0-09 here) and is **retired for `figure`** (AC-P0-08 here). DS-DOC-009
   AC-P1-01 (the wide-table scroller) is **promoted from SHOULD to a mechanism AC-P0-07 depends
   on** — it is already implemented, and this document relies on it.
2. **Preserved contracts:** DS-DOC-010 AC-P0-01…AC-P0-14 (formula artifact, zero calls, disclosure,
   parse validation, KaTeX bundling, layout, containment, provenance, number association, clipboard)
   remain active, binding and unamended. DS-DOC-009 AC-P0-01…AC-P0-12 remain active except as
   amended above. `docs/acceptance/DS-QA-013.md`'s Decision C ("table structure is a separate
   feature") is **discharged by this tranche** for rendering purposes; its exclusion of table text
   from QA retrieval is untouched.
3. **Execution ready:** on freezing, the implementation agent is authorized to add the table
   converter and artifact (backend), the table component and the figure scale change (frontend),
   and the associated tests, to satisfy every AC-P0 and AC-P1 above. It is **not** authorized to
   change the extractor, the IR's existing fields, or any cached artifact format.

---

## 6. Round 1 review — read against the repository

The document was written from measurements of an *extractor's* output and the *stated* geometry
(680 px column, 552 px slot). Read against the shipped source, one of its two central numbers was
wrong for a reason worth recording: it had been derived from the wrong formula. Four changes are
recorded; the first two are corrections, the last two are limits of the evidence.

### AC_CHANGE_REQUEST 1 — a crop is never drawn below 1:1, and the cost of the clamp is text size

**Old wording, §2.5 and D5:** tables "**454 – 1166 px** … the rule magnifies, the slot then clamps —
**net shrink below 1:1**", and figures "**804 – 806 px** … all clamped".

**New wording:** the shipped rule is `naturalPx = boxWidth × scale` (no 96/72 step, as DS-DOC-009
AC_CHANGE_REQUEST 1 already established), `slot = columnWidth` for a table or figure, and
`displayWidthPx = overflows ? naturalPx : min(naturalPx × magnification, slot)`. Since
`magnification ≥ 1`, **`displayWidthPx ≥ naturalPx` always** — a crop is never shrunk below its own
natural size, in either branch. What the clamp costs is the text size, and that is what the
document now states: `crop text px = min(16 × scale, ink × 680 / box_pt)`, against
`typeset text px = 16 × min(1, 552 / typeset_width)`.

**Reason.** The first draft applied the *formula* slot (`columnWidth − 64 = 616`, and then 552 after
the −128 used at the call site) and a 96/72 conversion to tables and figures. Neither is in the
code path for those classes: the slot is the whole column, and the conversion does not exist in this
view. Measured consequence for the reader's widest table (464.4 pt, ink 8.5): drawn at 680 px,
**1.46×** at scale 1.0 and **1.17×** at 1.25 — magnified, not shrunk, and its text at 12.4 px. The
qualitative claim the draft was reaching for survives, in a form the numbers support: the ink-matched
request *is* discarded by the clamp, and for the widest items the reader gets the column width
rather than the prose-matched size.

### AC_CHANGE_REQUEST 2 — typesetting is not more legible, it is more *usable*

**Old wording, D4:** "Typeset iff … scale ≥ 0.70", justified by a 5.7 px worst case.

**New wording:** typeset iff scale ≥ 0.70, justified as a **legibility budget**: measured on the 20
tables the two fixtures can pair, the crop is at least as legible as the typeset table in every
case — 10 flat ties at 16.0 px, 10 where the crop is larger — and at the floor four tables are
typeset at up to 21 % smaller text than their crop (12.7 px against 16.0 px). The floor is the price
paid for selectable, copyable, translatable, screen-readable text, not a point where the typeset
version wins on size. The floor's value is stated as robust rather than exact: the measured splits
are identical for every floor from 0.60 to 0.75, because the scales have a gap between 0.59 and
0.79.

**Reason.** The draft assumed typesetting would be more legible for the tables it kept. On the
corrected arithmetic it never is; the crop's text is prose-sized whenever the column does not bind,
and the typeset text is prose-sized only when the table fits. Stating the trade honestly changes
what the criterion is for — and it makes AC-P0-10's badge-and-flip part of the *reason* the floor is
acceptable rather than a decoration on top of it.

### AC_CHANGE_REQUEST 3 — AC-P0-07 was already true for crops

**Old wording, AC-P0-07:** "A table that fails the fit rule must not be scaled down to fit the slot.
It renders at 1:1 …".

**New wording:** the same requirement, stated as the invariant it is — `displayWidthPx ≥ naturalPx`,
which `CropItem` already guarantees — plus the extension this tranche owes: the invariant must hold
for a typeset table's neighbour too, and the scroller must still fire.

**Reason.** `ReflowBilingualReader.tsx:664-666` implements exactly this for every crop today,
including the comment that says why ("A crop wider than the column *at its natural size* is not
shrunk: the reader asked for that zoom"). Filing it as new work would have paid for code that
exists; filing it as a non-regression is what it is.

### AC_CHANGE_REQUEST 4 — 4 of the 24 tables could not be measured, and the AC must say so

**Old wording:** the split was stated as "6 / 8 and 12 / 16" — 24 tables.

**New wording:** the split is stated on **the 20 tables that pair** (14 typeset / 6 crop at the
0.70 floor), and the four that do not are named: Mamba p6, where this repository's IR calls the
SSM/S4 algorithm box a `table` and the other extractor calls it an `image` (1 table, no
counterpart), and Mamba p16, where the IR holds 5 tables and the other output 4. The AC's evidence
clause now requires the harness to report the fit **per table**, so an unpaired table is visible
rather than dropped.

**Reason.** Pairing by index silently misaligned the two lists — the first run of this analysis
reported a 137.0 pt table at fit 0.35, which is a mispairing (a small table cannot need the most
scaling). Pairing by page then order is correct, and it surfaces that 4 tables have no measured
typeset width at all. A criterion whose evidence quietly covers 20 of 24 tables is a criterion that
would pass while 4 tables shipped unmeasured.

### Accepted and recorded without change

- **D1, D2, D3 and the conversion contract (§2.2):** reproduced from the fixtures — 24 of 24 tables
  convert and parse; the two failures before span flattening were both `\multicolumn`, which is why
  D2 exists.
- **The `✗` symbol gap (D3):** unchanged, and it is the reason AC-P0-04 asserts *zero*
  `unknownSymbol` warnings rather than "renders without throwing".
- **Confirmed unchanged — AC-P0-09, formula non-regression:** checked against `crops.tsx:77`; formulas are never
  clamped in the fixtures (drawn 175–543 px against a 680 px column, text exactly 16.0 px at scale
  1.0), so the rule this tranche leaves alone is doing its job.
