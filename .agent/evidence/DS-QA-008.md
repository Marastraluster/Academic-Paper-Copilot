# Evidence — DS-QA-008 Paper Outline + Structured Navigation

- **Date:** 2026-09-18
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-QA-008.md` (Gemini, frozen before
  implementation, with four `AC_CHANGE_REQUEST`s, all resolved)
- **Baseline:** `a264cac` (DS-QA-007 final)
- **Verdict:** **The outline is built, and building it exposed three defects in
  the structure it displays — one of which had been silently corrupting a stored
  paper for a day.** All three are fixed at source; none is patched around in the
  frontend.

## What was built

```
backend/app/document/extract.py    letter-prefixed numbering; _build_hierarchy;
                                   heading_block_id on every section
backend/app/document/models.py     IR_PIPELINE_VERSION; SectionIR.heading_block_id
backend/app/document/service.py    is_reusable(): a stale pipeline is not reused
backend/app/document/outline.py    the outline payload + the navigation ladder
backend/app/api/documents.py       /sections returns the outline
frontend/src/outline/              tree, live-position rule, panel, navigation
frontend/src/assistant/            one sidebar, two tabs
```

**Nothing about the outline required an LLM, an analysis, a translation or a
network call beyond `GET /sections`.** The one provider-adjacent assertion is
measured: opening the panel, expanding nodes and clicking sections produce **zero
`/answer` requests** (browser run).

## The three defects

### A — a stored paper was describing a document that no longer existed

`doc_6f4ab9d9d4d34f85bc9e441757240fd8` (ResNet) had **eight of sixteen sections
owning no paragraphs**, including its Abstract and its References. Replaying
today's `_assign_sections` on the same blocks gave **two**, and changed **44
paragraphs**: the reading-order fix (`ff744ab`) had reached every new extraction
and no cached one, and nothing could tell, because the only question
`extract_and_store` asked was "is this the right document".

`content_hash` answers *did the PDF change*. It cannot answer *did the code
change*. `index.py` has guarded its FTS index with `SCHEMA_SIGNATURE` for exactly
this reason since DS-QA-001; the IR had no equivalent. `IR_PIPELINE_VERSION` is
that equivalent, and `is_reusable` now requires all three.

Re-extraction confirms it: **empty sections 8 → 2**, 16/16 headings resolvable.

### B — appendices had no hierarchy

`_HEADING_NUMBER` matched only digit-prefixed numbering, so `A.1`, `B.1`, `E.2`
all parsed as level 1 and every appendix subsection became a sibling of its own
appendix.

The proposed rule was run against **all 112 distinct real section titles** in the
corpus before being accepted: it changes **21 levels, every one `1 → 2`, every one
a letter-prefixed appendix subsection, and no other heading at all**. It is
corroborated by a source outside this pipeline — Mamba's and Diffusion Policy's
own PDF bookmark trees place those headings at level 2.

### C — the existing Section scope was already wrong

`selectSectionForPage` returned the last section whose *start page* was at or
before the current page. Measured on ResNet page 3 — whose paragraphs belong to
**four** sections (`2. Related Work`, `3.1`, `3.2`, `3.3`) — it answered
**`3.3. Network Architectures`** for a reader at the top of the page in §2.

This was not a new-feature problem: Section-scoped questions had been sent with
that section id. The replacement is expressed in **canonical reading order**,
because a rule using vertical position is provably broken on a two-column page:
ResNet page 3's block order is left column (x≈49, y 73→647) *then* right column
(x≈308, y 73→…), so a right-column block at y=73 follows a left-column block at
y=647.

**Verified on the real paper in the browser**, scrolling through page 3:

```
1. Introduction -> 2. Related Work -> 3.1. Residual Learning
                -> 3.2. Identity Mapping by Shortcuts -> 3.3. Network Architectures
