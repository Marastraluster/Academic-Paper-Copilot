# DS-QA-014 — Acceptance Criteria authoring task (Gemini)

You are the independent Acceptance Criteria author for the Academic PDF Copilot
repository at `D:\marti\SciPrograms`. DeepSeek owns all production code. **You do
not write production code.** Your only deliverable is one document.

## Your deliverable

Write:

    D:\marti\SciPrograms\docs\acceptance\DS-QA-014.md

P0 MUST / P1 SHOULD / P2 OPTIONAL criteria, each numbered, each independently
verifiable, each stating its evidence. Follow `docs/acceptance/DS-QA-013.md`.

## Time budget — read before you start

Hard 25-minute wall clock. **Do not run the test suites, the build, `pytest` or
`vitest`.** A previous round was lost to an agent that spent its budget launching
suites and returned no document. Read source, decide, write.

## The task

**DS-QA-014 · Paper Overview / Reading Entry.** When a reader opens a paper they
have not read, give them a useful entry point: what problem it solves, the main
idea, the contributions, how the method is organised, what was evaluated, what
should be read first, and which terms matter — **without forcing them to ask a
chat question**.

It must complement Outline, Paper QA and Notes, not replace them.

**Opening a paper must cause 0 provider calls.** Two layers:

    LAYER A — instant, deterministic, no model, available as soon as the
              canonical document data exists
    LAYER B — AI overview, available from a compatible cached analysis, or
              generated only when the reader explicitly asks

## MEASURED — what the repository already has

**The IR already carries Layer A.** Verified on the real ResNet extraction:
`metadata.title` = "Deep Residual Learning for Image Recognition"; two
paragraphs with `is_abstract = True` holding the Abstract text; `sections` with
titles, levels and page ranges (`Abstract`, `1. Introduction`, `2. Related Work`,
`3. Deep Residual Learning`, `3.1. Residual Learning`, …). The application
already fetches this IR at registration, so an instant entry needs no new
extraction and no new backend route.

**`DocumentAnalysis` already exists and is rich.** A real cached analysis for the
same paper (`status: PARTIAL`, provider `deepseek-flash`, `target_language:
zh-CN`) holds:

- `summary` — a document-level summary
- `sections` — **7** `SectionAnalysis` records, each with `section_id`, `title`,
  `summary`, `page_range` and a `synthetic` flag
- `glossary` — **207** entries, each with `source_term`, `suggested_translation`,
  `definition`, an `is_translatable` flag and `paragraph_ids`
- `acronyms` — 29, `entities` — 56
- `domain` — a `DomainRecord` with a `confidence`

**The frontend has no analysis client at all.** There is no `api/analysis.ts`
and nothing in `frontend/src` calls `POST /documents/{id}/analysis`. Document
Analysis has never been shown in any UI. So the 0-provider-calls promise holds
today **structurally**, and Layer B is not "surface a thing the UI already
shows" — it is new UI over an existing, populated backend capability.

**Cache identity is already complete.** `AnalysisProvenance` carries
`content_hash`, `pipeline_version`, `prompt_version`, `ir_pipeline_version`,
`provider_base_url`, `provider_model`, `provider_protocol` and
`target_language`. `get_or_create_analysis` returns `(analysis, cached)`.

**Routes already exist:** `POST /documents/{id}/analysis` (analyse or return the
valid cached one), `GET` (read the cached one), `DELETE`.

**Historical result you must weigh.** DocumentAnalysis was measured **not** to
improve contextual translation enough to be worth its cost, and is therefore not
on by default. The task's own framing: that does not make it useless, and a
reading-entry product is a different use case from translation context.

## What the measurement says the existing analysis can and cannot carry

The task's Phase 5 lists a candidate shape — Research Question, Core Idea, Main
Contributions, Method at a Glance, Experimental Setup, Main Findings, Limitations,
Key Terms — and Phase 3 says to prefer composing existing outputs over writing a
new prompt.

Measured against the real analysis, what exists maps as:

| candidate section | available today from |
|---|---|
| Core Idea / Research Question | `summary` |
| Method at a Glance | `sections[]` summaries |
| Experiments / Findings | `sections[]` summaries |
| Key Terms | `glossary` + `acronyms` |
| **Contributions** | **nothing dedicated** |
| **Limitations** | **nothing dedicated** |

Grounding available: a `SectionAnalysis` carries a `page_range`; a
`GlossaryEntry` carries `paragraph_ids`. A `summary` carries neither — it is
prose about the whole paper with no per-claim evidence.

**Your central decision is what the Overview is made of.** Composing existing
outputs is cheap, cached, and cannot hallucinate a claim the analysis did not
already make — but it cannot produce Contributions or Limitations as labelled
sections, and its section grouping comes from the paper's own headings rather
than from a product taxonomy. A dedicated prompt could produce the candidate
shape, at the cost of a second generation path and of claims the existing
analysis never made. Decide, and say what the evidence is.

