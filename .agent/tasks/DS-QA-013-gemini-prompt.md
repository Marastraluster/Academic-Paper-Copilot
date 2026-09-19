# DS-QA-013 — Acceptance Criteria authoring task (Gemini)

You are the independent Acceptance Criteria author for the Academic PDF Copilot
repository at `D:\marti\SciPrograms`. DeepSeek owns all production code. **You do
not write production code.** Your only deliverable is one document.

## Your deliverable

Write:

    D:\marti\SciPrograms\docs\acceptance\DS-QA-013.md

P0 MUST / P1 SHOULD / P2 OPTIONAL criteria, each numbered, each independently
verifiable, each stating its evidence. Follow `docs/acceptance/DS-QA-012.md`.

## Time budget — read before you start

Hard 25-minute wall clock. **Do not run the test suites, the build, `pytest` or
`vitest`.** A previous round was lost to an agent that spent its budget launching
suites and returned no document. Read source, decide, write.

## The task

**DS-QA-013 · Non-prose Annotation.** Let a reader persistently annotate visible
selectable academic content that is deliberately outside `ParagraphIR`, without
broadening the Paper QA evidence corpus.

    today:  visible selectable caption/formula
            → belongs to no paragraph
            → SelectionMapping produces no anchor
            → annotation creation is refused

## MEASURED — the gap, reproduced on the current pipeline

`.agent/results/nonprose/audit.txt`, five real papers, current extraction:

| paper | figure_caption | table_caption | formula_caption | isolate_formula |
|---|---|---|---|---|
| resnet | 8 | 5 | 2 | 2 |
| mamba | 13 | 8 | 4 | 7 |
| diffusion-policy | 24 | 2 | 9 | 11 |
| ppo | 7 | 4 | 12 | 12 |
| unet | 2 | 0 | 0 | 0 |
| **total** | **54** | **19** | **27** | **32** |

blocks *outside any paragraph*, counted by geometric coverage. Also outside:
`figure` 49, `table` 46, `title` 163, `table_footnote` 15, `abandon` 103.

**The task's stated "14 captions / 4 formulas" does not match any current paper.**
It was a DS-DOC-003-era figure. The measured values above are the real ones and
supersede it.

## MEASURED — are these actually selectable in a browser?

`.agent/results/nonprose/browser/probe.json`. Real Edge, real PDF.js text layer,
the application's own published scale, resnet, 12 pages:

```
class               blocks  selectable  exact text
figure_caption           9         9         9
table_caption            5         5         5
formula_caption          2         2         2
isolate_formula          2         2         2
figure                   7         7         7
table                   15        15        15
table_footnote           7         7         7
title                   23        23        23
```

"exact text" means ≥90% of the canonical block text's characters were present in
the text-layer spans under the block's own rectangle. Every formula:

```
y = F(x, {Wi}) + x.    18 spans  coverage 1.0
y = F(x, {Wi}) + Wsx.  20 spans  coverage 1.0
(1)                     1 span   coverage 1.0
(2)                     1 span   coverage 1.0
```

**So `isolate_formula` blocks carry reliable selectable text**, and the equation
numbers are their own `formula_caption` blocks. This is a measurement, not an
assumption — the task's Phase 11 lists four possible formula representations and
expected only one of them to qualify.

One caution the measurement also shows: `figure` blocks are selectable but their
text-layer text is figure-internal labels run together without separators, e.g.
`"identityweight layerweight layerrelureluF(x)\u0001+\u0001xxF(x) x"` and
`"0 1 2 3 4 5 601020iter. (1e4)training error (%)"`. Also `abandon` blocks hold
page furniture — the arXiv stamp, running footnotes, page numbers.

## Architecture that must not change

- **`ParagraphIR` is the QA/retrieval corpus.** FTS, `EvidenceItem`,
  `SearchScope`, citations, Section QA, Selection QA and `DocumentAnalysis` all
  read it. **Do not absorb captions into paragraphs** to make annotation work.
- **The paragraph anchor recipe is frozen**: `sha256(SOURCE_ANCHOR_VERSION |
  content_hash | page_number | quantized bbox | canonical text)`, version `"1"`,
  quantum 2.0 pt. It is persisted user data. DS-DOC-002 measured 150/160 anchors
  surviving a real extraction change; that number must stay.
- **The annotation target table has no kind column.** `annotation_targets`
  stores `source_anchor_id, anchor_version, page_number, original_bbox, rects,
  exact_quote, prefix, suffix, target_order` and nothing that says what kind of
  source unit the anchor names.
- **The notes list, search, and export all work without an extracted IR** — this
  is DS-QA-010-FIX-001's boundary and it is load-bearing. A caption note must
  list, search and export with no `ir.json` present and no extraction triggered.
- **`captureSelection` is currently shared by the QA scope selector and by notes
  creation.** Widening it widens Selection QA, which the task's Phase 55 says not
  to do silently.

## Decisions you must make explicitly

- **A.** Which source classes are supported in P0? Candidates: `figure_caption`,
  `table_caption`, `formula_caption`, `isolate_formula`. The measurements say all
  four are selectable and canonical; say which you freeze and why.
