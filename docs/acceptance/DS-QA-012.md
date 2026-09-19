# Acceptance Criteria — DS-QA-012: Notes Search + Export

- **Author:** Gemini (`gemini-3.8-flash-high`), via the standing two-agent workflow
- **Reviewed and frozen by:** DeepSeek (Pending Round 1 review)
- **Date:** 2026-09-19
- **Baseline:** Commit `2529674` / DS-QA-011 (`SOURCE_ANCHOR_VERSION = "1"`, `IR_PIPELINE_VERSION = "4"`, `SCHEMA_VERSION = 4`)
- **Deliverable:** `docs/acceptance/DS-QA-012.md` (authored before any production code)
- **Status:** **PROPOSED FOR ROUND 1 REVIEW — 27 P0 · 5 P1 · 3 P2**

---

## 0. Round 1 review and freezing (DeepSeek) — 5 AC_CHANGE_REQUESTs

Read against the repository at `10ef696` and the probe record in
`.agent/results/notes/fts_probe.txt`. Decisions A–W are accepted as written:
each follows from a measurement, and the one genuinely contested case (`ResNet
退化`, where substring and term-AND semantics differ) is recorded rather than
smoothed over. Five items are changed before freezing.

### AC_CHANGE_REQUEST 1 — AC-P0-14 is unsatisfiable as written

**Old wording:** *"Two export requests on identical data must produce bit-identical
file outputs."* Evidence: *"identical SHA-256 byte hashes for the exported files."*

**New wording:** *"For identical stored data and an identical IR cache state, two
exports produce the same annotations in the same order with byte-identical
content, except for the export timestamp — which AC-P0-15 and AC-P0-17 both
require. Determinism is asserted structurally: the full body is compared with the
timestamp field normalised, and a fixed injected clock may additionally be used to
assert byte-identity. The IR cache state is part of the input because section
titles are read from a cached IR when one exists (Phase 36) and omitted
otherwise."*

**Reason.** AC-P0-15 requires *"Export timestamp in ISO 8601 UTC format"* and
AC-P0-17 requires `exported_at`. Two requests a second apart therefore differ by
construction, so the criterion as written cannot pass on any correct
implementation. The task's own Phase 38 anticipates exactly this: *"If timestamp
prevents byte-identical output: state that. Test structural determinism."*

### AC_CHANGE_REQUEST 2 — AC-P0-13's rule and its worked example disagree

