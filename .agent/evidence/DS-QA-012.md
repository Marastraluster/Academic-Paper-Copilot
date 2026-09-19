# Evidence — DS-QA-012 Notes Search + Export

- **Date:** 2026-09-19
- **Commits:** `docs(acceptance)` (criteria), `feat(notes)` (implementation), this file
- **Acceptance criteria:** `docs/acceptance/DS-QA-012.md` — Gemini authored 27 P0,
  five P1, three P2 before any production code; **five `AC_CHANGE_REQUEST`s** were
  raised and resolved before the list was frozen.
- **Verdict:** **DOCUMENT NOTES SEARCH READY, GLOBAL SEARCH DEFERRED.**

## Search architecture, decided by measurement

`.agent/results/notes/fts_probe.py` (output: `fts_probe.txt`). SQLite 3.53.1,
with `fts5`, `unicode61` **and** `trigram` all available — and all three measured
rather than assumed:

| query | kind | unicode61 | trigram | casefolded `LIKE` |
|---|---|---|---|---|
| 残差 · 退化 · 网络 | CJK bigram | **no match** | **no match** | match |
| 退化问题 · 残差网络 | CJK 4-gram | **no match** | match | match |
| `ResNet-50` · `CIFAR-10` | identifier | **SQL error** | **SQL error** | match |
| `degradation` · `Algorithm 1` | English | match | match | match |

`unicode61` misses **every** Chinese query. `trigram` cannot match a
two-character query — the length a Chinese reader most often types. Both raise
`OperationalError: no such column: 50` on an ordinary model name, because FTS5
reads `-` as NOT and `50` as a column reference.

Plain normalised substring matching passed **all ten** cases, at 0.35 ms per
query over 1000 rows. No index, no migration, no query language to escape.

Two of my own probe expectations were wrong before they were right (`退化问题`
expected in a note that reads 而退化; `ResNet 退化` is two terms to FTS and one
substring to `LIKE`). Both are recorded in the file, because a probe that silently
agrees with itself measures nothing.

## Where each half lives, and why

- **Search is client-side.** Annotations are already loaded at registration, so a
  keystroke needs no round trip. Measured in the browser over **500 notes**:
  **0.1–0.3 ms** per filter, against a frozen 5.0 ms.
- **Export is server-side.** `AnnotationView` deliberately carries no
  `source_anchor_id`; an archive whose purpose is to survive a re-extraction has
  to keep it, so it is generated where the anchor lives.

## Two defects found by running

1. **Every target was collapsed to the annotation's worst state.** The mixed
   annotation (first paragraph placed exactly, second gone) exported `ORPHANED`
   against *both* targets — claiming the first was uncertain when it was not, and
   making the archive unusable for the import it exists to enable. Per-target
   states now export, with the annotation's worst alongside.
2. **Escaping corrupted the reader's text.** `_escape_inline` escaped every `>`,
   turning `<script>alert(1)</script>` into `<script\>alert(1)</script\>`. The
   criteria forbid rewriting user content to make a file safe; the escaping is now
   position-aware — only line-leading markers can restructure a document.

Plus two harness bugs of mine: `Performance` measured React re-rendering 500 rows
as if it were the filter (fixed by timing the filter where it runs), and the drag
selector mismatched a regex that was being passed as a string.

## Measured

```
backend                    986 passed   (959 + 27)
frontend                   243 passed   (201 + 42)
typecheck                  PASS
build                      exit 0
bundle                     335.32 kB of 350 kB
search browser E2E         30/30       (incl. 500-note scale, downloaded bytes)
QA browser                 48/48
notes browser              17/17
cross-page browser         23/23
outline browser            26/26
historical anchor replay   WRONG 0
provider calls             0
source PDF                 byte-identical
```

Browser-verified directly: filtering 500 notes at 0.1–0.3 ms; the Markdown file's
*suggested filename* is the backend's sanitised one (`fixture-notes.md`); the
downloaded Markdown holds 500 sections, the source quote and the note kept apart;
the downloaded JSON parses with `schema_version "1"`, 500 annotations, anchors,
rects and quotes, and no `p_` ordinal anywhere; both exports answer with the IR
deleted and **leave it deleted**; exporting writes nothing; a paper with no notes
disables the links and says why.

## Known limitations

1. **Global (all-documents) search is deferred.** There is no library screen to
   put it on, and Decision A scoped P0 to the current document. What exists is
   current-document filtering.
2. **The tokenizer probe is cited but not committed.** It lives under
   `.agent/results/`, which this repository gitignores; the measured table is in
   the criteria document, and the script regenerates it.
3. **The instrumented `performance.measure` in `NotesPanel` is production code
   added for a measurement.** It is two marks per keystroke and it is the only way
   to observe the frozen quantity in a real browser rather than in jsdom.

## Next task

**DS-QA-013 — Non-prose Annotation.** DS-DOC-003 measured 14 caption and 4
formula blocks sitting 0 inside any paragraph: content a reader can see and
mark, which the anchor domain cannot currently hold. The alternative is
**Paper Overview / Reading Entry**, which is a product-shape question rather
than a measured gap.
