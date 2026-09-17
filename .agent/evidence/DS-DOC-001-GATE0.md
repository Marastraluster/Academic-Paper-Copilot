# Gate 0 — DS-DOC-001 Real-Paper Validation

- **Date:** 2026-09-17
- **Purpose:** close `AC-DOC-32`, which DS-DOC-001 left **PARTIAL**
- **Verdict:** **Five defects found and fixed. Re-validation PASSES.** Four of the five were
  latent in the shipped DS-DOC-001; one was a false claim in its evidence.

## The paper

| | |
|---|---|
| **Paper** | He, Zhang, Ren, Sun — *Deep Residual Learning for Image Recognition* (ResNet), arXiv:1512.03385 |
| **Pages** | 12 |
| **Page size** | 612 × 792 pt (US Letter, IEEE two-column) |
| **Why this one** | Two-column throughout, 22 headings across three levels, display equations with numbered captions, 7 figures, 15 tables, numbered citations, a References section, an appendix, and inline math — every property §4 asked for |
| **Retrieved** | Public arXiv PDF, network access confirmed first (§4 permits this) |
| **Storage** | `.agent/results/gate0/resnet.pdf` — **local verification artifact only, never committed** (`.agent/results/*` is gitignored) |

## What Gate 0 found

Running the unmodified DS-DOC-001 extractor produced 22 sections, of which **6 were phantom**,
and a page-1 reading order that mixed the columns.

| # | Defect | Severity |
|---|---|---|
| A | A line of body prose the model labelled `title` became a section: *"greatly benefited from very deep models."* | Real — invented structure (FC-11) |
| B | Five table sub-labels (`PASCAL VOC` ×2, `MS COCO` ×3, `ImageNet Detection`) became sections | Real — invented structure |
| C | A block crossing the column gutter was ordered last on the page instead of at its own y | Real — reading order |
| D | **`metadata.title` was never taken from the layout** — AC-DOC-30's primary clause was unimplemented and wrongly reported as PASS | Real — false claim in evidence |
| E | A 5pt page number sitting in the gutter collapsed the two-column split, interleaving the page | Real — reading order |

## Why two obvious fixes were rejected before one was accepted

Both candidate heuristics were **measured against the paper** rather than assumed, and both failed:

* **"A heading is followed by prose."** Every one of the 6 spurious headings satisfied it — the
  table regions contain text the extractor classifies as `plain text`, so a table label is
  genuinely followed by prose.
* **"A label sits near a table; a heading does not."** `Abstract` and `4. Experiments` sat at
  **zero** points from a table/figure, while `PASCAL VOC` sat at infinity.

The rule that worked was the one AC-DOC-27 named and DS-DOC-001 never implemented: **font size**.

```
p 1  size=14.3 body=10.0 HEADING 'Deep Residual Learning for Image Recognition'
p 1  size=12.0 body=10.0 HEADING 'Abstract'
p 1  size=10.0 body=10.0 REJECT  'greatly benefited from very deep models.'
p10  size=12.0 body=10.0 HEADING 'A. Object Detection Baselines'
p10  size=10.0 body=10.0 REJECT  'PASCAL VOC'
```

**17 of 17 real headings accepted, 6 of 6 spurious rejected.** Where the evidence is absent — a
hand-built block, a PDF with no font metrics — the block is accepted, because rejecting on absent
evidence would silently drop real sections.

## Fixes

1. **Font-size heading test** (`_is_heading_sized`) — a `title` block must be set larger than the
   page's body text to become a section.
2. **`font_size` added to `TextBlockIR`** — source-derived evidence, so a heading decision is
   reproducible from the stored IR without re-opening the PDF.
3. **Gutter detection by minimum coverage** (`_column_split`) — replacing greedy rectangle
   merging, which merged full-width lines *into* the right column. The gutter is where the fewest
   blocks cross, not where none cross; requiring emptiness failed on real banners, and a stray
   sliver in the channel defeated it entirely.
4. **Gutter-crossing blocks keep their vertical position** — treated like full-width blocks
   rather than becoming a column of their own sorted last.
5. **Layout title fallback** (`layout_title_block`) — the largest `title` block on page 1 fills
   in absent or generic PDF metadata.
6. **Slivers excluded from the coverage profile** — a block under ~10pt cannot be a column.

## Gate 0 result