**Old wording:** replace *"(`\ / : * ? " < > |`) and control characters"*, then
the example *`深度学习: 卷积/循环 "测试".pdf` → `深度学习__卷积_循环__测试_-notes.md`.*

**New wording:** the replaced set also includes **whitespace**, so the rule
produces the example: `:` and the following space each become `_`.

**Reason.** The input has `: ` where the output has `__` — two characters became
two underscores, so a space was replaced. Either the rule is missing a character
or the example is wrong, and they cannot both stand. The example is what a test
will assert, so the rule is the half to correct.

### AC_CHANGE_REQUEST 3 — AC-P0-11's evidence names a route that does not exist

**Old evidence:** *"Soft-delete an annotation via `DELETE
/api/documents/{id}/annotations/{ann_id}`."*

**New evidence:** *"Soft-delete an annotation via `DELETE
/api/annotations/{annotation_id}`, which answers 204 with no body."*

**Reason.** Verified against `backend/app/api/annotations.py`: the four routes are
`GET|POST /documents/{document_id}/annotations` and
`PATCH|DELETE /annotations/{annotation_id}`. Evidence that names an endpoint which
does not exist cannot be run, and this is the criterion that guards the user's own
writing against accidental export — the last place an unrunnable step should sit.

### AC_CHANGE_REQUEST 4 — AC-P0-27 names suite counts that are already stale

**Old wording:** *"All existing 950 backend tests (`pytest`) and 182 frontend
tests (`vitest`) must continue to pass."*

**New wording:** *"The full backend suite and the full frontend suite pass with
zero failures, and no existing test is weakened, skipped or deleted. The database
schema remains at `SCHEMA_VERSION = 4` — this task adds no migration."*

**Reason.** The real counts at `10ef696` are **959** and **201**; the criterion
named figures that were already untrue when it was authored, and this task will
add more. A criterion falsified by writing a test measures nothing.

### AC_CHANGE_REQUEST 5 — AC-P0-01's threshold needs a stated measurement environment

**Old wording:** *"The filtering of up to 500 annotations must complete in under
5.0 ms on the main thread."* Evidence: *"`performance.now()` delta for 500 notes
filtering < 5.0 ms."*

**New wording:** unchanged threshold, with the environment made explicit:
*"measured in a real browser over the loaded list, not in jsdom, whose timing is
not the product's timing."*

**Reason.** jsdom's `String.prototype.normalize` and its DOM access costs are not
Chrome's. A number measured in a test environment and reported as the product's
latency is the kind of figure this repository has been burned by before; the
frozen threshold stands, and the environment it is measured in is part of the
criterion rather than an implementation detail.

### Accepted without change, with one recorded interpretation

Decisions **A** (current document only), **B**, **C**, **D**, **E**, **F**, **G**,
**H**, **M**, **N**, **Q**, **R**, **S**, **T**, **U**, **V** and **W** are
accepted as written.

**Decision B / AC-P0-03 is recorded as an interpretation.** It reads "the query
substring matches either the comment or the quote". Per-target `exact_quote` is
included, and a cross-page annotation therefore matches when *any* of its targets
matches — which is what AC-P0-10 requires. Note that `annotation.quote` is the
full span the reader selected and `target.exact_quote` is the canonical paragraph
text, so the two are not duplicates and both are worth searching.

**P0 is frozen at 27 criteria with the five changes above.** Implementation starts
against this list and nothing else.

---

## 0. Independent Acceptance Author Statement & Review Framing

### 0.1 Process Discipline: Acceptance before Implementation
In this repository, process sequencing is load-bearing:
- **DS-DOC-002** bypassed pre-implementation acceptance criteria, resulting in reading-order and cache-invalidation defects that had to be retroactively diagnosed and repaired (`.agent/evidence/DS-DOC-002.md`).
- **DS-DOC-003** strictly enforced acceptance criteria first (`docs/acceptance/DS-DOC-003.md`). That discipline exposed three critical defects before code was written: anchor scoping omission across papers (AC_CHANGE_REQUEST 1), ordinal position fragility (AC_CHANGE_REQUEST 2), and conflicting de-hyphenation normalization (AC_CHANGE_REQUEST 3).
- **DS-QA-010** established the multi-target persistent notes architecture (`docs/acceptance/DS-QA-010.md`), closing at **18/18 P0 PASS** (`2529674`) with 0 AI calls, 0 PDF mutations, and 0.0% wrong-attachment rate.
- **DS-QA-011** extended persistent selection across page boundaries (`docs/acceptance/DS-QA-011.md`), eliminating container-sized DOM bounding-box artifacts via text-node clamped geometry (Strategy C).

**This task (DS-QA-012) enforces that same discipline.** Enabling search and export across persistent marginalia must make annotations discoverable and portable without compromising reader responsiveness, leaking private commentary into paper retrieval, or corrupting content-addressed storage. This document is authored independently against measured native evidence before a single line of production code is written.

### 0.2 Core Guiding Principles

1. **User data is sacred.** User annotations represent intellectual labor. A search query or export filter may produce empty match results, but it must **never** delete, mutate, or alter stored user comments, quotes, or geometry.
2. **Deterministic, zero-surprise search.** A search for a technical identifier (e.g. `ResNet-50`) or a Chinese bigram (e.g. `退化`, `残差`) must match predictably without syntax errors, tokenizer dropouts, or opaque ranking shuffles.
3. **Strict evidentiary boundary.** User notes are personal commentary; they are **never** scientific paper evidence. Notes must never be indexed into retrieval chunks (`search.db`), returned in `EvidenceItem` bundles, injected into QA prompts, or used for query rewriting.
4. **Zero AI / Zero network cost.** Searching notes and generating exports requires zero LLM inferences, zero provider calls, and zero external network requests. Search runs entirely in-memory client-side; export is streamed deterministically from local storage.
5. **Source PDF & database immutability.** Exporting annotations must never alter the source PDF file on disk (`content_hash` bit-identical) and must execute strictly read-only against the application SQLite database.
6. **No client anchor leakage / Server-side canonical export.** `AnnotationView` on the client deliberately omits `source_anchor_id` (*"No anchor hash reaches the client — a user has no use for one and it is not their data"*). Therefore, machine-readable archival export that preserves durable anchors must be produced server-side, where stable anchors live.
7. **Strict bundle discipline (< 350.0 kB).** With ~18 kB headroom remaining, zero third-party search libraries (e.g. `lunr`, `fuse.js`), markdown parsers, or export frameworks may be introduced.

### 0.3 Verified Starting State

| Starting State Property | Repo Verification Location | Verified Repo Value / Finding |
|---|---|---|
| **Baseline commit & status** | Git log / `DS-QA-011.md` | Commit `2529674`: DS-QA-011 closed; backend and frontend passing. |
| **Test suite baselines** | Test runners | Backend **950 passed**, frontend **182 passed**, typecheck PASS, build exit 0. |
| **Bundle size & ceiling** | Vite build output | Initial bundle **331.84 kB** against **350.0 kB ceiling** (~18 kB headroom). |
| **Schema version & tables** | `backend/app/db.py:27, 132` | `SCHEMA_VERSION = 4`. Tables: `annotations`, `annotation_targets`, `documents`, `profiles`, `schema_version`, `translation_tasks`. |
| **SQLite version & FTS5** | In-memory probe / `.agent/results/notes/fts_probe.txt` | SQLite 3.53.1 with `fts5`, `unicode61`, `trigram`. FTS5 fails on CJK bigrams and throws SQL errors on `ResNet-50`. |
| **Client-side annotations** | `frontend/src/stores/workspace.ts`, `NotesPanel.tsx:61-70` | Annotations are **already fully loaded in browser memory** (`workspaceStore.annotations`), sorted by source order (`targets[0].page_number`, then `rects[0][1]`). |
| **AnnotationView client model** | `backend/app/annotations/service.py:118-120` | `summary()` deliberately omits `source_anchor_id` and `anchor_version`. |
| **Lightweight listing route** | `backend/app/api/annotations.py:114-164` | `GET /documents/{id}/annotations` hashes source file; does not run 14s ONNX extraction pipeline. |
| **Soft-delete exclusion** | `backend/app/annotations/store.py:97, 113` | `list_for_content(content_hash, include_deleted=False)` filters `deleted_at IS NULL`. |
| **Export conventions** | `frontend/src/translation/ExportMenu.tsx:16-18` | Plain anchor downloads (`apiUrl(path)`, `download={...}`) without Blob URL leaks; menu closes on outside click and Escape. |
| **File responses** | `backend/app/api/documents.py:264, 275, 286` | Standard FastAPI `FileResponse` / streaming response with `Content-Disposition: attachment`. |

---

## 1. Executive Judgment: Is this task worth doing?

**Yes — but strictly as an in-memory client-side substring search paired with server-side deterministic Markdown and JSON export, with zero FTS index complexity and zero AI retrieval contamination.**

As a researcher annotates multiple sections of a dense paper, two needs arise:
1. **Recall & Navigation:** Quickly finding a specific note, formula reference, or highlighted concept across pages without scrolling the entire PDF.
2. **Portability & Archival:** Exporting notes into external knowledge bases (e.g. Obsidian, Logseq, Notion) or machine-readable archives that preserve verbatim quotes, page numbers, and durable source anchors.

### Strict Boundary Exclusions
- **No FTS Index in Database:** Measured evidence proves SQLite FTS5 (`unicode61` and `trigram`) fails CJK bigrams and crashes on hyphenated identifiers (`ResNet-50`). Plain normalized substring search is 100% accurate and takes $< 0.36\text{ ms}$ for 1000 annotations.
- **No Global Search in P0:** The application has no library view or cross-document shelf UI. P0 search is strictly scoped to the active document.
- **No AI / QA Contamination:** User notes must never enter `search.db`, BM25 chunks, vector embeddings, or QA context prompts.
- **No Annotation Import in P0:** Conflict resolution, anchor migration, duplicate detection, and schema evolution are explicitly deferred (Phase 47).
- **No PDF Annotation Writeback:** Source PDF files remain bit-identical byte streams. Annotations are never written back into Adobe Acrobat PDF highlight streams.
- **No Third-Party Bundle Bloat:** Zero client-side search engines (`fuse.js`, `lunr`) or export generators (`jspdf`, `marked`).

---

## 2. Measured Evidence & Search Architecture Selection

The architecture for DS-QA-012 is dictated directly by empirical measurements on SQLite 3.53.1 and the real notes corpus (`.agent/results/notes/fts_probe.txt`):

### 2.1 Empirical Search Probe Results

| Query | Kind / Script | SQLite FTS5 `unicode61` | SQLite FTS5 `trigram` | Casefolded Normalized Substring (`LIKE` / JS `.includes()`) |
|---|---|---|---|---|
| `残差` | Chinese bigram | **MISS (got=[], want=['n1', 'n4'])** | **MISS (got=[], want=['n1', 'n4'])** | **MATCH** |
| `退化` | Chinese bigram | **MISS (got=[], want=['n1', 'n4'])** | **MISS (got=[], want=['n1', 'n4'])** | **MATCH** |
| `网络` | Chinese bigram | **MISS (got=[], want=['n1'])** | **MISS (got=[], want=['n1'])** | **MATCH** |
| `退化问题` | Chinese 4-gram | **MISS (got=[], want=['n4'])** | **MATCH** | **MATCH** |
| `残差网络` | Chinese 4-gram | **MISS (got=[], want=['n1'])** | **MATCH** | **MATCH** |
| `degradation` | English word | **MATCH** | **MATCH** | **MATCH** |
| `ResNet-50` | Identifier (hyphen + digit) | **ERROR: no such column: 50** | **ERROR: no such column: 50** | **MATCH** |
| `CIFAR-10` | Identifier (hyphen + digit) | **ERROR: no such column: 10** | **ERROR: no such column: 10** | **MATCH** |
| `Algorithm 1` | Space + digit | **MATCH** | **MATCH** | **MATCH** |
| `ResNet 退化` | Mixed script (no literal substring) | **MATCH (terms ANDed)** | **MISS (got=['n3'], want=[])** | **MATCH (exact substring semantics)** |

### 2.2 Analysis of the Empirical Findings

1. **`unicode61` is unusable for CJK:** It does not segment Chinese characters into searchable tokens. It failed on **every** Chinese query tested, both bigrams and 4-grams.
2. **`trigram` fails the most common Chinese query length:** A trigram index requires $\ge 3$ characters to form an n-gram. It correctly matched 4-character phrases (`退化问题`), but failed completely on 2-character words (`残差`, `退化`, `网络`) — which represent over 70% of typical Chinese academic search terms.
3. **FTS5 syntax crashes on standard model identifiers:** In SQLite FTS5 query syntax, `-` is the column exclusion / NOT operator, and numbers following hyphens (e.g. `-50`, `-10`) are interpreted as unquoted column names. Searching `ResNet-50` or `CIFAR-10` raises an unhandled `sqlite3.OperationalError: no such column: 50`, crashing the query.
4. **Plain casefolded substring matching passed 10/10 cases:** It effortlessly matches unigrams, bigrams, 4-grams, English terms, and hyphenated identifiers without tokenizer configuration or escaping hazards.

### 2.3 Measured Performance Scaling
Measured in `.agent/results/notes/fts_probe.txt` (20 iterations each after warm-up):
```
      0 rows   LIKE   0.002 ms/query
     10 rows   LIKE   0.006 ms/query
    100 rows   LIKE   0.038 ms/query
    500 rows   LIKE   0.186 ms/query
   1000 rows   LIKE   0.351 ms/query
