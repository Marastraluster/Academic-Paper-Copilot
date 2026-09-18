# Acceptance Criteria: DS-QA-001 Scope-Aware Retrieval & Citation Grounding

**Target System:** Local-First Academic PDF Copilot  
**Task ID:** `DS-QA-001`  
**Phase:** Paper QA (Deterministic Retrieval & Citation Grounding Layer)  
**Role:** Independent Acceptance Criteria Author  
**Deliverable:** Acceptance Criteria Specification only (No production code)

---

## 1. P0 Acceptance Criteria (Release-Blocking)

Every P0 criterion must pass in automated tests before any implementation of `DS-QA-001` is eligible for merge.

### P0-1: Architectural & Physical Document Isolation (Per-Document `search.db`)
* **Specification:** The full-text search index for each document must reside in an isolated SQLite database file at [`<documents_dir>/<document_id>/search.db`](file:///app/document/storage.py). The global application database (`app.db`) must remain untouched: zero schema migrations, zero schema version bumps, and the existing isolation assertions in [`backend/tests/test_db.py`](file:///backend/tests/test_db.py) and [`backend/tests/test_isolation.py`](file:///backend/tests/test_isolation.py) must continue to pass without modification.
* **Verifiable Assertion:**
  1. `tables == ["documents", "profiles", "schema_version", "translation_tasks"]` in `app.db`.
  2. Executing a search targeting `document_A` while opening `search.db` of `document_B` is structurally impossible at the connection level.
  3. Deleting `<documents_dir>/<document_id>/` completely purges all index data with zero dangling foreign keys or orphan rows in any SQLite file.
* **Rationale:** Academic papers are self-contained artifacts. In FTS5, shared-table multi-tenant indexing contaminates global Inverse Document Frequency ($\text{IDF}$) statistics across distinct research domains and creates leakage vectors if a `WHERE document_id = ?` clause is omitted. Physical file isolation makes cross-document data leakage physically impossible.

### P0-2: Scope Enforcement as a Hard Backend Boundary
* **Specification:** Scope resolution must execute as an immutable query filter on candidate generation inside the retrieval engine, not as post-retrieval filtering in the UI or service layer. The supported scopes are:
  - `whole_paper`: Candidate pool comprises all eligible paragraphs in the document.
  - `section`: Candidate pool is strictly restricted to paragraphs where [`ParagraphIR.section_id == target_section_id`](file:///app/document/models.py).
  - `page`: Candidate pool is strictly restricted to paragraphs spanning [`target_page`](file:///app/document/models.py) (i.e. `target_page in paragraph.page_range` or `paragraph.page_number == target_page`).
  - `selection`: Candidate pool is strictly restricted to the exact [`paragraph_ids`](file:///app/document/models.py) passed in the request.
* **Verifiable Assertion:**
  1. For a query $Q$ with high lexical match on page 10, executing $Q$ with `scope={"type": "page", "page": 2}` must return **zero** hits from page 10.
  2. For a query $Q$ with scope `section={"type": "section", "section_id": "sec_method"}`, every hit in the returned evidence bundle must satisfy `hit.section_id == "sec_method"`.
  3. An out-of-scope candidate must never enter candidate scoring.
* **Rationale:** Scope is a contractual correctness guarantee. Searching the whole paper and filtering post-BM25 starves relevant in-scope paragraphs from reaching top-$K$ if out-of-scope paragraphs have higher raw term frequency.

### P0-3: 100% Deterministic Citation Grounding
* **Specification:** Every returned evidence unit ([`EvidenceItem`](file:///app/qa/models.py)) must originate verbatim from [`DocumentIR`](file:///app/document/models.py). The retrieval layer must assign a local sequential identifier (`E1`, `E2`, ..., `En`) ordered by rank and preserve exact metadata: `paragraph_id`, `page_number`, `page_range`, `section_id`, and verbatim `text`.
* **Verifiable Assertion:**
  1. For 100% of returned evidence items, `evidence.text == ir.paragraphs[evidence.paragraph_id].text` (byte-for-byte match).
  2. For 100% of returned evidence items, `evidence.page_number == ir.paragraphs[evidence.paragraph_id].page_number`.
  3. No field in [`EvidenceItem`](file:///app/qa/models.py) may be populated by or passed through an LLM.
* **Rationale:** A downstream QA answer generator cannot ground citations if the evidence layer fabricates or shifts page boundaries or paragraph identifiers.

### P0-4: Strict Exclusion of Layout Boilerplate (`abandon`)
* **Specification:** Text blocks tagged with layout class `abandon` (running headers, footers, page stamps, decorative watermarks) must be strictly excluded from the FTS index and never appear in any evidence bundle, either as primary hits or neighbour expansions.
* **Verifiable Assertion:**
  ```python
  abandon_block_ids = {b.id for p in doc_ir.pages for b in p.blocks if b.layout_class == "abandon"}
  for item in evidence_bundle.items:
      assert not set(item.block_ids) & abandon_block_ids
  ```
* **Rationale:** Running headers frequently repeat paper titles and section titles across all pages. Indexing them causes BM25 to score header fragments as top evidence for title-matching queries on every single page.

### P0-5: Safe Query Normalisation & FTS5 Syntax Immunity
* **Specification:** User input must be normalized conservatively to preserve critical technical tokens (e.g. `ResNet-50`, `CIFAR-10`, `VLA`, `F(x)`, `p < 0.05`). Raw user queries containing punctuation or FTS5 boolean syntax characters (`-`, `+`, `*`, `:`, `"`, `(`, `)`, `NOT`, `AND`, `OR`, `NEAR`) must be escaped or sanitized into valid phrase/token query syntax before passing to SQLite FTS5.
* **Verifiable Assertion:**
  1. The query `ResNet-50` must NOT be interpreted as `ResNet NOT 50`. It must retrieve paragraphs containing `ResNet-50`.
  2. Queries containing syntax characters (e.g. `"`, `(`, `)`, `*`, `AND NOT`, `:::`) must return valid results or an empty result set, and **must never** throw an unhandled SQLite `OperationalError` (`fts5: syntax error`).
* **Rationale:** Academic queries routinely contain hyphens, math notation, and parenthetical citations. Unsanitized strings in SQLite FTS5 break or actively invert retrieval logic.

### P0-6: Post-Ranking Contiguous Neighbour Expansion & Deduplication
* **Specification:** Neighbour expansion ($P_{i-1}$, $P_{i+1}$) must occur **strictly after ranking** atomic [`ParagraphIR`](file:///app/document/models.py) units. Expansion is permitted only within the **same section** ([`ParagraphIR.section_id`](file:///app/document/models.py)) and must never cross section boundaries, reference sections, or abstract boundaries. Overlapping windows must be deduplicated into ordered, contiguous evidence blocks.
* **Verifiable Assertion:**
  1. Given top hits $P_2$ and $P_3$ in the same section: expanding $P_2$ ($P_1, P_2, P_3$) and $P_3$ ($P_2, P_3, P_4$) must produce a single merged window $[P_1, P_2, P_3, P_4]$ without duplicate paragraph IDs.
  2. If $P_k$ is the last paragraph of Section A, its $+1$ expansion must NOT pull $P_{k+1}$ if $P_{k+1}$ belongs to Section B.
  3. Direct search hits are marked `is_direct_hit=True`; expanded neighbours are marked `is_direct_hit=False`.
* **Rationale:** Ranking pre-concatenated windows distorts BM25 length normalization and blurs attribution. Expanding across sections injects irrelevant topic context.

### P0-7: Index Lifecycle, Idempotency & Invalidation
* **Specification:** Index creation must be idempotent. The index must record a schema signature and the [`DocumentIR.content_hash`](file:///app/document/models.py) (SHA-256 of the PDF).
* **Verifiable Assertion:**
  1. Calling `index_document(doc_ir)` twice sequentially results in the exact same row count in `search.db`.
  2. If `search.db` exists but its recorded `content_hash` does not match `doc_ir.content_hash`, the index is declared stale, atomically recreated, and the query succeeds.
  3. Building or querying `search.db` must never modify [`ir.json`](file:///app/document/storage.py) or [`analysis.json`](file:///app/document/storage.py).
* **Rationale:** Invalidation must be deterministic and transparent. Stale indices must self-heal on hash mismatch without data corruption.

### P0-8: Non-Blocking Independence from `DocumentAnalysis`
* **Specification:** The search engine must build its index and execute queries successfully using [`DocumentIR`](file:///app/document/models.py) alone, even when [`DocumentAnalysis`](file:///app/context/models.py) (`analysis.json`) is absent, incomplete, or corrupted. Retrieval queries must never trigger the LLM analysis pipeline.
* **Verifiable Assertion:**
  1. In an environment where `analysis.json` does not exist for a document, calling `search(query, scope)` executes synchronously without invoking any LLM provider and returns valid BM25 hits.
* **Rationale:** `DocumentAnalysis` requires hundreds of seconds of LLM compute. Basic search must be available immediately once PDF ingestion (`ir.json`) completes.

### P0-9: Benchmark Retrieval Quality Baseline
* **Specification:** On the two canonical reference papers (**ResNet** and **Diffusion Policy**), the deterministic retrieval layer must achieve a minimum retrieval recall on a golden evaluation set of 10 English technical questions per paper:
  - $\text{Hit@5} \ge 80\%$ (at least 8 out of 10 questions return the target ground-truth paragraph in the top 5 direct hits).
  - $\text{Hit@10} \ge 90\%$.
* **Verifiable Assertion:** Automated benchmark runner asserts `hit_at_k(resnet_benchmark, k=5) >= 0.80` and `hit_at_k(diffusion_benchmark, k=5) >= 0.80`.
* **Rationale:** Sets an objective quantitative quality gate on real-world academic papers before proceeding to LLM answer generation.

---

## 2. P1 Acceptance Criteria (Expected Production Standards)

### P1-1: Deterministic Cross-Lingual & Acronym Expansion via `DocumentAnalysis`
* **Specification:** When [`DocumentAnalysis`](file:///app/context/models.py) is present:
  1. **Chinese $\to$ English:** A Chinese query must be matched against [`GlossaryEntry.suggested_translation`](file:///app/context/models.py) and [`GlossaryEntry.definition`](file:///app/context/models.py). Any matched glossary term must append its corresponding [`source_term`](file:///app/context/models.py) to the query as an exact FTS5 phrase (e.g. `“退化问题”` $\to$ `"degradation problem"`).
  2. **Acronyms:** An acronym query (e.g. `VLA`) matching an [`AcronymEntry`](file:///app/context/models.py) where [`expansion is not None`](file:///app/context/models.py) must append the attested expansion as an exact phrase (e.g. `"vision-language-action"`). If `expansion is None`, expansion is suppressed.
  3. No translation model or external LLM may be called at query time; expansion is pure in-memory dictionary lookup.
* **Verifiable Assertion:**
  - On ResNet with `analysis.json` present: Query `“作者如何解决退化问题？”` returns the residual learning introduction paragraph (containing `degradation problem`) in the top-3 hits.
  - With `analysis.json` deleted: The ablation test confirms 0 hits for the same Chinese query, proving expansion causality.
* **Rationale:** Solves cross-lingual matching deterministically without paying the latency, cost, and hallucination penalties of query-time LLM translation.

### P1-2: Section-Heading Boost via Column Weighting
* **Specification:** The FTS5 schema must index `section_title` alongside `body_text`. Using FTS5 column weights (e.g. `bm25(search_fts, 5.0, 1.0)`), query terms matching the section title must boost the score of paragraphs contained within that section. Headings themselves must not be emitted as standalone empty evidence items.
* **Verifiable Assertion:**
  - A query for `hyperparameters and training setup` ranks the body paragraphs in section "Implementation Details" higher than identical terms appearing in an introductory paragraph.
* **Rationale:** Academic queries often describe section topics; boosting body prose via its section title connects topic intent with explanatory text.

### P1-3: Reference Section De-prioritization
* **Specification:** Paragraphs belonging to sections marked [`SectionIR.is_references == True`](file:///app/document/models.py) must be excluded from candidate generation unless the query scope explicitly targets that section or includes citation-specific intent.
* **Verifiable Assertion:**
  - For a conceptual query `vanishing gradient problem`, bibliography entries citing prior work on vanishing gradients must not outrank the core method or introduction paragraphs.
* **Rationale:** Bibliographies contain high densities of academic keywords that artificially inflate BM25 scores while containing zero explanatory evidence.

### P1-4: Captions as First-Class Searchable Evidence
* **Specification:** [`ParagraphIR`](file:///app/document/models.py) units originating from `figure_caption` or `table_caption` blocks must be indexed and explicitly tagged with `is_caption=True` and `caption_of=<target_id>`.
* **Verifiable Assertion:**
  - The query `Figure 3 ResNet architecture` returns the caption of Figure 3 as a top-3 hit with `is_caption=True`.
* **Rationale:** Technical questions frequently target empirical figures and tables; users need the caption directly linked to the visual figure.

### P1-5: Scope Invariance & Negative Constraint Verification
* **Specification:** Running the identical query under contrasting scopes must produce disjoint or strictly subsetted candidate sets.
* **Verifiable Assertion:**
  - Given query $Q$ with ground truth in Section 3:
    - Scope `section="sec_3"`: returns expected hits.
    - Scope `section="sec_wrong"`: returns strictly 0 hits or hits only within `sec_wrong`.
    - Scope `page=target_page`: returns expected hits.
    - Scope `page=wrong_page`: returns strictly hits on `wrong_page`.
* **Rationale:** Proves the backend engine enforces mathematical partition of the document rather than cosmetic filtering.

### P1-6: Privacy & Bounded Structured Logging
* **Specification:** The retrieval engine must never log raw paragraph text, full evidence bundles, or full user queries to disk or telemetry. Permitted log fields are: `document_id`, `scope_type`, `query_sha256`, `query_length_chars`, `execution_time_ms`, `total_hits_found`, and `returned_hit_count`.
* **Verifiable Assertion:**
  - Inspecting the log output of 100 retrieval operations shows zero occurrences of raw paper prose or raw user query text.
* **Rationale:** Ensures privacy compliance for proprietary, unreleased, or confidential academic preprints.

### P1-7: Local Interactive Latency Budgets
* **Specification:** Local retrieval must meet strict latency and throughput targets on standard developer hardware (CPU only, single thread):
  - **Index Build:** $\le 1.5\text{ s}$ for a 15-page academic paper (~60 paragraphs).
  - **Cold Search (first query, DB open):** $\le 25\text{ ms}$.
  - **Warm Search (cached connection):** $\le 8\text{ ms}$ for `whole_paper` scope; $\le 3\text{ ms}$ for `section` or `page` scope.
* **Verifiable Assertion:** Benchmark test running 50 iterations verifies $p95$ query latency $\le 15\text{ ms}$.
* **Rationale:** Local-first interactive QA requires snappy, sub-perceptual retrieval delays.

---

## 3. P2 Acceptance Criteria (Diagnostics & Optimization)

### P2-1: Structured Diagnostic Failure Taxonomy
* **Specification:** When an evidence bundle returns zero hits or low-confidence results, the response payload must include a diagnostic reason code from an explicit taxonomy:
  - `NO_MATCH_TOKEN`: Query tokens not present in document FTS index.
  - `OUT_OF_SCOPE`: Tokens exist in document, but not within the requested scope filter.
  - `CROSS_LINGUAL_NO_ANALYSIS`: Non-English query executed without `analysis.json`.
  - `ACRONYM_UNATTESTED`: Acronym has no expansion attested in paper.
* **Verifiable Assertion:**
  - A query for a non-existent word returns `diagnostic="NO_MATCH_TOKEN"`.
  - A query whose tokens exist only on Page 5, queried with `page=1`, returns `diagnostic="OUT_OF_SCOPE"`.
* **Rationale:** Eliminates debugging guesswork for frontend developers and downstream answer generators.

### P2-2: Evaluation Harness with MRR & Hit@K Reporting
* **Specification:** A standalone test harness must run the evaluation suite against ResNet and Diffusion Policy and output a clean Markdown table reporting:
  - $\text{Hit@1}, \text{Hit@3}, \text{Hit@5}, \text{Hit@10}$
  - $\text{MRR}$ (Mean Reciprocal Rank)
  - Ablation Delta: $\Delta \text{Hit@K}$ with and without Glossary Expansion.
* **Verifiable Assertion:** Running `pytest backend/tests/qa/test_benchmark.py` produces the standardized report table without external evaluation libraries.
* **Rationale:** Provides auditable evidence of retrieval effectiveness for future regression testing.

### P2-3: Storage Overhead Bounds
* **Specification:** The generated `search.db` file size must not exceed $25\%$ of the original PDF file size or $300\text{ KB}$ for standard papers ($\le 20\text{ pages}$).
* **Verifiable Assertion:**
  - For ResNet PDF (~1.5 MB), `search.db` is $\le 250\text{ KB}$.
* **Rationale:** Keeps disk usage minimal for local-first storage of large paper libraries.

---

## 4. Explicitly Not Applicable (and Why)

| Item | Status | Why It Is Excluded |
| :--- | :--- | :--- |
| **LLM Answer Generation** | Out of Scope | Belongs to task `DS-QA-002`. This task strictly terminates at the deterministic evidence bundle. |
| **Dense Embeddings & Vector Stores** | Forbidden | Chroma, FAISS, Milvus, Qdrant, Pinecone, or external embedding APIs are forbidden. Dense retrieval introduces multi-gigabyte dependencies and non-deterministic scoring not justified for single-paper search. |
| **Frontend UI / PDF Viewer Integration** | Out of Scope | Scope selection UX, bounding-box highlighting, and chat UI are separate frontend tasks. Backend API contracts govern this task. |
| **Second PDF Parser / IR Derivation** | Forbidden | [`DocumentIR`](file:///app/document/models.py) (96.3% prose mapping) already exists. Re-parsing the PDF violates project invariants. |
| **LLM Query Expansion** | Forbidden | Calling an LLM to rewrite queries at search time adds 500–2000ms latency, incurs monetary cost, and introduces hallucinated synonyms. Expansion is strictly dictionary-based via [`DocumentAnalysis`](file:///app/context/models.py). |
| **Cross-Document / Global Library Search** | Out of Scope | This task addresses single-paper QA. Multi-paper library search belongs to a later phase. |

---

## 5. Direct Answers to the Core Decisions

### The Index-Location Decision: (A) `chunks_fts` in `app.db` vs. (B) `search.db` per Document

**The criteria strictly require Option (B): Index each document in its own SQLite file at [`<documents_dir>/<document_id>/search.db`](file:///app/document/storage.py).**

#### Detailed Reasoning:
1. **Preservation of Guard Invariants:**
   The guards in [`backend/tests/test_db.py`](file:///backend/tests/test_db.py) and [`backend/tests/test_isolation.py`](file:///backend/tests/test_isolation.py) enforce that `app.db` contains only global relational entities (`documents`, `profiles`, `schema_version`, `translation_tasks`). Placing document chunks into `app.db` violates the architectural separation between metadata/tasks and document content artifacts.
2. **True Physical Isolation vs. Logical Filtering:**
   In `app.db`, preventing document leakage relies entirely on consistent `WHERE document_id = ?` filtering across all query paths. In Option (B), document isolation is physical and structural: opening `search.db` for Document A guarantees that records from Document B do not exist in the addressable database.
3. **Statistical Validity of BM25 (IDF Contamination):**
   SQLite FTS5 computes Inverse Document Frequency ($\text{IDF}$) using the total row count ($N$) and term occurrence count ($df$) across the entire table. In a shared `app.db`, searching a robotics paper would have its term weights skewed by 50 previously ingested computer vision or chemistry papers. Option (B) ensures $\text{IDF}$ is 100% localized to the paper being read.
4. **Lifecycle & Cache Alignment:**
   Derived artifacts in this project already live in the document directory: [`ir.json`](file:///app/document/storage.py), [`analysis.json`](file:///app/document/storage.py), `mono.pdf`, and `dual.pdf`. Putting `search.db` beside them makes deletion, archiving, cache invalidation, and disk backup atomic and trivial (`rm -rf <doc_dir>`).
5. **Cost Justification:**
   The only costs of (B) are managing SQLite connection lifecycle per search request and a negligible filesystem overhead (~100 KB per paper). In Python, caching open connections via an LRU pool completely eliminates connection setup overhead.

---

### Decision 1: Headings, Captions, and References vs. Body Prose

* **Decision:**
  - **Headings (`title`):** Must **not** be indexed as standalone evidence chunks. They are indexed as boosting metadata columns (`section_title`) attached to each child paragraph. This allows queries matching section titles to boost relevant prose without returning a 3-word heading as an "answer".
  - **Captions (`figure_caption`, `table_caption`):** Must be indexed as searchable evidence chunks, flagged with `is_caption=True` and retaining their associated block IDs. They are primary evidence for questions about figures and tables.
  - **References (`is_references == True`):** Must be indexed in a separated state (or excluded by default from candidate generation). They must not compete with body prose for conceptual queries.
  - **Boilerplate (`abandon`):** Strictly dropped; never indexed.

---

### Decision 2: Neighbour Expansion: Before or After Ranking?

* **Decision:** **Strictly after ranking.**
* **Reasoning:**
  1. **BM25 Length Normalization Invariant:** Concatenating 3 paragraphs ($P_{i-1} + P_i + P_{i+1}$) creates an artificially large document unit ($L \gg L_{avg}$). BM25 penalizes long units via parameter $b$, artificially suppressing comprehensive sections in favor of tiny paragraphs.
  2. **Attribution Ambiguity:** A concatenated 3-paragraph hit creates citation confusion: which paragraph contained the actual matching fact?
  3. **Ranking Efficiency & Deduplication:** Ranking atomic paragraphs is $O(N)$. Expanding top-$K$ hits ($K \le 10$) is an $O(K)$ in-memory operation where adjacent windows merge cleanly without redundant FTS scoring.

---

### Decision 3: Role of `DocumentAnalysis` Summaries

* **Decision:** `DocumentAnalysis` summaries participate in **neither** candidate generation nor query expansion.
* **Reasoning:**
  - **Candidate Generation:** A summary is an LLM-generated paraphrase. Citing an LLM summary violates P0-3 (evidence must be verbatim from [`DocumentIR`](file:///app/document/models.py) with real page numbers).
  - **Query Expansion:** Free-form prose summaries are unstructured and noisy. For query expansion, [`DocumentAnalysis`](file:///app/context/models.py) already provides structured, high-precision deterministic artifacts: [`glossary`](file:///app/context/models.py) (source terms + translations + definitions) and [`acronyms`](file:///app/context/models.py) (verified expansions). Query expansion must use those structured tables exclusively. Summaries are reserved for the answer generation phase (`DS-QA-002`) as optional macro-context.

---

### Decision 4: Selection Scope Mechanism

* **Decision:** Selection scope acts as an **absolute constraint**, not an open search with selection boosting.
* **Behavior:**
  - When `scope={"type": "selection", "paragraph_ids": [...]}` is provided:
    1. If `query` is empty or a generic summarization/explanation request, FTS search is **completely bypassed**. The specified paragraphs are loaded directly from [`DocumentIR`](file:///app/document/models.py) and returned as `E1, E2, ...` in their natural reading order.
    2. If a specific lexical search query is provided, FTS candidate generation is strictly restricted via `WHERE paragraph_id IN (...)`.
    3. Under no circumstances may any paragraph outside the selection list be returned as an evidence item.

---

## 6. Premises Believed to Be Wrong or Hazardous

### 1. The Premise that the `unicode61` Tokenizer Eliminates the Threat to Hyphenated Identifiers
* **The Error in the Premise:** The brief states:
  > *"The default unicode61 tokenizer splits resnet-50 into resnet and 50, so a bare resnet query already matches — the tokenizer is not the threat to identifiers that aggressive query normalisation would be."*
* **Why This Is Dangerous:** While the *tokenizer* handles splitting during indexing, SQLite FTS5's *query parser* treats the hyphen `-` as the **unary NOT operator**.
  If a user searches for `ResNet-50`, passing this raw string into FTS5 `MATCH` causes SQLite to execute:
  $$\text{MATCH 'ResNet NOT 50'}$$
  This actively **excludes** any paragraph containing `50`, precisely disqualifying `ResNet-50`! Furthermore, characters like `:`, `(`, `)`, `"`, `*`, or mathematical notation like `F(x)` trigger immediate SQLite syntax exceptions (`OperationalError: fts5: syntax error`).
* **Correction Required in Criteria:** The criteria must mandate a conservative Query Parser / Sanitizer that wraps tokens in quotes or strips FTS5 operators before query execution (P0-5).

---

### 2. The Premise that Glossary Lookup Alone Solves Chinese Queries Against English Papers
* **The Error in the Premise:** The brief assumes that matching a Chinese query like `“作者如何解决退化问题？”` can be done via simple deterministic glossary lookup.
* **Why This Is Incomplete:**
  1. Without Chinese tokenization/segmentation (e.g. Jieba or n-gram scanning), string matching requires either exact match of the entire query or substring search across all glossary entries.
  2. If the user query is `“作者如何解决退化问题？”` and the glossary has `“退化现象”` or `“退化”`, an exact match on `“退化问题”` yields 0 hits.
  3. Most critically: **If `DocumentAnalysis` has not been run** (which is explicitly allowed by the requirement that search must not depend on analysis), a Chinese query against an English paper under pure FTS5 BM25 will return **0 hits with 100% certainty**.
* **Correction Required in Criteria:** The criteria must establish that cross-lingual expansion is explicitly conditional on `DocumentAnalysis` availability (P1-1), mandate longest-substring glossary matching, and require a distinct diagnostic (`CROSS_LINGUAL_NO_ANALYSIS`) when a non-Latin query is executed without analysis (P2-1).

---

### 3. The Premise of Single `page_number` Attribution for Spanning Paragraphs
* **The Ground Truth Ambiguity:** In [`ParagraphIR`](file:///app/document/models.py), paragraphs contain both `page_number: int` and `page_range: list[int]`. Academic paragraphs frequently start at the bottom of page 3 and finish at the top of page 4.
* **The Hazard:** If evidence is located on page 4, but the citation metadata only exports `page_number = 3` (the starting page), a user navigating to the citation in the PDF viewer will be taken to page 3, where the text is not visible.
* **Correction Required in Criteria:** Citation grounding must export both primary `page_number` (starting page) and `page_range` (all spanned pages), and page-scoped queries must check `target_page in paragraph.page_range`.

---

### 4. Unbounded Expansion Crossing Document Structural Partitions
* **The Hazard:** A naive implementation of $+1$ neighbour expansion takes `index + 1` from `doc_ir.paragraphs`. In academic PDFs, the paragraph immediately following the Abstract is "1. Introduction"; the paragraph immediately following "Conclusion" is often "References" or "Acknowledgements".
* **Correction Required in Criteria:** Expansion logic must explicitly check `current.section_id == neighbour.section_id` and forbid expansion across section boundaries or into references (P0-6).

---

## 7. Evidence Bundle Data Contract (Target Schema)

To ensure unambiguous implementation without writing production code, the criteria enforce the following response contract for the retrieval layer:

```json
{
  "document_id": "doc_resnet_2015",
  "scope": {
    "type": "whole_paper"
  },
  "query_normalized": "residual learning degradation problem",
  "expansions_applied": [
    {
      "term": "退化问题",
      "expanded_to": "degradation problem",
      "source": "glossary"
    }
  ],
  "evidence_bundle": [
    {
      "id": "E1",
      "paragraph_id": "p_0014",
      "section_id": "sec_intro",
      "section_title": "1. Introduction",
      "page_number": 2,
      "page_range": [2],
      "score": -4.821,
      "is_direct_hit": true,
      "is_caption": false,
      "text": "When deeper networks are able to start converging, a degradation problem has been exposed: with the network depth increasing, accuracy gets saturated and then degrades rapidly."
    },
    {
      "id": "E2",
      "paragraph_id": "p_0015",
      "section_id": "sec_intro",
      "section_title": "1. Introduction",
      "page_number": 2,
      "page_range": [2],
      "score": null,
      "is_direct_hit": false,
      "is_caption": false,
      "text": "Unexpectedly, such degradation is not caused by overfitting, and adding more layers to a suitably deep model leads to higher training error..."
    }
  ],
  "diagnostics": {
    "execution_time_ms": 4.2,
    "total_candidates_scored": 42,
    "code": "SUCCESS"
  }
}
```

This contract establishes a clean, auditable, and deterministic foundation for the upcoming `DS-QA-002` answer generator.