```
DS-DOC-001 REAL-PAPER VALIDATION

Paper:                      ResNet, arXiv:1512.03385 (He et al.)
Pages:                      12

Two-column order:           PASS   (0 column-confined blocks after their column ended, all 12 pages)
Display formula handling:   PASS   (isolate_formula + formula_caption detected; prose breaks around them)
Inline math surrounding:    PASS   (prose adjacent to formulas is intact and correctly ordered)
Heading detection:          PASS   (16/16 genuine, 0 phantom, after the fix)
Caption detection:          PASS   (figure_caption linked to its figure block)
Page mapping:               PASS   (every paragraph resolves to a valid 1-based page)
References detection:       PASS   ('References' found on page 9)

Observed limitations:
  - One 5pt page-number glyph still sorts to the end of page 1. It is a sliver in the
    gutter, not prose, and reaches no paragraph.
  - Column splitting resolves two columns. A three-column layout degrades to left-half /
    right-half rather than being mis-ordered in some more inventive way.
```

## Re-validation detail

Page 1 reading order, after the fixes — left column exhausted before the right begins:

```
L y= 104 title          'Deep Residual Learning for Image Recognition'
L y= 150 plain text     'Kaiming He / Xiangyu Zhang / Shaoqing Ren / Jian Sun'
L y= 184 plain text     '{kahe, v-xiangz, v-shren, jiansun}@microsoft.com'   ← was ordered last
L y= 224 title          'Abstract'
L y= 245 plain text     'Deeper neural networks are more difficult to train…'
L y= 425 plain text     'The depth of representations is of central importance…'
L y= 534 title          '1. Introduction'
L y= 555 plain text     'Deep convolutional neural networks [22, 21] have led…'
R y= 223 figure         …
R y= 304 figure_caption 'Figure 1. Training error (left) and test error (right)…'
R y= 376 plain text     'Driven by the significance of depth, a question arises…'
R y= 498 plain text     'When deeper networks are able to start converging…'
R y= 595 plain text     'The degradation (of training accuracy) indicates…'
```

Page 3, the formula-heavy page:

```
L … y=623 isolate_formula 'y = F(x, {Wi}) + x.'
L … y=625 formula_caption '(1)'
L … y=647 plain text     'Here x and y are the input and output vectors…'
R … y=262 isolate_formula 'y = F(x, {Wi}) + Wsx.'
R … y=264 formula_caption '(2)'
```

Formulas are isolated with their own captions, and the surrounding prose is neither absorbed into
them nor lost.

Sections after the fix — 16, all genuine, with correct levels:

```
L1 Abstract          L1 1. Introduction    L1 2. Related Work
L1 3. Deep Residual Learning
   L2 3.1. Residual Learning   L2 3.2. Identity Mapping by Shortcuts
   L2 3.3. Network Architectures   L2 3.4. Implementation
L1 4. Experiments
   L2 4.1. ImageNet Classification   L2 4.2. CIFAR-10 and Analysis
   L2 4.3. Object Detection on PASCAL and MS COCO
L1 References        L1 A. Object Detection Baselines
L1 B. Object Detection Improvements   L1 C. ImageNet Localization
```

`metadata.title` after the fix: `'Deep Residual Learning for Image Recognition'` — recovered from
the page, since the PDF carries no title metadata.

## Verification

```
$ cd backend && .venv/Scripts/python -m pytest tests/test_document_ir.py
    → 46 passed        (41 before, +5 Gate 0 regression tests)

extraction:                  12 pages in 4.8 s → 0.40 s/page
interleaved narrow blocks:   0 across all 12 pages
phantom sections:            0 of 16
```

Five regression tests now pin these defects: body-size labels rejected, heading-sized blocks
accepted even without font evidence, gutter-crossing lines keep their position, a sliver in the
gutter does not hide the split, and the layout title fills in absent metadata.

## Correction to the DS-DOC-001 evidence

`AC-DOC-30` was reported **PASS**. It was not: only the metadata half existed, and the
criterion's primary clause was unimplemented and untested. Gate 0 caught it because the test
paper has no title metadata — the exact case the layout fallback exists for. The claim has been
corrected in `.agent/evidence/DS-DOC-001.md` rather than quietly overwritten.

This is the failure mode the run→observe→record discipline exists to prevent, and it is worth
naming plainly: **a criterion can be marked PASS because the half that was implemented works,
while the half that was not implemented is never exercised.**

## Verdict

The IR is sound enough to build DocumentAnalysis on. Gate 0's purpose was to establish that
before the Context Engine depends on paragraph quality, and it did — by finding five defects that
a synthetic fixture could not have exposed.