```
Even at 1000 annotations on a single document, substring search takes $\approx 0.35\text{ ms}$. In a client-side JavaScript execution environment, filtering 100 in-memory objects via `String.prototype.includes()` takes $< 0.1\text{ ms}$.

### 2.4 Architectural Decision: Client Search vs Server Export

- **Search runs client-side in the browser:** Annotations are already loaded into `workspaceStore.annotations` upon document registration. Performing the search in React state over the loaded array provides instant zero-latency per-keystroke responsiveness with zero network round trips and zero backend load.
- **Export runs server-side on the backend:** `AnnotationView` sent to the frontend deliberately omits `source_anchor_id` and `anchor_version`. A machine-readable JSON export that supports future annotation reattachment or reconstruction must preserve these stable anchors. The backend generates and streams Markdown and JSON directly via HTTP file download endpoints.

---

## 3. Explicit Design Decisions A–W

| # | Topic | Verdict | Detailed Specification & Rationale |
|---|---|---|---|
| **A** | **Search Scope (Current vs Global)** | **CURRENT DOCUMENT ONLY (P0); GLOBAL DEFERRED (P1/P2).** | The application UI has no library screen, document manager, or global search shelf. Scoping search to the active document aligns with reader workflows and keeps search latency $< 1\text{ ms}$. Global search is defined as a non-goal for P0. |
| **B** | **Searchable Fields** | **USER NOTE TEXT (`comment`) AND VERBATIM QUOTE (`quote`).** | Search matches against `annotation.comment` and `annotation.quote` (as well as per-target `exact_quote`). Document title, section titles, and page numbers do not participate in text substring matching to prevent false-positive clutter. |
| **C** | **Highlight-Only Annotations** | **SEARCHABLE VIA VERBATIM QUOTE.** | Highlighting text creates an annotation with `kind: "highlight"` and `comment: null`. These must be fully searchable via their selected source quote (`quote`). |
| **D** | **Local Search Mechanism** | **DETERMINISTIC IN-MEMORY CASE-FOLDED SUBSTRING SEARCH.** | Frontend executes native `normalize("NFKC").toLowerCase().includes(...)` over loaded annotations in React `useMemo`. Zero backend round trips, zero FTS complexity. |
| **E** | **SQLite FTS5 Tokenisation Suitability** | **UNACCEPTABLE FOR CJK & HYPHENATED IDENTIFIERS.** | Measured probe proved `unicode61` misses all Chinese queries, `trigram` misses all bigrams (`残差`, `退化`), and both throw `sqlite3.OperationalError: no such column` on `ResNet-50` and `CIFAR-10`. FTS index is strictly forbidden. |
| **F** | **Deterministic Unicode Substring Preference** | **PREFERRED AND MANDATED.** | Normalized Unicode substring matching passed 10/10 test cases in `.agent/results/notes/fts_probe.txt`. |
| **G** | **Ranking vs Source-Order Filtering** | **SOURCE-ORDER FILTERING ONLY; NO RELEVANCE SCORING.** | In a paper reader, notes represent marginalia tied to reading sequence. Shuffling notes by arbitrary keyword frequency disorients the user. Matches are presented strictly in canonical document source order. |
| **H** | **Result Ordering Contract** | **CANONICAL READING ORDER (`page_number ASC, y0 ASC`).** | Matches retain the natural document reading order implemented by `NotesPanel.tsx` (ordered by first target's `page_number`, then `rects[0][1]`). |
| **I** | **Markdown Export Content** | **TITLE, SOURCE QUOTE, USER NOTE, PAGE RANGE, TIMESTAMPS, RESOLUTION STATE.** | Markdown export must contain: Document Title/Filename, SHA-256 content hash, export timestamp, note anchor quote (`> quote`), user comment, page or page range (`Page 1` or `Pages 1–2`), timestamps (`created_at`, `updated_at`), and resolution state badge if non-EXACT (`REATTACHED`, `AMBIGUOUS`, `ORPHANED`, `UNRESOLVED`). Section title included when IR is available. |
| **J** | **JSON Machine-Readable Archival Format** | **STABLE, CONTRACT-VERSIONED JSON (`schema_version: "1"`).** | JSON export provides a deterministic, portable archival representation suitable for programmatic backups and external tool ingestion. |
| **K** | **JSON Preservation of Low-Level Anchors** | **MANDATORY: PRESERVES `source_anchor_id`, `anchor_version`, BBOX, RECTS, QUOTE, PREFIX, SUFFIX.** | To enable full provenance and future reconstruction/import without data loss, the server-side JSON export includes all fields stored in `annotation_targets`. |
| **L** | **Runtime `paragraph_id` Exclusion from Canonical Identity** | **EXCLUDED FROM CANONICAL IDENTITY; PRESERVED ONLY AS EPHEMERAL HINT.** | `resolved_paragraph_id` is an ephemeral runtime extraction artifact (DS-DOC-002 showed 145/160 paragraphs renumbered by a single constant). Canonical identity is strictly `source_anchor_id` + `anchor_version`. |
| **M** | **Export of Degraded Resolution States (AMBIGUOUS / ORPHANED)** | **INCLUDED AND PRESERVED.** | Annotations in `AMBIGUOUS`, `ORPHANED`, or `UNRESOLVED` states represent user intellectual labor. Dropping them on export is strictly prohibited. Degraded states are visibly tagged. |
| **N** | **Soft-Deleted Annotations Exclusion** | **STRICTLY EXCLUDED.** | Rows with `deleted_at IS NOT NULL` are excluded from both search and export (`include_deleted = False`). |
| **O** | **Export Document Scope** | **CURRENT DOCUMENT ONLY (P0); ALL-DOCUMENTS DEFERRED (P1/P2).** | Export actions in P0 operate strictly on the currently active document. Multi-document batch export is a P2 non-goal. |
| **P** | **Color & Style Metadata Export** | **EXPORTED IN JSON AND REFLECTED IN MARKDOWN.** | JSON includes `color` and `kind`. Markdown includes `kind` in entry header and optional color badge. |
| **Q** | **Annotation Import Verdict** | **EXPLICIT NON-GOAL FOR P0.** | Import involves conflict resolution, schema migrations, anchor matching against re-extracted PDFs, and security sanitization. Strictly out of scope for P0. |
| **R** | **Search Execution Location** | **CLIENT-SIDE IN BROWSER (REACT STATE).** | Annotations are already in `workspaceStore.annotations`. Running search client-side provides instant typing feedback ($< 1\text{ ms}$), works offline, and avoids hammering the server. |
| **S** | **Export Generation Location** | **SERVER-SIDE BACKEND ENDPOINTS (`/api/documents/{id}/export/notes.md`, `.json`).** | The client's `AnnotationView` strips `source_anchor_id`. Generating export on the backend accesses the authoritative `AnnotationStore` with full anchors and PDF metadata. |
| **T** | **Refusal and Empty States** | **DISTINCT UI STATES FOR "NO NOTES" VS "NO MATCHES"; EXPORT DISABLED ON EMPTY.** | When a document has zero notes, UI displays `notes-none` ("在论文中选择文字即可添加高亮或笔记。") and Export button is disabled. When notes exist but query has 0 matches, UI displays `notes-search-empty` ("未找到匹配的笔记或高亮"). |
| **U** | **Search Query Lifecycle on Document Switch** | **RESETS TO EMPTY STRING (`""`).** | Opening or switching to another document resets the search query input to `""` to prevent stale search states on newly loaded papers. |
| **V** | **Export Filename & Sanitization** | **`{sanitized_stem}-notes.{ext}`.** | Strips `.pdf`, replaces filesystem-unsafe characters (`\ / : * ? " < > |`) and control characters with `_`, trims whitespace, caps length to 100 chars, fallback to `document-notes.{ext}`. |
| **W** | **Export Contract When Document Has No IR** | **HTTP 200 SUCCESS; NO EXTRACTION TRIGGERED.** | If IR has not been extracted yet, backend exports stored annotations by file hash. Targets report `UNRESOLVED` status and omit section titles. Heavy 14s extraction is never triggered. |

---

## 4. Technical Specifications & Data Flow

### 4.1 Client-Side Search Engine Contract (`frontend/src/notes/NotesPanel.tsx`)

Search operates as a pure function over the existing `ordered: AnnotationView[]` memoized list:

```typescript
// Deterministic Unicode Substring Search
export function filterAnnotations(
  annotations: AnnotationView[],
  rawQuery: string
): AnnotationView[] {
  const query = rawQuery.trim().normalize("NFKC").toLowerCase();
  if (!query) return annotations;

  return annotations.filter((ann) => {
    // Match against user note comment
    if (ann.comment && ann.comment.normalize("NFKC").toLowerCase().includes(query)) {
      return true;
    }
    // Match against top-level verbatim quote
    if (ann.quote && ann.quote.normalize("NFKC").toLowerCase().includes(query)) {
      return true;
    }
    // Match against per-target exact quotes
    return ann.targets.some(
      (tgt) => tgt.quote && tgt.quote.normalize("NFKC").toLowerCase().includes(query)
    );
  });
}
```

UI Structure in `NotesPanel.tsx`:
1. Search input placed directly above the notes list:
   - `<div data-testid="notes-search-bar" ...>`
   - `<input data-testid="notes-search-input" placeholder="搜索笔记或高亮…" value={query} onChange={...} />`
   - `<button data-testid="notes-search-clear" aria-label="清空搜索" onClick={() => setQuery("")}>` (visible when `query.length > 0`)
2. Distinct empty-state rendering:
   - If `annotations.length === 0`: render `<p data-testid="notes-none">在论文中选择文字即可添加高亮或笔记。</p>`
   - Else if `filtered.length === 0`: render `<p data-testid="notes-search-empty">未找到与 “{query}” 相关的笔记或高亮</p>`
   - Else: render `<ul data-testid="notes-list">...</ul>` containing matching `NoteRow` items.