```

Five transitions, none repeated, §3.3 never reached early. This is the case
AC-P0-07 names.

## What the audit found that the criteria did not ask for

- **Heading geometry is recoverable without a schema change.** `_detect_sections`
  is deterministic and `PageIR.blocks` holds the extraction-time ordered block
  list, so re-running the *same function* reproduces the stored sections exactly
  on all four papers, with every heading block resolvable (16/16, 50/50, 16/16,
  34/34). `heading_block_id` stores a reference, not a second copy of the
  coordinates.
- **Native PDF bookmarks cannot be authoritative**: ResNet and PPO have **zero**.
  Diffusion Policy has 55 and Mamba 57, and where they exist they disagree with
  DocumentIR on appendix levels — in DocumentIR's favour once Defect B was fixed.
- **A `1.1.1` nesting bug that no benchmark paper could expose.** A unit test I
  wrote caught it: the numbered-parent lookup took only the first segment, so
  three-deep headings nested under their grandparent. No benchmark paper nests
  three deep, which is why four real papers had not shown it.

## What I did not fix, and why

Diffusion Policy's reading order **interleaves its columns on 13 of 24 bands**
(measured with `order_blocks`'s own logic). `_column_split` computes the empty run
as ~7.4 pt against a `_MIN_GUTTER_PT` of 8.0 — it misses by 0.6 pt, returns
`None`, and `_order_band` falls back to a pure y-sort. Mamba has 3 such bands;
ResNet and PPO have none.

This is classified **DOCUMENT_IR_DEFECT (pre-existing)**, recorded, and
deliberately **not** patched here. It is a threshold in validated reading-order
infrastructure; changing it would move paragraph→section assignment, citation
anchors and selection mapping across every paper, and this task is navigation.
The frozen P0 case (ResNet page 3) is unaffected — it detects its gutter cleanly —
and the outline follows the canonical order it is given.

**Two of my own harness errors, recorded because both looked like product bugs:**

1. The browser suite asserted `scrollTop < 200` after clicking Introduction. The
   real value is 964 — the heading *is* partway down page 1. The assertion
   encoded an assumption about the paper, not about the feature.
2. It queried the backend with the *baseline* document id while the browser was
   displaying a freshly uploaded one, so it verified a different document's
   outline. Discovered from the rendered node ids, not from reasoning.

## Verification

```
backend       872 passed   (844 before this task)
frontend      169 passed   (150 before this task)
typecheck     PASS
build         exit 0
bundle        317.73 kB initial (ceiling 350 kB) — +10.7 kB, no new dependency
real browser  ResNet 26/26 · Diffusion Policy 26/26 · Mamba 26/26  (1 skip each)
```

Three real papers, each driven in Edge against the real backend:

```
paper              sections  heading boxes  nested  active-section sequence
ResNet                   16  16/16            7    Intro -> Related -> 3.1 -> 3.2 -> 3.3
Diffusion Policy         50  50/50           35    Intro -> 2 -> 2.1 -> 2.2 -> 2.3 -> 3
Mamba                    34  34/34           22    Intro -> State Space Models
```

The skip is AC-P0-09's translation clause: no translated artifact exists in the
fixture, so `selectEffectiveMode` never enters translation mode and the branch
cannot be reached. Recorded as **SKIP**, not as a failure — a check whose
precondition the fixture cannot satisfy is a gap in the verification, not a defect
in the feature.

## Cleanup (Phase 86)

DS-QA-007 remains inert, verified rather than assumed:

```
embedding model loaded at startup     NO — app.qa.dense is not imported anywhere
dense index built in the normal path  NO — dense_ranking defaults None, no caller passes it
vector DB / embedding dependency      NO — pyproject declares tokenizers only, as an extra
embeddings.npz in user document dirs  NONE — the DS-QA-007 residue was removed
```

## Known limitations

1. **The current-section rule is a content-progress model, not a pixel-exact
   read-head.** It maps the viewport's scroll offset onto the page's canonical
   sequence by cumulative block height, so a page whose rendered proportions
   differ wildly from its content proportions maps approximately. It is
   deterministic and never claims a section the reader has not reached.
2. **Diffusion Policy's interleaved reading order** (13 bands) is inherited, not
   fixed — see above. Anything reading canonical order, including citations,
   inherits it.
3. **The outline opens behind a tab, not by default.** The criteria freeze the tab
   structure but not which tab opens first; the shipped default is Paper QA, and
   switching it would have moved every existing QA affordance behind a click.
4. **Diffusion Policy's `C.2` is printed before its parent `C`.** The tree nests
   it correctly and orders siblings by number, but the flat reading order still
   puts a child ahead of its parent.
5. **Only 4 real papers were audited.** Every structural claim here is measured on
   those four.
6. **The three-paper browser run scrolls a sampled band**, so a section whose
   content occupies less than the 90 px step can be skipped in the recorded
   sequence — the sequence is monotonic, not exhaustive.

## Recommended next task

**DS-QA-009 — Notes / Persistent Highlights.** The outline closes the "where am
I / where can I go" gap; what remains is that a reader cannot mark anything and
come back to it. It reuses the canonical paragraph identity, the citation jump
and the highlight geometry already validated here and in DS-QA-005, and it needs
no model call — the same shape of work that made this task tractable.

The one piece of evidence pointing elsewhere is limitation 2: a reading-order
defect that no test in this repository would have caught, found only because a new
feature made the order visible. A focused IR reading-order audit is worth a task
of its own, and it is a better candidate than multi-turn chat.
