# DS-QA-012 — Acceptance Criteria authoring task (Gemini)

You are the independent Acceptance Criteria author for the Academic PDF Copilot
repository at `D:\marti\SciPrograms`. DeepSeek owns all production code. **You do
not write production code.** Your only deliverable is one document.

## Your deliverable

Write the file:

    D:\marti\SciPrograms\docs\acceptance\DS-QA-012.md

P0 MUST / P1 SHOULD / P2 OPTIONAL criteria, each numbered, each independently
verifiable by a command or a browser observation, each stating its evidence.
Follow the structure of `docs/acceptance/DS-QA-011.md` — read it first.

## Time budget — read this before you start

Hard 25-minute wall clock. **Do not run the test suites. Do not run `npm run
build`. Do not run `pytest` or `vitest`.** A previous round was lost entirely to
an agent that spent its budget launching suites and returned no document. Read
source files, decide, write the document.

## The task

**Task ID:** DS-QA-012 · **Task name:** Notes Search + Export

Make persistent user annotations easy to find and portable **without** involving
Paper QA, retrieval over source-paper evidence, or any AI provider.

    Search:  Notes → type a term → local search of user annotations
             → matching notes/highlights → click → jump to the source location
    Export:  Notes → Export → deterministic portable file
             preserving note + source quote + provenance; source PDF unchanged

## MEASURED — the search architecture is already decided by data, not preference

**SQLite 3.53.1, `fts5`, `unicode61` and `trigram` are all available.** I measured
all three against the task's own corpus before choosing. Exact results, the ones
that matter:

| query | kind | unicode61 | trigram | casefolded `LIKE` |
|---|---|---|---|---|
| 残差 | Chinese bigram | **no match** | **no match** | match |
| 退化 | Chinese bigram | **no match** | **no match** | match |
| 网络 | Chinese bigram | **no match** | **no match** | match |
| 退化问题 | Chinese 4-gram | **no match** | match | match |
| 残差网络 | Chinese 4-gram | **no match** | match | match |
| degradation | English | match | match | match |
| `ResNet-50` | identifier | **SQL error: no such column: 50** | **same SQL error** | match |
| `CIFAR-10` | identifier | **SQL error: no such column: 10** | **same SQL error** | match |
| `Algorithm 1` | identifier | match | match | match |

`unicode61` misses **every** Chinese query: it does not tokenise CJK into
searchable substrings. `trigram` fixes the 4-character case but **cannot match a
2-character query**, which is the most common length a Chinese reader types.
Both raise a raw `sqlite3.OperationalError` on `ResNet-50` — FTS5 query syntax
reads `-` as NOT and `50` as a column reference, so a user typing an ordinary
model name gets a database error rather than a result.

**Plain normalized substring matching passed all ten cases.** Cost, in-memory,
20 iterations each after warm-up:

```
    10 rows   LIKE  0.006 ms/query
   100 rows   LIKE  0.038 ms/query
   500 rows   LIKE  0.186 ms/query
  1000 rows   LIKE  0.351 ms/query
```

The whole record is `.agent/results/notes/fts_probe.txt`.

There is **one** case where the two semantics genuinely differ and it is recorded
rather than smoothed over: the mixed query `ResNet 退化` is two *terms* to FTS and
one *substring* to `LIKE`. No note contains that literal substring, so `LIKE`
correctly returns nothing while FTS ANDs the terms. `LIKE` gives up cross-term
AND; FTS gives up Chinese entirely.

**Do not require an FTS index.** The task's Phase 63 says to prefer avoiding index
complexity, and the measurement says the simple thing is also the correct thing.
If you disagree, say what evidence would justify an index.

## MEASURED — where the data lives

- Annotations are **already fully loaded in the browser** when a document is
  registered (`loadAnnotations()` runs at registration, keyed by content hash).
  A keystroke therefore needs no round trip.
- `GET /documents/{id}/annotations` **does not extract the document** — it hashes
  the source file. This is DS-QA-010-FIX-001's fix and it is load-bearing: an
  earlier version took 14 seconds to list notes on a real paper.
- **`AnnotationView` deliberately carries no `source_anchor_id`.** The backend's
  `summary()` omits it: *"No anchor hash reaches the client — a user has no use
  for one and it is not their data."* So a machine-readable export that must
  preserve stable anchors **cannot be produced from the client's copy** and has
  to come from the server, where the anchors live.
- `AnnotationStore.list_for_content(content_hash, include_deleted=False)` already
  excludes soft-deleted rows.
- A cross-page annotation (DS-QA-011) is **one annotation with N ordered
  targets**, all under one `content_hash`.
- Resolution states present in the data: `EXACT`, `REATTACHED`, `AMBIGUOUS`,
  `ORPHANED`, and client-side `UNRESOLVED` (the document has not been read yet).

## Existing conventions to follow, not replace

- Downloads: `frontend/src/translation/ExportMenu.tsx` uses plain anchor
  downloads (`apiUrl(path)`, `download={...}`) — *"the browser then streams the
  file straight to disk, so there is no object URL to own or revoke."* It has a
  `data-testid` trigger, closes on outside-click and Escape, and disables itself
  with a reason rather than hiding.
- File responses: `backend/app/api/documents.py` uses `FileResponse(path,
  media_type=..., filename=...)`. Generated content would use the equivalent
  in-memory response.