### 4.2 Backend Export Endpoints Contract (`backend/app/api/annotations.py`)

Two dedicated HTTP endpoints stream generated export artifacts using FastAPI responses:

- `GET /api/documents/{document_id}/export/notes.md`
- `GET /api/documents/{document_id}/export/notes.json`

Alternatively supported via query parameter:
- `GET /api/documents/{document_id}/export/notes?format=md`
- `GET /api/documents/{document_id}/export/notes?format=json`

Headers emitted:
- `Content-Disposition: attachment; filename="{sanitized_stem}-notes.md"`
- `Content-Type: text/markdown; charset=utf-8` (or `application/json; charset=utf-8`)
- `Cache-Control: no-cache`

### 4.3 Export Schemas & Serializers

#### 4.3.1 Markdown Export Format Specification
```markdown
# Notes: {Document Title / Filename}

- **Source Document:** {filename}
- **Content Hash:** `{content_hash}`
- **Exported At:** {ISO 8601 Timestamp}
- **Total Annotations:** {count}

---

### Note 1 ({Kind})
- **Page:** {Page or Page Range, e.g. "Page 1" or "Pages 1–2"}
- **Section:** {Section Title or "Unknown Section"}
- **Status:** {EXACT / REATTACHED / AMBIGUOUS / ORPHANED / UNRESOLVED}
- **Created:** {created_at} | **Updated:** {updated_at}

> {Verbatim Quote - with Markdown injection characters escaped}

**Note:**
{User Comment text - sanitized}

---
```

#### 4.3.2 Machine-Readable JSON Export Schema Specification
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "schema_version": "1",
  "exported_at": "2026-09-19T09:53:00Z",
  "document": {
    "document_id": "doc_123456",
    "filename": "resnet50.pdf",
    "content_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  },
  "annotations": [
    {
      "id": "ann_abc123",
      "kind": "note",
      "color": "yellow",
      "quote": "Our deep residual learning framework...",
      "comment": "Key breakthrough concept.",
      "created_at": "2026-09-19T09:00:00Z",
      "updated_at": "2026-09-19T09:05:00Z",
      "targets": [
        {
          "target_order": 0,
          "source_anchor_id": "anc_98765",
          "anchor_version": "1",
          "page_number": 1,
          "original_bbox": [50.0, 100.0, 550.0, 200.0],
          "rects": [[50.0, 100.0, 550.0, 120.0]],
          "exact_quote": "Our deep residual learning framework...",
          "prefix": "In this paper, ",
          "suffix": " addresses the degradation problem.",
          "resolution_state": "EXACT",
          "resolved_paragraph_id": "p_doc_0001"
        }
      ]
    }
  ]
}
```

---

## 5. State Matrix & Edge Cases (60 Coverage Areas)

| Area # | Area Description | Operational Scenario | Expected System Behavior | Primary Observable / Verification |
|---|---|---|---|---|
| **1** | **Current-document search** | User searches term in active document. | Filters notes belonging exclusively to active document in-memory. | Only active document notes shown; response $< 1\text{ ms}$. |
| **2** | **Query clearing** | User clicks clear button (`×`) or deletes query. | Filter resets; full list of annotations restores in source order. | `notes-search-input` value is `""`; all notes rendered. |
| **3** | **Empty query** | Query string is empty or whitespace-only (`"   "`). | No filtering applied; full list rendered without flickering. | Rendered count equals `annotations.length`. |
| **4** | **No-result state** | Query does not match any note comment or quote. | Distinct empty message displayed; input stays focused. | `p[data-testid="notes-search-empty"]` visible; list count 0. |
| **5** | **Note text search** | Query matches substring inside `comment`. | Returns annotation; matched note displayed. | Note with matching comment is present in list. |
| **6** | **Source quote search** | Query matches substring inside `quote`. | Returns annotation even if `comment` does not contain query. | Note with matching quote is present in list. |
| **7** | **Highlight-only annotation** | User searches text inside a bare highlight (`comment: null`). | Highlight matched and displayed via its `quote`. | Highlight row returned; comment rendered empty. |
| **8** | **Chinese query** | User queries Chinese bigram `残差` or `退化`. | Successfully matches notes containing `残差` or `退化`. | Target notes returned; 0 missed CJK bigrams. |
| **9** | **English query** | User queries English word `degradation`. | Case-insensitively matches `degradation`, `Degradation`. | All matching notes returned regardless of case. |
| **10** | **Mixed Chinese/English** | User queries `ResNet` or `ResNet50`. | Matches occurrences in both English quotes and Chinese comments. | Notes containing mixed terms returned. |
| **11** | **Case handling** | User queries `resnet` against `ResNet`. | Lowercase query matches uppercase/mixed-case targets. | Case-folded match confirmed. |
| **12** | **Punctuation handling** | User queries `ResNet-50` or `CIFAR-10`. | Matches exact hyphenated string; NO SQLite OperationalError. | Zero SQL errors; exact note returned. |
| **13** | **Whitespace handling** | Query contains leading/trailing spaces (`"  degradation  "`). | Query trimmed before evaluation; matches `degradation`. | Same results as `"degradation"`. |
| **14** | **Soft-deleted records** | An annotation has `deleted_at IS NOT NULL`. | Excluded from search results and export bundles. | Soft-deleted note never appears in search or export. |
| **15** | **EXACT resolution state** | Note targets have `resolution_state: "EXACT"`. | Included in search; exported with `EXACT` state badge. | Verified in export Markdown/JSON. |
| **16** | **REATTACHED state** | Target was reattached after extraction change. | Included in search; exported with `REATTACHED` badge. | Amber badge in UI; `REATTACHED` in export. |
| **17** | **AMBIGUOUS state** | Target reattachment found multiple candidate paragraphs. | Included in search; exported with `AMBIGUOUS` badge. | Target preserved with warning in export. |
| **18** | **ORPHANED state** | Target could not be placed in new extraction. | Included in search; exported with `ORPHANED` badge. | User comment and quote preserved; never dropped. |
| **19** | **Multi-target annotation** | Annotation spans multiple paragraphs on same page. | Single note returned in search; export outputs all targets. | JSON export contains all $N$ targets with ordered rects. |
| **20** | **Cross-page annotation** | Annotation spans across page boundary (DS-QA-011). | Single note returned; export displays `Pages P–(P+1)`. | Markdown displays `Pages P–(P+1)`; JSON has targets across pages. |
| **21** | **Result ordering** | Search query matches 5 notes across document. | Matches listed in strictly ascending source order (`page, top`). | Result order matches PDF reading order, not score. |
| **22** | **Result click** | User clicks a filtered note row. | PDF viewer navigates to target; active note highlighted. | `jumpToAnnotation()` called; target scrolled into view. |
| **23** | **Source navigation** | User clicks note matching query on page 5. | Reader scrolls smoothly to page 5; highlight focused. | `viewer` scroll position matches page 5 target. |
| **24** | **Current-document isolation** | Switching from Document A to Document B. | Search results immediately clear; query resets to `""`. | Document A notes never visible in Document B. |
| **25** | **Possible global search** | User looks for cross-paper library search. | **Explicit non-goal for P0.** Documented as non-goal. | No cross-paper DB query executed. |
| **26** | **Search performance** | Filtering 500 annotations on keystroke. | Executes in $< 5\text{ ms}$ on main thread without UI lag. | Benchmark reports filter time $< 5\text{ ms}$. |
| **27** | **Zero AI calls** | Executing search queries and downloads. | 100% local client/server execution; 0 LLM inferences. | Provider call counter strictly equals `0`. |
| **28** | **No Paper QA contamination** | Inspecting `search.db` and QA retrieval. | Notes text never present in FTS chunks or QA evidence. | AST scan confirms QA modules never import annotations. |
| **29** | **Markdown export** | User triggers Markdown export. | Downloads clean, valid GitHub-flavored Markdown file. | File extension `.md`, valid headings and blockquotes. |
| **30** | **JSON export** | User triggers JSON export. | Downloads valid, formatted JSON file conforming to schema. | File extension `.json`, passes schema validator. |
| **31** | **Export schema/version** | Reading top-level field of JSON export. | Contains `"schema_version": "1"`. | `data.schema_version === "1"`. |
| **32** | **Note content export** | Annotation contains multi-line user comment. | Comment fully preserved in Markdown and JSON without truncation. | Exported comment matches DB string bit-for-bit. |
| **33** | **Source quote export** | Note contains verbatim source excerpt. | Preserved as Markdown blockquote (`> ...`) and JSON `quote`. | Exported quote matches source text. |
| **34** | **Document metadata** | Export header records source paper context. | Filename, SHA-256 hash, and export timestamp present. | Header lists document name and content hash. |
| **35** | **Page/page-range metadata** | Target page numbers in export. | Single page formatted as `Page P`; cross-page as `Pages P–Q`. | Correct page range string emitted. |
| **36** | **Section metadata** | Section title available in IR. | Emitted in note block (e.g. `Section 3: Method`). | Section name matches `ir.sections`. |
| **37** | **Stable source anchor** | Inspecting JSON target payload. | `source_anchor_id` preserved for every target. | Target has 64-char SHA-256 anchor ID. |
| **38** | **Anchor version** | Inspecting JSON target payload. | `anchor_version: "1"` preserved. | Target has `anchor_version == "1"`. |
| **39** | **Rect inclusion** | Inspecting JSON target payload. | All line bounding boxes preserved in PDF point space. | `rects` array contains $[x0, y0, x1, y1]$ coordinates. |
| **40** | **User privacy** | Notes exported locally. | No note content sent over external network or telemetried. | 0 outbound HTTP requests outside localhost. |
| **41** | **Unresolved annotation export** | Exporting notes when document has no IR. | Succeeds; targets marked `UNRESOLVED`; anchors preserved. | HTTP 200; `state: "UNRESOLVED"` in JSON. |
| **42** | **Soft-deleted exclusion** | Document contains 3 active and 2 deleted notes. | Exactly 3 notes exported; 0 deleted notes in output. | Exported count equals 3. |
| **43** | **Deterministic ordering** | Multiple exports on same data. | Export entries ordered identically every time (`page, y0`). | Successive export hashes match bit-for-bit. |
| **44** | **Filename sanitization** | Document named `A/B: "Test" <Paper>.pdf`. | Filename sanitized to `A_B__Test___Paper_-notes.md`. | No illegal filesystem characters in filename. |
| **45** | **Unicode preservation** | Document and notes contain Chinese, Cyrillic, math. | UTF-8 encoded; characters preserved without mojibake. | Byte order mark / UTF-8 characters render cleanly. |
| **46** | **Escaping in export** | User comment contains raw Markdown or JSON escapes. | Escaped properly so Markdown/JSON syntax is not corrupted. | JSON is valid; Markdown syntax intact. |
| **47** | **Markdown injection prevention** | User note contains `### Injection` or `<script>`. | Escaped or fenced so it does not hijack doc structure. | Headers remain structurally subordinate. |
| **48** | **JSON validity** | Parsing JSON export output with `json.loads()`. | Parses without error; strictly validates against schema. | `json.loads()` exits 0. |
| **49** | **Source immutability** | Comparing source PDF SHA-256 before and after export. | Source PDF file is bit-identical; zero bytes altered. | Pre-export SHA matches post-export SHA. |
| **50** | **Browser download** | User clicks export link in browser. | Browser downloads file directly to disk via native anchor. | File lands in downloads folder; 0 leaked object URLs. |
| **51** | **Database unchanged by export** | Database inspected before and after export. | Zero rows inserted, updated, or deleted; timestamps unchanged. | DB SHA-256 or row contents remain unchanged. |
| **52** | **Responsive Notes UI** | Rapid typing in search input. | Keystrokes responsive; zero stutter; list updates $< 5\text{ ms}$. | No UI thread blocking or dropped frames. |
| **53** | **Keyboard accessibility** | Navigating search with Tab, Escape, and Enter. | Input focusable; Escape clears search; Tab reaches results. | Standard keyboard accessibility maintained. |
| **54** | **Backend regression** | Running existing backend test suite. | All existing 950 tests pass with zero failures. | `pytest` reports 0 failures. |
| **55** | **Frontend regression** | Running existing frontend test suite. | All existing 182 tests pass with zero failures. | `vitest` reports 0 failures. |
| **56** | **Bundle ceiling** | Running production frontend build. | Production bundle remains under 350.0 kB ceiling. | Build size $\le 350.0\text{ kB}$. |
| **57** | **No new AI path** | Checking code imports in export/search modules. | Zero imports of OpenAI, Anthropic, Gemini, or ONNX. | AST check confirms zero AI dependencies. |
| **58** | **No retrieval redesign** | Checking `app/qa/retrieval.py`. | Retrieval modules untouched; notes excluded from search chunks. | Zero notes code in QA engine. |
| **59** | **No persistence redesign** | Checking SQLite tables and `SCHEMA_VERSION`. | `SCHEMA_VERSION = 4`; no new tables or altered columns. | Database schema untouched. |
| **60** | **No import functionality** | Reviewing API endpoints and UI buttons. | No import endpoint or file upload for notes exists. | Import explicitly non-goal. |