- **B.** Do `title` (heading) blocks become annotatable now? They are selectable
  and clean, but the task's trigger was captions and formulas.
- **C.** Tables — distinguish `table_caption`, `table_footnote`, and `table` body
  text. Table body text is selectable but is a grid of fragments, not a unit.
- **D.** Figures — `figure` blocks hold axis labels and diagram text run together
  without separators. Is that annotatable, or is figure annotation a different
  interaction (region drawing) that is out of scope?
- **E.** Does annotation need a generic source-unit concept (`AnnotationSourceUnit`,
  `AnchorableSourceUnit`, `SourceBlockAnchor`), or is the current target schema
  generic enough once a kind is recorded?
- **F.** Do paragraph anchors and block anchors share one namespace?
- **G.** Does the stable block anchor's canonical input include the source type?
  (Strong hypothesis: yes — otherwise a caption and a paragraph with the same
  text, page and geometry could collide.)
- **H.** What exactly goes into the block anchor's hash? The paragraph anchor uses
  version, content_hash, page, quantized bbox, canonical text. What changes?
- **I.** Formula text normalisation: the measured text is `y = F(x, {Wi}) + x.`
  — spaces, braces, superscripts flattened. What is safe to normalise, and what
  must be preserved verbatim?
- **J.** Does the anchor's identity text differ from the user-visible quote?
  (Phase 13 says the user must never be shown normalised or hash text.)
- **K.** How is a mixed paragraph + caption selection persisted — one annotation
  with heterogeneous targets, or refused?
- **L.** Does Paper QA Selection scope accept non-prose targets? (Strong
  hypothesis: no, in this task.)
- **M.** How do Markdown and JSON export represent the target kind?
- **N.** What happens when an older app version opens an annotation containing a
  new kind? What does a *new* version do with a record that has no kind?
- **O.** Does the database need a migration? `annotation_targets` has no kind
  column, and existing rows must keep loading.

Also decide and state:

- **P.** What "unsupported source class selected" does — refuse the whole
  gesture, or persist the supported part with an explicit statement.
- **Q.** Whether reattachment for non-prose units is page-scoped like paragraphs,
  and what the cascade is.
- **R.** The exact guarantee for identical/duplicate captions (`"Results."`,
  `"Table 1."` appearing twice) — text alone cannot distinguish them.
- **S.** Whether `abandon` blocks (arXiv stamps, page numbers, running footnotes)
  are annotatable, refused, or simply never offered.
- **T.** Whether headings and captions may become sections or appear in the
  outline. (Strong hypothesis: no.)
- **U.** The export schema version question: does adding an optional kind keep
  `NOTES_EXPORT_SCHEMA_VERSION = "1"` valid, or must it be bumped?

## Acceptance criteria must cover at least these 53 areas

1 annotation domain boundary, 2 ParagraphIR unchanged, 3 caption eligibility,
4 formula eligibility, 5 heading eligibility, 6 table eligibility,
7 figure/image eligibility, 8 unsupported source class behaviour,
9 source-unit identity, 10 stable anchor versioning, 11 document fingerprint,
12 page identity, 13 geometry, 14 canonical text, 15 duplicate captions,
16 duplicate formulas, 17 deterministic anchors, 18 repeated extraction,
19 block reorder, 20 bbox jitter, 21 caption text normalization,
22 formula normalization, 23 source-class preservation, 24 selection mapping,
25 mixed prose + caption selection, 26 mixed prose + formula selection,
27 multi-target ordering, 28 cross-page interaction, 29 persistent rects,
30 reload, 31 restart, 32 reattachment, 33 ambiguous, 34 orphaned, 35 note search,
36 Markdown export, 37 JSON export, 38 Original reader, 39 Translation isolation,
40 Bilingual isolation, 41 rotated pages, 42 zoom, 43 fit-width, 44 virtualization,
45 source immutability, 46 zero AI calls, 47 QA isolation, 48 retrieval isolation,
49 DocumentAnalysis isolation, 50 backward compatibility, 51 schema migration,
52 bundle ceiling, 53 browser E2E.

Out-of-scope areas must be named as **explicit non-goals**, not omitted.

## Rules

- Every P0 criterion must be **observable**. "Captions can be annotated" is not
  one. "Selecting the text of Figure 2's caption creates a target whose page is
  2 and whose quote is that caption's canonical text" is.
- State the **evidence** for each P0: which command, which browser observation,
  which test file.
- Do not invent constants (quantisation, tolerances) without saying what
  measurement justifies them, and do not silently reuse the paragraph anchor's
  2.0 pt quantum for a different source class — the task's Phase 28 says so
  explicitly.
- Budget headroom is **~14.7 kB** (335.32 kB of a 350 kB ceiling). No new library,
  no drawing/region-selection UI.
- Notes are **not** paper evidence. Name the test that keeps them out.
- Do not add import, cloud sync, PDF writeback, or any provider call.

Write the document now. Return, as your final message, only the list of P0
criteria ids with one line each.