- The Notes panel is `frontend/src/notes/NotesPanel.tsx`: a create block, then a
  `<ul data-testid="notes-list">` sorted by **source order** (page, then top
  coordinate), each row `li[data-testid^="note-"]`.

## Decisions you must make explicitly

Answer every one in the document, as a criterion or as an explicit non-goal.

- **A.** Is P0 search **current document only**, or current + global? (The task's
  own strong hypothesis is current-document P0, global P1 unless the UI already
  has a global surface. It does not — there is no library screen.)
- **B.** Which fields are searchable — user note text, source quote, both? Does
  document title, section title or page number participate?
- **C.** Is a highlight with no note text searchable through its source quote?
- **D.** What local search mechanism, given the measurements above?
- **E.** Does SQLite FTS5 tokenisation give acceptable Chinese behaviour? (Answer
  from the table, not from documentation.)
- **F.** Is deterministic Unicode substring search preferred?
- **G.** Should ranking exist at all, or is source-order filtering sufficient?
- **H.** Do results preserve document reading order or rank by relevance?
- **I.** Markdown content: document title, source quote, user note, page range,
  section, timestamps, resolution status — which are required?
- **J.** Is JSON a stable machine-readable archival/interchange format?
- **K.** Should JSON carry `source_anchor_id`, `anchor_version`, source rects,
  quote and context, so a future import could reconstruct the annotation?
- **L.** Should the runtime `paragraph_id` (`p_<doc>_<ordinal>`) be excluded from
  exported canonical identity? (The task's strong hypothesis is yes. Note
  `summary()` already sends it as `resolved_paragraph_id`, which is a *runtime*
  id — DS-DOC-002 measured 145 of 160 paragraphs being renumbered by one constant.)
- **M.** Should `AMBIGUOUS` / `ORPHANED` annotations export? (Strong hypothesis:
  yes — they are user data, and an orphaned note may be the one that matters most.)
- **N.** Should soft-deleted annotations export? (Strong hypothesis: no.)
- **O.** Is export current-document only for P0, all-documents for P1?
- **P.** Does colour/style metadata export?
- **Q.** Does P0 require **import**? (Strong hypothesis: no — the task's Phase 47
  lists conflict resolution, document matching, anchor migration, duplicate
  detection and security as a separate future task.)

Also decide and state:

- **R.** Where the **search** runs — frontend over the loaded list, or a new
  backend endpoint — and why, given that the data is already client-side.
- **S.** Where **export** is generated, given that the anchors are not on the
  client.
- **T.** The refusal/empty states: what the reader sees for *no notes at all* vs
  *no matches for this query*, and whether Export is disabled or produces a valid
  empty file when there are no annotations.
- **U.** Whether the search query survives a document switch.
- **V.** The export filename, and how it is sanitised.
- **W.** What happens to export when the document has **no IR** — both the
  contract and the observable.

## Acceptance criteria must cover at least these 60 areas

1 current-document search, 2 query clearing, 3 empty query, 4 no-result state,
5 note text, 6 source quote, 7 highlight-only annotation, 8 Chinese query,
9 English query, 10 mixed Chinese/English, 11 case handling, 12 punctuation,
13 whitespace, 14 soft-deleted records, 15 EXACT, 16 REATTACHED, 17 AMBIGUOUS,
18 ORPHANED, 19 multi-target annotation, 20 cross-page annotation,
21 result ordering, 22 result click, 23 source navigation, 24 current-document
isolation, 25 possible global search, 26 search performance, 27 zero AI calls,
28 no Paper QA contamination, 29 Markdown export, 30 JSON export,
31 export schema/version, 32 note content, 33 source quote, 34 document metadata,
35 page/page-range metadata, 36 section metadata, 37 stable source anchor,
38 anchor version, 39 rect inclusion, 40 user privacy, 41 unresolved annotation
export, 42 soft-deleted exclusion, 43 deterministic ordering, 44 filename,
45 Unicode, 46 escaping, 47 Markdown injection, 48 JSON validity,
49 source immutability, 50 browser download, 51 database unchanged by export,
52 responsive Notes UI, 53 keyboard accessibility, 54 backend regression,
55 frontend regression, 56 bundle ceiling, 57 no new AI path, 58 no retrieval
redesign, 59 no annotation persistence redesign, 60 no import.

Where an area is out of scope, say so as an **explicit non-goal** rather than
omitting it.

## Rules

- Every P0 criterion must be **observable**. "Search works" is not a criterion.
  "Searching 退化 returns exactly the annotation whose note contains it, and
  searching 退化问题 returns the same one" is.
- State the **evidence** for each P0: which command, which browser observation,
  which test.
- Do not invent performance thresholds without saying why that number.
- Budget headroom is **~18 kB** (331.84 kB of a 350 kB ceiling). No search
  library, no Markdown parser, no file-generation framework.
- Notes are **not** paper evidence. They must never enter `search.db`, the QA FTS
  index, an `EvidenceItem`, query rewriting, or answer generation. Name the test
  that proves it.
- Do not add import, cloud sync, PDF writeback, PDF/DOCX export, or any provider
  call.

Write the document now. Return, as your final message, only the list of P0
criteria ids with one line each.