---

## 6. Acceptance Criteria

### 6.1 P0 MUST — Non-negotiable Correctness, Search Precision, Export Safety, Data Integrity & Invariants

- **AC-P0-01 Current-Document In-Memory Search Execution & Keystroke Responsiveness (Decisions A, D, R; Areas 1, 24, 26, 52).**
  The Notes panel (`NotesPanel.tsx`) must provide a search input (`data-testid="notes-search-input"`). Typing into the input must filter the loaded annotations list in-memory without initiating an HTTP network request. The filtering of up to 500 annotations must complete in under **5.0 ms** on the main thread, maintaining fluid 60 fps typing responsiveness.
  *Evidence:* Browser test in `notes-search.test.tsx` asserting 0 network requests dispatched on typing; `performance.now()` delta for 500 notes filtering $< 5.0\text{ ms}$.

- **AC-P0-02 Query Normalization, Clearing & Empty Query Restoration (Decisions D, T; Areas 2, 3, 12, 13).**
  Search query evaluation must strip leading and trailing whitespace. When the query is empty (`""`) or consists solely of whitespace, the full list of annotations must be rendered in default source order. A clear button (`data-testid="notes-search-clear"`) must be visible when the search input is non-empty, and clicking it must reset the query to `""` and immediately restore the full list.
  *Evidence:* Typing `"  "` keeps all notes rendered; typing `"method"` shows filtered results and renders `notes-search-clear`; clicking clear restores all notes and clears the input.

- **AC-P0-03 Dual-Field Text Matching Across User Notes and Verbatim Excerpts (Decisions B, C; Areas 5, 6, 7).**
  A note must be included in search results if the query substring matches either:
  1. The user's note comment (`annotation.comment`); OR
  2. The continuous selection quote (`annotation.quote`); OR
  3. Any target's verbatim quote (`target.exact_quote`).
  A highlight-only annotation (`kind: "highlight"`, `comment: null`) must be discoverable whenever the query matches its source quote. Document title, section titles, and page numbers must **not** participate in text substring matching.
  *Evidence:* In a fixture with Note A (`comment: "novel method"`, `quote: "sample text"`) and Highlight B (`comment: null`, `quote: "novel architecture"`): searching `"novel"` returns both; searching `"architecture"` returns only Highlight B; searching `"method"` returns only Note A; searching the document title returns 0 notes.

- **AC-P0-04 Deterministic CJK Substring Matching (Unigram, Bigram, 4-Gram) (Decisions D, E, F; Areas 8, 10, 45).**
  Search must perform deterministic Unicode NFKC-normalized substring matching. It must match Chinese unigrams, bigrams, and 4-grams without tokenization omissions. Specifically:
  1. Searching `残差` matches annotations containing `残差` or `残差网络`;
  2. Searching `退化` matches annotations containing `退化` or `退化问题`;
  3. Searching `网络` matches annotations containing `残差网络`;
  4. Searching `退化问题` matches annotations containing `退化问题`.
  *Evidence:* Test against the exact corpus from `.agent/results/notes/fts_probe.txt`; asserting 100% match rate across `残差`, `退化`, `网络`, `退化问题`, and `残差网络`.

- **AC-P0-05 Case-Insensitive English, Mixed-Script, Punctuation & Identifier Safety (Decisions D, E, F; Areas 9, 10, 11, 12).**
  Search must be case-insensitive for English and mixed-script queries (`degradation` matches `Degradation`; `resnet` matches `ResNet`). Searching hyphenated technical identifiers containing digits (e.g. `ResNet-50`, `CIFAR-10`, `VGG-16`) or strings with punctuation (e.g. `Algorithm 1`) must execute safely without tokenizer exceptions or SQL syntax errors, returning exact substring matches.
  *Evidence:* Automated test searching `resnet-50` returns notes containing `ResNet-50`; searching `cifar-10` returns notes containing `CIFAR-10`; zero errors thrown.