## Decisions you must make explicitly

- **A.** The exact **instant** (Layer A) content. The task says: paper title,
  Abstract, section outline, structural metadata already available locally, and
  that an absent Abstract is *stated as unavailable*, never fabricated.
- **B.** The exact **AI Overview** (Layer B) content, given what the analysis can
  actually support.
- **C.** Does Overview get its own sidebar tab, become the default reader entry,
  or something else? The sidebar is `AssistantSidebar` at `SIDEBAR_WIDTH_PX = 340`
  with tabs `目录 | 问答 | 笔记`. The task says to avoid a fourth permanently
  visible sidebar.
- **D.** Is AI generation explicit/on-demand only? (The task's Phase 16 says yes
  and Phase 32 requires a regression that opening a paper and visiting every tab
  leaves provider calls at 0.)
- **E.** Language behaviour. The cached analysis returned an **English** `summary`
  with `target_language: zh-CN` — so decide what the reader sees for a Chinese
  UI, and how identifiers like `ResNet`, `Diffusion Policy`, `CIFAR-10` survive.
- **F.** Grounding requirements: what must a generated claim be resolvable to,
  given a `SectionAnalysis` has only a page range and a `summary` has nothing?
- **G.** Citation requirements and whether Overview evidence is clickable.
- **H.** Behaviour with an incomplete (`PARTIAL`) analysis, and with none.
- **I.** Cached-analysis behaviour: what "compatible" means and what happens when
  the provenance no longer matches.
- **J.** Provider failure, and the three failure kinds the task distinguishes:
  provider/network, insufficient document structure, cancelled/stale.
- **K.** Progress reporting that is honest — the task's Phase 16 forbids fake
  progress bars.
- **L.** Source navigation and "start reading" actions, which must come from the
  canonical outline and must not hardcode section names. **Note what the real
  outline contains:** the section titles are `Abstract`, `1. Introduction`,
  `2. Related Work`, `3. Deep Residual Learning`, `3.1. Residual Learning`, … —
  there is no section called "Method" or "Experiments".
- **M.** Original / Translation / Bilingual interaction. Source geometry must
  never be drawn on the translated pane.
- **N.** The no-document state and the document-switch state.
- **O.** Stale-analysis races: generate for paper A, switch to B.
- **P.** Responsive layout and accessibility.
- **Q.** Bundle ceiling: **~12.5 kB** (337.51 kB of 350 kB). No chart library, no
  Markdown framework.
- **R.** Provider-call accounting: what counts, and where it is observed.
- **S.** Whether the Overview may use **Notes** as evidence. (The task's Phase 19
  says no: the Overview describes the paper, not what the reader wrote about it.)
- **T.** Whether the Overview may reuse DocumentAnalysis's existing prompt
  version or needs its own versioned generation.

Also decide and state:

- **U.** What happens when the analysis exists but its `sections` are `synthetic`
  partitions rather than real sections.
- **V.** Whether Overview content is cached, and whether a *new* prompt version
  invalidates a cached analysis for Overview purposes.

## Acceptance criteria must cover at least these 30 areas

1 zero AI calls on paper open, 2 deterministic instant content, 3 Abstract
fidelity, 4 section structure, 5 cached analysis reuse, 6 explicit Generate
Overview action, 7 provider failure, 8 progress, 9 cancellation/document switch,
10 stale response isolation, 11 grounding, 12 clickable source references,
13 unsupported claims, 14 missing evidence, 15 glossary, 16 key terminology,
17 contribution claims, 18 experiments, 19 limitations, 20 language, 21 cost,
22 latency, 23 privacy, 24 Notes isolation, 25 QA isolation, 26 no semantic
retrieval, 27 no vector DB, 28 source immutability, 29 browser E2E,
30 real-paper semantic audit.

Out-of-scope areas must be named as **explicit non-goals**.

## Rules

- Every P0 criterion must be **observable**. "The Overview is useful" is not one.
  "Opening the paper and visiting every sidebar tab produces 0 provider calls" is.
- State the **evidence** for each P0: which command, which browser observation,
  which test file.
- The real-paper semantic audit must classify claims **SUPPORTED /
  PARTIALLY_SUPPORTED / UNSUPPORTED** and record what is missing. The task
  forbids collapsing it into one subjective score, and forbids accepting an
  Overview because it "sounds good".
- Do not invent criticism. If a paper has no Limitations section, the Overview
  must not speculate about flaws.
- Do not fabricate structure. If there is no Abstract, say so.
- Notes are **not** paper evidence. Name the test that keeps them out.
- Do not add dense retrieval, a vector database, or a new QA path.
- Do not modify Notes architecture.

Write the document now. Return, as your final message, only the list of P0
criteria ids with one line each.
