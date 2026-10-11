# ADR-003 — Extraction Backends, and Admitting MinerU as an Optional One

- **Status:** **Proposed** — the maintainer chose an *optional* extraction backend on 2026-09-27;
  this ADR fixes the rules that choice implies and is awaiting signature on them
- **Date:** 2026-09-27
- **Phase:** post-DS-DOC-010
- **Deciders:** project maintainer
- **Evidence:** `.agent/evidence/DS-MINERU-001.md` (every number below is measured there, with the
  commands and the sandbox that produced it); `docs/acceptance/DS-DOC-011.md` §0.3 (the precondition
  this unblocks); `docs/decisions/ADR-001` (the adapter pattern this follows), `ADR-002` (the licence
  posture this must not disturb)

## Context

`backend/app/document/extract.py` is the only way a document becomes a `DocumentIR`: PyMuPDF for
text, our own ONNX run of the DocLayout-YOLO layout model, and hand-written reading order,
heading and paragraph assembly on top. It is measured, it is ours, and it is what every cached
artefact in this repository is keyed to.

Two things force a decision about whether that stays the only way.

1. **A tranche is blocked on structure this extractor does not produce.** DS-DOC-011 (tables
   typeset) needs a `table` block carrying a grid. Today a table arrives as
   `'Method\nImageNet\nPlaces365\n…'` — flat fragments (DS-QA-013's finding). Nothing can be
   typeset from that, and the tranche cannot start until something produces structure.
2. **A measured candidate exists.** `.agent/evidence/DS-MINERU-001.md` records MinerU 4.0.7 run
   inside an isolated venv against two papers this repository already has measurements for. It
   produces, on those fixtures: table structure as HTML (24 of 24 convertible to KaTeX-parseable
   LaTeX), display and inline formula LaTeX (248 of 248 parsing under this repository's own KaTeX),
   an equation number inside the LaTeX as `\tag{n}`, and headings our extractor misses (3 of them
   on the reader's paper).

Against that, the same record measures what adopting it costs: **2.0 GB of models** against the
71.9 MiB layout model we ship (818.5 MiB for the `basic` tier alone); **telemetry that is on by
default** in its document-library service and off only for an explicit `disabled`; a text layer
whose de-hyphenation is worse and *differently* worse than ours; and a 4.0.x line that is one week
old at the time of writing.

## Findings bearing on the decision

Each is from `DS-MINERU-001`; the section in parentheses is where it is measured.

1. **The stateless path is silent; the service is not.** `mineru-kit parse` contains no telemetry
   code and made **zero** non-loopback connections on `flash`, `basic` and `standard` (5 s / 11 s /
   22 s on a 2-page PDF, audit hook + refusing proxy, §6.6). The document-library service
   (`mineru server`, `mineru parse`) attempted `CONNECT mineru.net:443` **~6 s after start with
   consent at its default `unset`**, because the opt-in gate is commented out (§6.2–6.3).
2. **The whole `standard` tier delta is 8 blocks.** 230 blocks in both tiers, all boxes identical,
   222 contents byte-identical; the 8 are 7 equations and 1 table. What it buys is math rendering
   quality; what it costs is +1184 MB and 1.6× the time (§3.3).
3. **It is not more complete than we are on display formulas** — 7 ↔ 7 on the reader fixture — but
   it *is* more complete on inline math (80 and 148 fragments that our IR has no representation
   for), and its boxes include the equation number where ours emits a separate `formula_caption`
   (§3.1, §3.6).
4. **It reproduces our extractor's error modes.** The `isolate_formula` false positive on the
   reader's p11 (`a photo of a {class}.`) is an `equation` for MinerU too, in both tiers (§3.1).
5. **Its text is not our text.** Measured defects: `imagetext`, `imagecaption`, `momentumaveraged`,
   `teacherstudent` (dropped hyphens), `pre-dictor` (a kept line-break hyphen), `Vl-jepa` for
   `VL-JEPA`, and `✗` whose KaTeX metrics do not exist (§3.7, §7.3).
6. **Our crops cannot come from it.** Its `images/*.jpg` are rasters; ours are re-rendered from the
   PDF's vector source at whatever scale the reader asks for (DS-DOC-009 AC-P0-07 and its change
   request 1). The maintainer's direction of 2026-09-27 is explicit: figures keep our crops.
7. **Its licence is not ours, and is not copyleft.** ≤ 3.0.x is AGPL-3.0; ≥ 3.1.0 is the MinerU Open
   Source License (Apache-2.0 plus a scale-based commercial gate and an attribution duty when
   offering third-party online services). ADR-002's posture — local, personal, no distribution —
   is undisturbed either way; a process boundary keeps the combined-work question out of it
   entirely (§8).

## Decision

**`DocumentIR` becomes the product of a *backend*, and MinerU is admitted as a second, optional
one — pinned, stateless, off by default, and never the default.**

Rules that follow:

- **The default does not change.** PyMuPDF + DocLayout-YOLO remains what a paper gets unless the
  reader asks otherwise. Nothing about the existing extraction, its `IR_PIPELINE_VERSION`, or any
  cached artefact changes because this ADR exists.
- **The boundary is a module, not a flag.** Every backend lives under `backend/app/document/` and
  returns a `DocumentIR`; nothing above that boundary knows which one produced it. The same isolation
  ADR-001 applies to the translation kernel applies here: one package, one adapter, no upstream
  import above it.
- **Stateless CLI only.** The engine is `mineru-kit parse … --format zip` in its own venv, invoked
  as a process. The document-library service is **not** adopted: it duplicates this application's
  Library, it wants a background daemon, and it is the one component measured to send telemetry.
- **Its process, never our interpreter.** MinerU is never imported into `backend/.venv` (measured:
  2.0 GB of models, a PaddleOCR-family stack, and a llama.cpp build; ADR-001's "pin behind an
  adapter" in its strongest form).
- **Pin exactly, and record the pin here.** The 4.0.x line is days old and moving; its schema
  (`docvortex.middle` v2.0, `page_idx` 0-based, **bbox normalised 0–1**) is not the 3.x schema any
  documentation still describes. A pin bump re-runs the adapter tests and re-reads §2 of the record.
- **`basic` is the tier; `standard` is opt-in.** The measured delta between them is math rendering
  quality alone (finding 2). Paying 1.6× the time and +1184 MB for that is a per-document choice,
  not a default.
- **First run is an explicit, visible step.** The model download is 818.5 MiB (`basic`) and the
  enabling action discloses it before it happens — the pattern `ensure_layout_model` already sets
  for a 72 MiB download, applied to one eleven times larger. A silent multi-minute stall inside a
  reading session is a defect, not an installation detail.
- **Telemetry is disabled at install, and asserted.** `mineru telemetry disable` runs before any
  parse, and the repository's existing non-loopback-socket discipline extends to a test that a
  MinerU-backed extraction makes **no egress** (finding 1). "No telemetry" must remain a measured
  property of this application, not a property of someone else's code that we hope holds.
- **Anchors are ours, always.** `source_anchor_id` is computed from this repository's own page
  identity, geometry and text — never from a backend's text, which finding 5 shows is a different
  string. The MinerU backend therefore supplies *semantics* (structure, LaTeX, classification) on
  top of the geometry and text our anchors already use: the IR's own split of physical block from
  semantic paragraph, made load-bearing. Notes and highlights survive a backend switch; if that
  proves impossible for some block, the block keeps our text and loses only the structure.
- **Crops stay client-side.** MinerU's raster `images/` are not adopted (finding 6), with one
  exception: nothing in this ADR forbids reading its per-equation crop as a *hint* for locating a
  formula — but what is drawn remains ours, from the vector source.
- **Cost disclosure changes shape.** The ledger counts provider calls; a MinerU extraction costs
  **bytes and seconds**. The enabling UI must say what it costs in those units, because the
  existing disclosure mechanism cannot express it (the repository's rule: the button says what it
  will spend before it is pressed).
- **The licence line is recorded, not interpreted.** `THIRD_PARTY_NOTICES.md` gains MinerU with its
  version boundary (≤ 3.0.x AGPL-3.0 / ≥ 3.1.0 MinerU Open Source License). ADR-002's Phase-12 gate
  applies to it: distribution, if it ever happens, is analysed then, and the version boundary must
  be re-read at the pinned version rather than taken from this document.

## What this unlocks, and what it does not decide

**Unlocks:** the precondition in DS-DOC-011 §0.3 — a `table` block carrying a grid, from which that
tranche's converter produces typeset tables. It also puts two further opportunities on the table
without deciding them: display *and inline* formula LaTeX for `app/formulas/` at zero provider
calls, and the inline-formatting runs the roadmap lists first (`bold` ×32, `superscript` ×9,
`subscript` ×3 on the reader's paper, delivered as data rather than re-derived).

**Does not decide** — each needs its own measurement or its own ADR:

| Open | Why it is not decided here |
|---|---|
| Whether the default backend ever changes | The measured record is two papers, both LaTeX-heavy English ML papers. The rate across a corpus is unmeasured (DS-MINERU-001 §9) |
| Whether `app/formulas/` is retired in favour of local recognition | It would trade a paid, badged, verified reconstruction for a free one that is *also* wrong in ways that look right — the `\hline` the VLM tier inserts into equation 4 is measured. Same badge-and-crop discipline, new evidence required |
| The OCR gap (scanned pages) | Measured only on the native text layer (`parse_mode: txt`); `--ocr-mode ocr` was never run |
| Which tier per document | `standard` was measured on one paper |
| The exact anchor recipe for a MinerU-backed block | Named as a constraint above; the recipe is DS-DOC-011-era work with its own acceptance criteria |
| Vector retrieval, glossary, anything else | Out of scope |

## Escalation / reopening conditions

This ADR is reopened, **not reinterpreted**, if any of these becomes true:

1. The stateless path is measured to make egress (finding 1 was measured on 4.0.7; it is a property
   of a version, not a promise).
2. A pin bump changes the `middle_json` schema in a way that invalidates §2 of the record.
3. The maintainer wants MinerU to become the default extractor, or wants its crops, or wants the
   document-library service — each is a different decision with different evidence.
4. ADR-002 is reopened for distribution, which pulls MinerU's licence terms into the analysis.

## Consequences

**Positive**
- The blocked tranche (DS-DOC-011) gets a sanctioned source of structure, and the source is behind
  a boundary that can be replaced by another extractor without touching anything above it.
- Everything measured about MinerU — including its telemetry — is written down before it is used,
  so the "no telemetry, no external CDN" property stays a claim this repository can test.
- The default path carries none of the new weight: no new models, no new process, no new licence
  obligation for a reader who never asks for it.

**Negative**
- A second extraction path means two behaviours to keep honest, and a UI obligation to say which
  one produced what is on screen.
- 2.0 GB of models, a separate venv and a second Python environment to keep working is real
  operational weight for an optional feature.
- An extractor that moves as fast as MinerU 4.x is a maintenance commitment that a pinned,
  adapter-behind dependency only partly mitigates.
- The measured sample is two papers. This ADR admits a candidate; it does not certify a rate.

## Alternatives considered

| Option | Rejected because |
|---|---|
| **Make MinerU the default extractor** | Every cached artefact is keyed to the current extraction; the measured sample is two papers; and the default path would gain 2 GB of models and a licence obligation for readers who never asked |
| **Adopt only its formula module** (a local MFR model) in place of `app/formulas/` | Nothing measured supports the swap — no MFR-only run was made, and the pipeline's coupling was not measured. Cheaper to consider *after* a backend boundary exists (§"unlocks") |
| **An LLM reconstruction of tables from the flat text** | The structure is present in the layout and extractable exactly; paying a model to guess it would be DS-DOC-010's trade made where it is not needed |
| **Write our own table-structure model** (SLANet-class ONNX, as we did for layout) | A real option with a smaller footprint, but it is *another* model to source, pin and validate, and it produces only one of the four things the record shows this backend produces. Recorded as the fallback if MinerU's weight proves unacceptable |
| **Do nothing; keep tables as crops** | Then DS-DOC-011 cannot exist, and tables stay unselectable, untranslatable and unsearchable in a reader whose purpose is to make a paper usable |
| **Adopt the document-library service as well** | It duplicates this application's Library, it daemonises, and it is the component measured to phone home by default |