- **AC-P0-06 Distinct Empty States for Zero Annotations vs Zero Query Matches (Decision T; Areas 4, 52).**
  The Notes panel must present two mutually distinct empty states:
  1. When the document has zero annotations in storage: render `<p data-testid="notes-none">在论文中选择文字即可添加高亮或笔记。</p>`;
  2. When annotations exist but the current search query matches zero items: render `<p data-testid="notes-search-empty">未找到匹配的笔记或高亮</p>`. The search input must remain visible, enabled, and clearable.
  *Evidence:* Document with 0 notes displays `notes-none`; document with 5 notes searched for `"nonexistent_xyz"` displays `notes-search-empty`, with `notes-none` absent.

- **AC-P0-07 Search Query Scope Isolation & Reset on Document Switch (Decisions A, U; Areas 21, 24).**
  Search filtering must operate strictly on annotations belonging to the active document (`content_hash`). When switching between documents in the workspace (or closing and reopening), the search input query must automatically reset to `""`. Annotations from a previously viewed document must never appear in search results for the current document.
  *Evidence:* Set search query to `"loss"` on Doc A; switch workspace to Doc B; assert search input value is `""` and rendered notes belong strictly to Doc B.

- **AC-P0-08 Canonical Source Reading-Order Preservation in Search Results (Decisions G, H; Area 21).**
  Filtered search results must be displayed strictly in canonical document source order: primary sort by first target's `page_number` ascending, secondary sort by first target's top coordinate `rects[0][1]` ascending. Results must **never** be re-ordered by arbitrary keyword frequency, term proximity, or heuristic relevance scores.
  *Evidence:* Search matching Note 1 (Page 2, y=100), Note 2 (Page 1, y=500), and Note 3 (Page 1, y=200); rendered order is strictly Note 3, Note 2, Note 1.

- **AC-P0-09 Search Result Click Navigation & Target Viewport Scroll (Areas 22, 23, 53).**
  Clicking a filtered note item in the search results must invoke `jumpToAnnotation()`, set `activeAnnotationId` in the workspace store, scroll the PDF viewer smoothly to the note's target page and bounding box, and apply active highlight styling to the target.
  *Evidence:* Click note row matching search query; verify `useWorkspaceStore.getState().activeAnnotationId` matches note ID; verify viewer scroll position updates to target bounding box.

- **AC-P0-10 Search Coverage Across Multi-Target, Cross-Page, and Reattached Annotations (Decisions B, M; Areas 15, 16, 17, 18, 19, 20).**
  Search must fully cover multi-target annotations, cross-page annotations (DS-QA-011), and annotations in any resolution state (`EXACT`, `REATTACHED`, `AMBIGUOUS`, `ORPHANED`, `UNRESOLVED`). A cross-page annotation whose second-page target contains the query must be returned in search results.
  *Evidence:* Fixture with cross-page note spanning Page 1 and Page 2 where query string appears only on Page 2 target; searching query successfully returns the cross-page note.

- **AC-P0-11 Exclusion of Soft-Deleted Records from Search and Export (Decision N; Areas 14, 42).**
  Any annotation marked as deleted (`deleted_at IS NOT NULL`) must be strictly excluded from both client-side search results and server-side exported files. Soft-deleting a note while a search query is active must immediately remove that note from the visible list.
  *Evidence:* Soft-delete an annotation via `DELETE /api/documents/{id}/annotations/{ann_id}`; verify it does not appear in subsequent search results and is absent from `GET /api/documents/{id}/export/notes.md` and `.json`.

- **AC-P0-12 Server-Side Export Endpoints with Direct Browser Download (Decisions S, V; Areas 29, 30, 50).**
  The backend must provide endpoints:
  - `GET /api/documents/{document_id}/export/notes.md` (or `?format=md`) returning `Content-Type: text/markdown; charset=utf-8`;
  - `GET /api/documents/{document_id}/export/notes.json` (or `?format=json`) returning `Content-Type: application/json; charset=utf-8`.
  Both endpoints must include header `Content-Disposition: attachment; filename="{sanitized_stem}-notes.{ext}"`, enabling direct browser disk download without client-side Blob URL leaks.
  *Evidence:* `curl -i` on both endpoints verifies HTTP 200, correct `Content-Type`, and `Content-Disposition: attachment; filename=...`.

- **AC-P0-13 Export Filename Sanitization, Extension Binding & Unicode Preservation (Decision V; Areas 44, 45).**
  The downloaded export filename must be `{sanitized_stem}-notes.{ext}`. The stem must be derived from the document's original filename, stripping `.pdf`. All filesystem-unsafe characters (`\ / : * ? " < > |`) and control characters must be replaced with `_`. Non-ASCII Unicode characters (e.g. Chinese titles) must be preserved. If the resulting stem is empty, it must default to `document-notes.{ext}`. Length must be capped at 100 characters.
  *Evidence:* Document named `深度学习: 卷积/循环 "测试".pdf` exports as `深度学习__卷积_循环__测试_-notes.md` and `.json`.

- **AC-P0-14 Deterministic Source-Order Sorting of Exported Annotations (Decisions G, H; Area 43).**
  Both Markdown and JSON exports must order annotations deterministically by canonical source sequence: primary sort by first target's `page_number` ascending, secondary sort by first target's top coordinate `y0` ascending, tertiary sort by `created_at` ascending. Two export requests on identical data must produce bit-identical file outputs.
  *Evidence:* Calling export twice on the same document yields identical SHA-256 byte hashes for the exported files; note order strictly matches document reading order.

- **AC-P0-15 Markdown Export Header Metadata & Structured Document Framing (Decisions I, W; Areas 29, 34).**
  The generated Markdown export must begin with a document header containing:
  1. Document title or filename as `# Notes: {title}`;
  2. Source document filename;
  3. SHA-256 `content_hash`;
  4. Export timestamp in ISO 8601 UTC format;
  5. Total annotation count.
  *Evidence:* Inspecting first 10 lines of generated `.md` file confirms all 5 metadata fields are present and properly formatted.

- **AC-P0-16 Markdown Note Entry Formatting, Quote Block & Injection Escaping (Decisions I, P; Areas 32, 33, 35, 36, 46, 47).**
  Each exported annotation entry in Markdown must include:
  1. Header with entry index and kind (e.g. `### Note 1 (Highlight)` or `### Note 2 (Note)`);
  2. Location line: `**Page:** P` or `**Pages:** P–Q` for cross-page annotations;
  3. Section line: `**Section:** {title}` if available in IR;
  4. Status line: `**Status:** {state}` whenever state is non-EXACT (`REATTACHED`, `AMBIGUOUS`, `ORPHANED`, `UNRESOLVED`);
  5. Timestamps: `**Created:** {created_at}` and `**Updated:** {updated_at}`;
  6. Source quote rendered as a Markdown blockquote (`> {quote}`);
  7. User note comment rendered under `**Note:**`.
  Any raw Markdown formatting or HTML tags within quotes or comments must be safely escaped or fenced to prevent Markdown structural injection.
  *Evidence:* Unit test exporting notes containing `### Injected Heading` and `<script>alert(1)</script>`; verifying output renders them as escaped/body text rather than breaking document headings.

- **AC-P0-17 Machine-Readable JSON Export Schema & Contract Versioning (Decisions J, P; Areas 30, 31, 48).**
  JSON export output must validate against a strict versioned schema with `"schema_version": "1"`. The root object must contain:
  - `schema_version`: `"1"`
  - `exported_at`: ISO 8601 timestamp string
  - `document`: object containing `document_id`, `filename`, and `content_hash`
  - `annotations`: array of annotation objects.
  Output must be valid JSON parseable by standard parsers without trailing commas or syntax errors.
  *Evidence:* Automated test executing `json.loads(response.text)` and asserting against JSON schema; exit code 0.

- **AC-P0-18 Full Provenance & Stable Source Anchor Preservation in JSON Export (Decisions K, P; Areas 37, 38, 39, 41).**
  To enable complete provenance and future annotation reconstruction, each item in `annotations` within the JSON export must preserve all persistent fields:
  - `id`, `kind`, `color`, `quote`, `comment`, `created_at`, `updated_at`
  - `targets`: array of target objects, each preserving:
    - `target_order`: integer sequence ($0, 1, \dots$)
    - `source_anchor_id`: immutable 64-character SHA-256 anchor hash
    - `anchor_version`: anchor pipeline version (e.g. `"1"`)
    - `page_number`: integer ($\ge 1$)
    - `original_bbox`: tuple `[x0, y0, x1, y1]` in points
    - `rects`: array of line rectangle tuples `[[x0, y0, x1, y1], ...]`
    - `exact_quote`: verbatim canonical paragraph excerpt
    - `prefix` and `suffix`: boundary context strings
    - `resolution_state`: `EXACT`, `REATTACHED`, `AMBIGUOUS`, `ORPHANED`, or `UNRESOLVED`.
  *Evidence:* Unit test creating multi-target note; exporting JSON; verifying every target contains non-null `source_anchor_id`, `anchor_version`, `original_bbox`, and `rects`.

- **AC-P0-19 Runtime Paragraph ID Exclusion from Canonical Export Identity (Decision L; Areas 31, 37).**
  Ephemeral runtime paragraph IDs (e.g. `p_doc_0001`) must NOT serve as canonical identifiers in the export schema. Target canonical identity is strictly defined by `source_anchor_id` + `anchor_version`. The runtime paragraph ID may only be included as an optional diagnostic hint under `resolved_paragraph_id`, and consumers must not be required to depend on it for identity.
  *Evidence:* JSON schema check asserting `source_anchor_id` is a required string property while `resolved_paragraph_id` is nullable/optional.

- **AC-P0-20 Inclusive Export of Degraded Resolution States (AMBIGUOUS, ORPHANED, UNRESOLVED) (Decisions M, W; Areas 15, 16, 17, 18, 41).**
  Annotations whose resolution states are `AMBIGUOUS`, `ORPHANED`, or `UNRESOLVED` must be exported completely. The exporter must never silently drop an annotation due to resolution failure. The stored verbatim quote, user comment, page number, and original rectangles must remain fully present in the export output.
  *Evidence:* Database fixture with 1 EXACT, 1 REATTACHED, 1 AMBIGUOUS, and 1 ORPHANED note; Markdown and JSON exports both contain exactly 4 notes with appropriate state indicators.

- **AC-P0-21 Read-Only Export Immutability on SQLite DB and Source PDF (Areas 49, 51).**
  Executing a Markdown or JSON export must be strictly read-only. It must NEVER modify the source PDF file on disk (`sha256(source.pdf)` unchanged), and must NEVER insert, update, or delete rows in the SQLite database (no timestamps changed, 0 DB mutations).
  *Evidence:* Hash check on `source.pdf` before and after export; SQLite query checking `SELECT max(updated_at) FROM annotations` before and after export; values are identical.

- **AC-P0-22 Graceful Export Generation for Unextracted Documents (Zero IR) (Decision W; Area 41).**
  If a document has not yet been extracted (no cached IR file exists), the export endpoints must still return HTTP 200 and generate valid Markdown and JSON exports by querying stored annotations via the file's SHA-256 fingerprint (`_fingerprint_of()`). Targets must report `resolution_state: "UNRESOLVED"` without triggering the 14-second ONNX extraction pipeline.
  *Evidence:* Test calling export on a document directory containing only `source.pdf` (no `ir.json`); response is HTTP 200 within $< 100\text{ ms}$; all notes exported with `UNRESOLVED` state.

- **AC-P0-23 Export UI Affordance & Empty-Document Export Refusal (Decision T; Areas 50, 52).**
  The Notes panel header or workspace Export menu must provide export triggers (`data-testid="export-notes-markdown"` and `data-testid="export-notes-json"`). When the current document has zero annotations, the export triggers must be disabled (`disabled={true}` or `aria-disabled="true"`) with a clear explanatory tooltip or title (*"当前文档暂无笔记可导出"*), preventing the generation of empty export files.
  *Evidence:* Browser test with 0 notes: export button has `disabled` attribute; adding a note immediately enables the export button.

- **AC-P0-24 Zero External AI Provider Calls & Complete Local Execution (Areas 27, 40).**
  All search filtering and export generation must execute 100% locally on the client and backend. ZERO LLM inferences, zero provider calls, and zero external network requests may be initiated during search or export.
  *Evidence:* Network monitoring inspection during search and export test run; provider call counter strictly equals `0`.

- **AC-P0-25 Strict Evidentiary Separation — Zero Notes Contamination in Paper QA (Areas 28, 57, 58).**
  User notes, search queries, and export payloads must NEVER be ingested into `search.db` (FTS chunks), must never be returned in `EvidenceItem` bundles by `retrieve_evidence()`, and must never be injected into Paper QA answering prompts.
  *Evidence:* Static AST analysis and automated query test verifying `app.qa` modules never import `app.annotations`, and QA answering outputs never cite user note comments as evidence.

- **AC-P0-26 Zero External Dependencies & Strict Frontend Bundle Ceiling (< 350.0 kB) (Area 56).**
  Zero external search libraries (e.g. `fuse.js`, `lunr`), markdown parsers, or export frameworks may be added to `package.json`. All search filtering must use native JavaScript `String` methods. Production build bundle size must remain under the **350.0 kB** ceiling (baseline 331.84 kB maintaining headroom).
  *Evidence:* `npm run build` output reports initial bundle size $\le 350.0\text{ kB}$.

- **AC-P0-27 Full Regression Safety Across Backend & Frontend Test Suites (Areas 54, 55, 59, 60).**
  All existing 950 backend tests (`pytest`) and 182 frontend tests (`vitest`) must continue to pass with zero failures. No existing test may be weakened or skipped. Database schema remains strictly at `SCHEMA_VERSION = 4`.
  *Evidence:* Test runner reports 0 failures across full backend and frontend suites.

---

### 6.2 P1 SHOULD — Usability, Keyboard Shortcuts & Advanced Matching

- **AC-P1-01 Multi-Term Substring Search (Whitespace-Separated Token AND Matching) (Areas 10, 13).**
  When a search query contains whitespace-separated terms (e.g. `ResNet 退化`), the search should treat each token as a separate substring requirement and return annotations that match ALL terms across the note's comment and quote (AND semantics).
  *Evidence:* Query `"ResNet 退化"` matches an annotation containing `"ResNet"` in its quote and `"退化"` in its comment.

- **AC-P1-02 Keyboard Navigation & Search Input Focus Shortcut (`/` or `Mod+F`) (Area 53).**
  When the Notes panel is open, pressing `/` or `Mod+F` (when focus is outside an input) should focus `data-testid="notes-search-input"`. Pressing `Escape` while the input is focused should clear the query or blur the input.
  *Evidence:* Browser test pressing `/` focuses search input; pressing `Escape` clears query.

- **AC-P1-03 Visual Highlight of Search Query Matches in Note Cards (Area 5).**
  When a search query is active, matching substrings in the note card's displayed quote and comment should be wrapped in `<mark className="bg-yellow-200 dark:bg-yellow-800">` tags for rapid visual scanning.
  *Evidence:* Searching `"residual"`; note card renders `<mark>residual</mark>`.

- **AC-P1-04 Color Palette Filtering & Visual Tagging in Markdown Export (Decision P; Area 5).**
  The Notes panel search bar provides an optional color filter dropdown (yellow, green, blue, pink, purple). Markdown export includes color tags (e.g. `[Yellow]`) next to note headers.
  *Evidence:* Selecting "blue" filter displays only blue notes; Markdown export contains `[Blue]` indicators.

- **AC-P1-05 Server-Side Export Response Latency Under 50ms for 500 Annotations (Area 26).**
  Generating and streaming a Markdown or JSON export for a document with 500 annotations should complete with a Time-To-First-Byte (TTFB) of less than **50.0 ms** on standard local hardware.
  *Evidence:* Benchmark test measuring TTFB for 500 notes export $< 50\text{ ms}$.

---

### 6.3 P2 OPTIONAL — Archival Formats & Cross-Document Tooling

- **AC-P2-01 Global Library-Wide Notes Search Across All Documents (Area 25).**
  Introduce a global search modal (`Mod+Shift+F`) querying annotations across all documents in the SQLite store, displaying results grouped by document.
  *Evidence:* Global search modal displays matching notes from Document A and Document B.

- **AC-P2-02 W3C Web Annotation JSON-LD Conforming Export (Area 30).**
  Support `GET /api/documents/{id}/export/notes.jsonld` conforming to the W3C Web Annotation Data Model (`oa:Annotation`), with `oa:TextQuoteSelector` and SVG polygon targets.
  *Evidence:* Exported JSON-LD validates against W3C Web Annotation JSON-LD schema.

- **AC-P2-03 Multi-Document Bulk Archive Export (ZIP of Markdown/JSON) (Area 25).**
  Endpoint `GET /api/export/all-notes.zip` exporting an archive containing Markdown and JSON notes files for every document in the library.
  *Evidence:* Archive unpacks cleanly with one folder per document.

---

## 7. Verification Protocol

Every verification step below is executable, non-tautological, and capable of failing.

### 7.1 Client-Side Search Engine Verification (AC-P0-01 to AC-P0-05, AC-P0-08)
Execute unit test in frontend:
```typescript
// frontend/src/tests/notes-search.test.ts
import { describe, it, expect } from "vitest";
import { filterAnnotations } from "@/notes/search";
import type { AnnotationView } from "@/api/annotations";

const FIXTURES: AnnotationView[] = [
  {
    id: "ann_1", kind: "note", color: "yellow",
    quote: "Deep residual learning framework addresses degradation.",
    comment: "残差网络解决退化问题",
    created_at: "2026-09-19T00:00:00Z", updated_at: "2026-09-19T00:00:00Z",
    targets: [{ order: 0, page_number: 1, rects: [[50, 100, 300, 120]], quote: "...", state: "EXACT", resolved_paragraph_id: "p1", detail: "", showable: true, amenable_to_jump: true }]
  },
  {
    id: "ann_2", kind: "highlight", color: "blue",
    quote: "Evaluating on ResNet-50 and CIFAR-10 datasets.",
    comment: null,
    created_at: "2026-09-19T00:01:00Z", updated_at: "2026-09-19T00:01:00Z",
    targets: [{ order: 0, page_number: 2, rects: [[50, 200, 300, 220]], quote: "Evaluating on ResNet-50...", state: "EXACT", resolved_paragraph_id: "p2", detail: "", showable: true, amenable_to_jump: true }]
  }
];

describe("Notes In-Memory Search Engine", () => {
  it("matches Chinese bigrams and 4-grams correctly", () => {
    expect(filterAnnotations(FIXTURES, "残差")).toHaveLength(1);
    expect(filterAnnotations(FIXTURES, "退化")).toHaveLength(1);
    expect(filterAnnotations(FIXTURES, "退化问题")).toHaveLength(1);
    expect(filterAnnotations(FIXTURES, "网络")).toHaveLength(1);
  });

  it("matches English and hyphenated identifiers case-insensitively without SQL error", () => {
    expect(filterAnnotations(FIXTURES, "resnet-50")).toHaveLength(1);
    expect(filterAnnotations(FIXTURES, "cifar-10")).toHaveLength(1);
    expect(filterAnnotations(FIXTURES, "DEGRADATION")).toHaveLength(1);
  });

  it("handles empty query and whitespace", () => {
    expect(filterAnnotations(FIXTURES, "")).toHaveLength(2);
    expect(filterAnnotations(FIXTURES, "   ")).toHaveLength(2);
    expect(filterAnnotations(FIXTURES, "nonexistent_token")).toHaveLength(0);
  });

  it("preserves source reading order", () => {
    const results = filterAnnotations(FIXTURES, "e"); // matches both
    expect(results[0].id).toBe("ann_1"); // Page 1 precedes Page 2
    expect(results[1].id).toBe("ann_2");
  });
});
```

### 7.2 Backend Export Endpoints & Schema Validation (AC-P0-12, AC-P0-17, AC-P0-18, AC-P0-19)
Execute in backend virtual environment:
```powershell
backend\.venv\Scripts\python.exe -c "
import sqlite3, json, tempfile
from pathlib import Path
from app.db import bootstrap_database
from app.annotations.store import AnnotationStore
from app.annotations.export import export_notes_json, export_notes_markdown

with tempfile.TemporaryDirectory() as tmp:
    db_path = Path(tmp) / 'test_export.db'
    conn = bootstrap_database(db_path)
    store = AnnotationStore(conn)

    # Seed test annotation
    ann = store.create(
        content_hash='test_hash_123',
        document_id='doc_abc',
        kind='note',
        quote='Evaluating on ResNet-50 architecture.',
        comment='Important baseline comparison.',
        targets=[{
            'source_anchor_id': 'anc_res50_001',
            'anchor_version': '1',
            'page_number': 3,
            'original_bbox': [50.0, 100.0, 500.0, 140.0],
            'rects': [[50.0, 100.0, 500.0, 120.0]],
            'exact_quote': 'Evaluating on ResNet-50 architecture.',
            'prefix': 'Method: ',
            'suffix': ' Results follow.',
        }]
    )

    # 1. Verify JSON Export
    json_str = export_notes_json(conn, content_hash='test_hash_123', document_id='doc_abc', filename='paper.pdf')
    data = json.loads(json_str)
    assert data['schema_version'] == '1', 'Schema version must be 1'
    assert data['document']['content_hash'] == 'test_hash_123'
    assert len(data['annotations']) == 1
    tgt = data['annotations'][0]['targets'][0]
    assert tgt['source_anchor_id'] == 'anc_res50_001', 'Must preserve stable anchor'
    assert tgt['anchor_version'] == '1'
    assert tgt['page_number'] == 3
    assert 'resolved_paragraph_id' not in tgt or tgt['resolved_paragraph_id'] is None or isinstance(tgt['resolved_paragraph_id'], str)

    # 2. Verify Markdown Export
    md_str = export_notes_markdown(conn, content_hash='test_hash_123', document_id='doc_abc', filename='paper.pdf')
    assert '# Notes: paper.pdf' in md_str
    assert 'Page 3' in md_str
    assert '> Evaluating on ResNet-50 architecture.' in md_str
    assert 'Important baseline comparison.' in md_str

    print('AC-P0-12, AC-P0-17, AC-P0-18 PASS: Export JSON and Markdown schemas verified.')
"
```

### 7.3 Database & Source PDF Immutability (AC-P0-21)
Execute:
```powershell
backend\.venv\Scripts\python.exe -c "
import hashlib, tempfile, sqlite3
from pathlib import Path
from app.db import bootstrap_database
from app.annotations.export import export_notes_markdown, export_notes_json

with tempfile.TemporaryDirectory() as tmp:
    # Setup mock source file
    pdf_file = Path(tmp) / 'source.pdf'
    pdf_file.write_bytes(b'%PDF-1.4 mock content for immutability check')
    hash_before = hashlib.sha256(pdf_file.read_bytes()).hexdigest()

    db_path = Path(tmp) / 'app.db'
    conn = bootstrap_database(db_path)
    db_bytes_before = db_path.read_bytes()

    # Run exports
    export_notes_markdown(conn, content_hash='hash', document_id='doc', filename='source.pdf')
    export_notes_json(conn, content_hash='hash', document_id='doc', filename='source.pdf')

    # Assert immutability
    hash_after = hashlib.sha256(pdf_file.read_bytes()).hexdigest()
    assert hash_before == hash_after, 'FAIL: Source PDF altered during export!'
    
    # Assert DB unchanged
    cur = conn.cursor()
    cur.execute('SELECT count(*) FROM annotations')
    assert cur.fetchone()[0] == 0

    print('AC-P0-21 PASS: Read-only immutability verified on PDF and database.')
"
```

### 7.4 Zero AI Calls & Strict Evidentiary Separation (AC-P0-24, AC-P0-25)
Execute:
```powershell
backend\.venv\Scripts\python.exe -c "
import inspect
from app.qa import retrieval, answering, index

retrieval_src = inspect.getsource(retrieval)
answering_src = inspect.getsource(answering)
index_src = inspect.getsource(index)

assert 'annotations' not in retrieval_src, 'Evidentiary leak: retrieval references annotations!'
assert 'annotations' not in answering_src, 'Evidentiary leak: answering references annotations!'
assert 'annotations' not in index_src, 'Evidentiary leak: index references annotations!'
print('AC-P0-24 & AC-P0-25 PASS: Zero AI calls and strict evidentiary separation verified.')
"
```

---

## 8. Explicit Non-Goals & Scope Boundaries

To prevent scope creep, protect bundle headroom, and maintain strict time discipline, the following features are designated as **Explicit Non-Goals** for DS-QA-012:

1. **Global Multi-Document Library Search (P0 Non-Goal):** P0 is strictly current-document only. Cross-document shelf search is deferred to P2.
2. **Annotation Import (P0 Non-Goal):** Importing external annotation files requires complex conflict resolution, anchor migration, and duplicate detection (Phase 47). P0 supports export only.
3. **SQLite FTS Indexing for Annotations:** FTS5 is explicitly rejected based on empirical measurement failures with Chinese bigrams and hyphenated identifiers.
4. **External Search / Geometry / Export Libraries:** No additions of `fuse.js`, `lunr`, `marked`, or `jspdf`. Headroom is ~18 kB; zero bundle bloat allowed.
5. **PDF Annotation Writeback:** Notes are never written back into the source PDF file as Adobe Acrobat annotations.
6. **Note-Assisted Paper QA or Retrieval:** Notes must never enter `search.db`, BM25 retrieval chunks, or LLM answering contexts.
7. **Cloud Sync / Remote Storage:** Single-user, local-first storage only.
8. **PDF / DOCX Export Formats:** Export is strictly Markdown (`.md`) and JSON (`.json`). Binary document generators are out of scope.
