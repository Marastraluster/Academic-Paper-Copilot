# Acceptance Criteria — DS-QA-007: Hybrid Semantic Retrieval Experiment

- **Author:** project maintainer
- **Process:** §1–§7 are the criteria, written before implementation; §0 is the
  review of them.
- **Reviewed and frozen by:** project maintainer
- **Date:** 2026-09-18
- **Baseline:** Commit `80c753c` (DS-QA-006 final)
- **Status:** **FROZEN**, with **4 `AC_CHANGE_REQUEST`s**, all resolved.
  **12 P0 · 7 P1 · 2 P2.**
- **Gate Structure:** **Dual Independent Gates** (1. Experiment Success Gate;
  2. Production Adoption Gate)

---

## 0. Review before implementation

The criteria measured before it wrote, and the measurements hold. This is the third
round in which it has produced criteria whose numbers I could reproduce, and the
first in which **every load-bearing figure it quotes is exactly right** — including
the ones it had to derive itself.

### 0.1 Claims verified against the repository

| Claim | Verified |
|---|---|
| §2.1 diagnostic baseline Hit@1/3/5/10 = 54.5 / 69.7 / 75.8 / 84.8%, 5 `NOT_RETRIEVED`, 4-of-7 lifted, 0 regressions | **exact** — re-run today on `80c753c` via the qa/gate_check.py run log |
| §2.1 held-out Mamba baseline Hit@1 35.7% (5/14), Hit@3 50.0% (7/14), Hit@5 57.1% (8/14), Hit@10 71.4% (10/14) | **exact** — independently measured with the qa/run_bench.py run log lexical` before reading this section |
| §2.1 held-out `NOT_RETRIEVED` = 3 cross-language + 1 Method (`over a 1.0 perplexity improvement`); `LOW_RANK` = the rank-9 cross-language and rank-6 `S6` | **exact**, including which four and why the rank-9 case survived (literal Latin tokens `Mamba` / `Transformer` in the Chinese question) |
| §2.1 held-out configuration is `analysis=None` | **exact** — Mamba has no `DocumentAnalysis`, so only the `raw` variant runs |
| §2.2.1 chunk counts: ResNet 115, Diffusion Policy 186, PPO 58, Mamba 295 | **exact**, all four, measured from the `chunks` table |
| §2.2.2 AVX512-VNNI absent on this CPU | **exact** — `AVX512VNNI: False`, `AVX2: True` |
| §2.2.3 BM25 is uncalibrated and unbounded-negative; cosine is bounded | **exact** — `BM25_EXPRESSION` is used with `ORDER BY score` ascending precisely because lower is better |
| §7.1 `gate_check.py`, §7.3 `qa_benchmark.py`, §7.5 `frontend/scripts/e2e-qa.mjs` exist | **all exist** |

Two claims are procedural rather than numeric and are **incomplete**: §7.2 names
`run_experiment_arms.py` and §7.4 names `profile_dense.py`, and neither file
exists. The three-arm harness is `run_bench.py` (already written) and the profiler
will be added; I will keep the criteria's names as the criterion's entry points rather
than rename my own, because a criterion that names a file is only evaluable if
that file is the one that runs.

### 0.2 What the review adds

**AC-P0-01 already passes.** The baseline was reproduced before this document was
frozen, not after: Hit@5 75.8% (25/33), 4 of 7 lifted, 0 regressions, 5
`NOT_RETRIEVED`. Freezing a gate on a number that has already been measured is not
a formality here — DS-QA-006's round failed its first gate because a baseline was
quoted from a different configuration than its neighbours.

**The held-out set was authored blind, and the design is load-bearing.** The 14
Mamba questions were written by reading the extracted text *before any dense
retrieval existed in this repository*, and a verifier refuses to run if a gold
phrase is missing or an "unanswerable" question names a term the paper contains.
It caught two of my own three unanswerable items (`weight decay` and `dropout`
both appear in Mamba's appendices) — so the negative benchmark is grounded rather
than asserted. the criteria's §2.2 corrections and its Gate-2 thresholds were written
against a held-out result it could not have tuned, which is the property that
makes them worth freezing.

### AC_CHANGE_REQUEST 1 — AC-P1-07 would make a rejected experiment's dependency permanent

| | |
|---|---|
| **As written** | AC-P1-07: *"If exact XLM-RoBERTa tokenization requires `tokenizers`, it must be declared explicitly as a single minimal rust-backed dependency, maintaining the AC-11 minimal-dependency policy."* |
| **Problem** | Declaring it in `[project.dependencies]` installs it for every user of a product that, under an A/B outcome, never uses it. The task's own Phase 73 says the opposite: *"do not automatically make it a mandatory production dependency when outcome is A/B. Use optional/dev/experiment dependency semantics. Do not leave unnecessary runtime weight behind after a rejected experiment."* The two rules agree on the part that matters — **declare it, never let it be transitive** (which is exactly what `pyproject.toml` says a dependency declaration exists to prevent) — and disagree only on whether declaration implies mandatory installation. |
| **Resolution** | `tokenizers` is declared explicitly in a new `[project.optional-dependencies] experiment` extra. That satisfies AC-11's real requirement (a dependency we program against is named, versioned and visible, not inherited from `pdf2zh`/`babeldoc`) while leaving a rejected experiment with no runtime weight. Promotion to `dependencies` is a one-line change in whichever task adopts the result. Measured: `tokenizers==0.23.2`, **one package, zero transitive additions**. |
| **Not accepted** | Adding `torch`, `transformers` or `sentence-transformers` — 2 GB+ for a tokenizer, and AC-P1-07 forbids them. |

### AC_CHANGE_REQUEST 2 — AC-P1-03's exact-term scope is ambiguous on the held-out paper

| | |
|---|---|
| **As written** | AC-P1-03: *"On exact-term queries containing technical tokens (`ResNet-50`, `Algorithm 1`, `Figure 3`, `Eq. 4`, `CIFAR-10`), Arm C (Hybrid) must rank the gold paragraph in Top 1 (`rank = 1`) or identical to the lexical baseline."* |
| **Problem** | None of those five tokens occurs in the held-out Mamba paper, so the clause cannot be read as "apply it to the held-out `EXACT_TERM` questions". Read literally it is vacuous on held-out data; read broadly it silently binds two Mamba questions whose lexical baseline is rank 6 (`S6`) and rank 5 (`induction heads`) — and `rank = 1` and *"identical to the lexical baseline"* are alternatives of very different difficulty. Which reading is intended decides whether a hybrid result that leaves `S6` at rank 6 fails. |
| **Resolution** | The criterion binds **two** sets, both explicit: (a) the five enumerated identifier tokens above, wherever they occur — Arm C must not move their gold out of rank 1 if it was there, and must place it at rank 1 if lexical did; (b) every question in the `EXACT_TERM` category of either benchmark — Arm C's rank must be **no worse than the lexical baseline's rank for that same question**. "Identical or better, never worse" is the property the clause exists to protect, and it is evaluable on both sets without ambiguity. |
| **Not accepted** | Reading (a) alone, which would let the hybrid arm demote `S6` from 6 to 60 unnoticed. |

### AC_CHANGE_REQUEST 3 — AC-P1-06 permits fp32 on disk and forbids it in memory

| | |
|---|---|
| **As written** | AC-P1-06: *"Embedding model disk footprint ≤ 200 MB (quantized int8) or ≤ 500 MB (fp32)"* and, in the same criterion, *"Resident memory (RAM) overhead of the embedding runtime during inference ≤ 300 MB"*. |
| **Problem** | The published fp32 ONNX weights are **470.3 MB** (measured, before download). A session that loads them will hold on the order of that much resident. So the disk clause admits a configuration the memory clause forbids, and the criterion as written silently mandates int8 while presenting fp32 as an accepted option. An evaluator could reasonably record a PASS on one clause and a FAIL on the other for the same configuration. |
| **Resolution** | Both are measured and both are reported; the RAM ceiling is the binding one. If fp32 exceeds it, dynamic int8 quantization is **required, not optional** — and the criterion is met by the quantized artifact. The disk clause is read as a *ceiling per artifact*, not as permission to choose the larger one. Note the pre-quantized `model_qint8_avx512_vnni.onnx` is unusable here (§2.2.2), so quantization is done locally with ONNX Runtime's own API and its quality effect is measured on the benchmark rather than assumed. |
| **Not accepted** | Reporting the disk figure and omitting the RAM figure, which would be the flattering reading. |

### AC_CHANGE_REQUEST 4 — the criteria do not say whether a Gate-2 pass authorizes productionization here

| | |
|---|---|
| **As written** | AC-P0-11: *"Experimental dense/hybrid code must be guarded behind an explicit parameter or executed via offline benchmark harnesses **until Gate 2 is formally frozen**."* §5 describes Gate 2's PASS branch as *"Adopt in Prod"*. |
| **Problem** | The task's Phase 72 requires that a C/D outcome productionize *"the smallest accepted architecture in the same task **IF the frozen criteria explicitly allow it**"*, and otherwise *"stop and create a separate DS-QA-008 productionization task."* AC-P0-11 states the prohibition before Gate 2 is frozen and never states the permission after. It is therefore silent on the one question Phase 72 delegates to it, and silence resolves to "separate task" — which may or may not be what was intended. |
| **Resolution** | Made explicit: **a Gate-2 PASS does not, by itself, authorize productionization in DS-QA-007.** Because Gate 2 also requires 0 regressions, 16/16 abstentions, citation validity and the latency/storage budgets *on the production answer path* — none of which this experiment measures end-to-end — production changes are substantial by construction. A Gate-2 pass therefore ends DS-QA-007 with the experiment committed behind the experimental boundary, and creates **DS-QA-008 — Hybrid Retrieval Productionization** carrying the frozen Gate-2 evidence. This is the conservative reading, and it is the one the task's own "prefer a separate task if production changes are substantial" argues for. |
| **Not accepted** | Treating "Adopt in Prod" in the §5 diagram as a same-task mandate. A diagram is not a criterion, and Phase 72 asks for the permission to be explicit. |

### Frozen thresholds, restated

```
EXPERIMENT SUCCESS GATE (Gate 1)  — can pass while concluding "not worth adopting"
  G1.1  DS-QA-006 baseline reproduced exactly          MEASURED, PASSES today
  G1.2  three arms measured over 33 diagnostic + 14 held-out questions
  G1.3  candidate-pool recall@20 and recall@50 recorded for all 9 NOT_RETRIEVED
  G1.4  100% local CPU; no external service, no vector DB, no GPU, no remote call
  G1.5  diagnostic artifacts recorded under the qa/ run log

PRODUCTION ADOPTION GATE (Gate 2) — requires value over DS-QA-006
  G2.1  ≥ 4 of 5 diagnostic NOT_RETRIEVED into pool@20; ≥ 3 of 5 into Top-5
  G2.2  held-out Mamba Hit@5 ≥ 71.4% (≥10/14); Hit@1 ≥ 50.0% (≥7/14);
        ≥ 2 of the 3 unretrieved cross-language questions into Top-5; MRR +0.10
  G2.3  0 regressions out of Top-5 on the 25 diagnostic and 8 held-out passing
        questions
  G2.4  16/16 unanswerable abstain; 0 false supported answers; 100% citation
        validity
  G2.5  query ≤ 50 ms p95; cold build ≤ 15 s / 150 chunks (≤ 30 s / 300);
        cached load ≤ 20 ms; model ≤ 200 MB int8 (respecting ≤ 300 MB resident);
        ≤ 1 MB vectors per document; zero vector database
```

Both gates are frozen as of this document. Implementation follows them; where a
threshold turns out to be contradicted by measurement, the remedy is a recorded
change request in a follow-up review, never a silent edit — which is what happened
twice in DS-QA-006.

---

## 1. Executive judgment: is this task worth doing?

**Yes — but strictly as an offline, bounded experiment with dual frozen gates, and explicitly rejecting vector database infrastructure or production pipeline modifications during this phase.**

The diagnosis from DS-QA-006 and our direct measurements on commit `80c753c` establish an unambiguous boundary for what lexical search can achieve:

1. **Deterministic term-coverage reranking (DS-QA-006) exhausted the candidate-pool ranking ceiling.**
   On the 33-question diagnostic benchmark, coverage lifted 4 of 7 `LOW_RANK` misses into the top five, raising Hit@5 from 63.6% (21/33) to 75.8% (25/33) with zero regressions. However, for 5 questions, the gold paragraph was **`NOT_RETRIEVED`**: no lexical variant (`raw`, `glossary`, `acronym`, or `entity`) retrieved the gold paragraph into the 20-candidate pool. Ranking and fusion cannot score candidates that are absent from the pool.
2. **The failure modes of the 5 `NOT_RETRIEVED` cases are structural lexical mismatches:**
   - **4 Cross-Language queries** (1 Diffusion Policy, 3 PPO): Chinese queries against English papers return 0 rows under SQLite FTS5 `unicode61` tokenization. For PPO, no `DocumentAnalysis` exists at question time (held-out zero-shot upload), so deterministic acronym/glossary expansion has no source, and only `raw:0` runs.
   - **1 Lexical Synonym query** (ResNet *"What optimization method is used?"*): The answering paragraph describes SGD with momentum ("momentum") but never uses the word "optimization" or "method".
3. **The held-out Mamba benchmark (`heldout_mamba.py`, 14 questions) confirms this exact ceiling:**
   Measured on `80c753c`, baseline local lexical retrieval achieves **Hit@5 of 57.1% (8/14)**. Exactly 4 queries fail with `rank=None` (`NOT_RETRIEVED`), of which 3 are pure cross-language queries and 1 is a method synonym query.

Dense semantic retrieval is the mathematically principled solution to vocabulary mismatch and cross-lingual alignment: dense representations project queries and passages into a shared continuous metric space where geometric proximity reflects semantic similarity rather than character-sequence equality.

**However, dense retrieval introduces non-trivial operational costs:** model download size (100–500 MB), local CPU embedding latency, disk storage, and the risk of semantic drift (retrieving "topically adjacent" text that invites hallucinated answers or breaks abstention on unanswerable questions).

Therefore, DS-QA-007 is structured as a **controlled experiment with two independent gates**:
- **Gate 1 (Experiment Success Gate):** Determines whether the scientific evaluation was conducted honestly, completely, and deterministically across three arms (lexical, dense, hybrid). A finding that dense retrieval does not justify its operational cost is an acceptable and valuable result that passes Gate 1.
- **Gate 2 (Production Adoption Gate):** Freezes the non-negotiable thresholds required before dense retrieval may enter the default QA serving path.

---

## 2. Measured starting state & false premises corrected

### 2.1 Baseline measurements (reproduced on commit `80c753c`)

All measurements below were verified on Intel Core Ultra 9 285H (CPU only, `backend/.venv`, Python 3.12.13, NumPy 2.5.3, ONNX Runtime 1.30.0).

#### Diagnostic Benchmark (33 questions: 10 ResNet, 10 Diffusion Policy, 13 PPO)
- **Configuration:** Whole-paper scope, local retrieval path (`retrieve()` with RRF `k=60` + coverage `α=0.05`, no LLM rewrite).
- **Hit@1:** 54.5% (18/33)
- **Hit@3:** 69.7% (23/33)
- **Hit@5:** 75.8% (25/33)
- **Hit@10:** 84.8% (28/33)
- **LOW_RANK:** 4 of 7 lifted into top 5; 0 regressions.
- **NOT_RETRIEVED (5 cases):**
  1. ResNet: *"What optimization method is used?"* (gold: `momentum`) -> `fused=None`, variants run: `raw:0`
  2. Diffusion Policy: *"扩散策略如何生成动作序列？"* (gold: `action sequence`) -> `fused=None`, variants run: `raw:0`
  3. PPO: *"该方法如何限制策略更新的幅度？"* (gold: `constraint on the size of the policy update`) -> `fused=None`, variants run: `raw:0`
  4. PPO: *"用哪些环境来低成本地比较不同算法？"* (gold: `computationally cheap benchmark`) -> `fused=None`, variants run: `raw:0`
  5. PPO: *"论文用什么惩罚项来替代硬约束？"* (gold: `penalty on KL divergence`) -> `fused=None`, variants run: `raw:0`

#### Held-Out Mamba Benchmark (14 questions, `heldout_mamba.py`)
- **Configuration:** Whole-paper scope, local retrieval path, `analysis=None`.
- **Hit@1:** 35.7% (5/14)
- **Hit@3:** 50.0% (7/14)
- **Hit@5:** 57.1% (8/14)
- **Hit@10:** 71.4% (10/14)
- **NOT_RETRIEVED (4 cases):**
  - 3 Cross-language: *"为什么模型要从时间不变变成随时间变化？"*, *"为什么固定的卷积核无法处理选择性复制任务？"*, *"作者如何在不展开状态的情况下加快模型计算？"*
  - 1 Method: *"How much does increasing the state size help?"* (gold: `over a 1.0 perplexity improvement`)
- **LOW_RANK (2 cases):**
  - Cross-language: *"Mamba 的推理吞吐量比同样大小的 Transformer 高多少？"* (rank 9; survived only due to literal Latin tokens "Mamba" and "Transformer")
  - Exact term: *"What does S6 refer to in this paper?"* (rank 6)

#### Grounding Safety & Negative Controls
- **Unanswerable benchmark:** 16/16 unanswerable questions correctly abstain (`INSUFFICIENT_EVIDENCE`); 0 false supported answers.
- **Citation validity:** 100% structural validity; every cited paragraph maps to a canonical `paragraph_id` in `DocumentIR` with valid page numbers and bounding boxes.

### 2.2 False premises corrected

1. **False Premise: "A dedicated vector database service (e.g. Qdrant, Chroma, Milvus) is required for dense retrieval."**
   - **Refutation:** Academic papers in this system have between 58 and 295 chunks (ResNet: 115, Diffusion Policy: 186, PPO: 58, Mamba: 295 chunks). A full paper embedding matrix (295 chunks × 384 dimensions in float32) occupies **453 KB** of memory. An exact cosine similarity matrix-vector product in NumPy takes **< 0.1 ms** on CPU. An external vector database daemon would add process management complexity, network/socket latency (2–10 ms), serialization overhead, and megabytes of memory footprint to search a 450 KB array. A vector DB is provably unjustified.
2. **False Premise: "Pre-quantized AVX-512 VNNI ONNX models can run on modern client CPUs."**
   - **Refutation:** Modern client CPUs (such as the Intel Core Ultra 9 285H Arrow Lake architecture) lack AVX-512 and AVX512-VNNI support (`AVX512VNNI: False`, `AVX2: True`). Using the vendor pre-quantized `model_qint8_avx512_vnni.onnx` either crashes with illegal instruction faults or falls back to slow software emulation. Quantization must specifically target AVX2 / x86_64 CPU execution or utilize dynamic float32/int8 quantization via ONNX Runtime's native quantization API.
3. **False Premise: "Lexical BM25 and Dense Cosine Similarity scores can be directly summed or linearly combined."**
   - **Refutation:** FTS5 BM25 returns uncalibrated, unbounded negative scores whose magnitude depends heavily on query term frequencies and document length statistics. Dense cosine similarities are bounded in $[-1, 1]$ (typically clustered in $[0.6, 0.9]$ for dense text models). Linear combination $S = \text{BM25} + \beta \cdot \text{Dense}$ without score calibration breaks across queries and distorts rankings. Rank fusion (RRF) provides a scale-free, uncalibrated fusion mechanism that operates solely on ordinal rank positions.
4. **False Premise: "Dense retrieval can replace lexical retrieval entirely."**
   - **Refutation:** Pure dense retrieval frequently suffers from catastrophic recall degradation on exact technical identifiers (`ResNet-50`, `CIFAR-10`, `Eq. 4`, `Algorithm 1`, `Figure 3`), where exact token matching is 100% reliable. The goal is hybrid synergy, not dense replacement.

---

## 3. Decisions A–L

| # | Question | Verdict | Technical Specification |
|---|---|---|---|
| **A** | **What quantitative evidence is required to say dense retrieval adds meaningful value beyond DS-QA-006?** | **Demonstrated recall recovery of lexical `NOT_RETRIEVED` failures on both diagnostic and held-out sets without degrading baseline Hit@5.** | Quantitative requirement: (1) Candidate pool recall@20 $\ge 80\%$ on diagnostic `NOT_RETRIEVED` cases; (2) Top-5 hybrid rank recovery $\ge 60\%$ (3 of 5) on diagnostic `NOT_RETRIEVED`; (3) Held-out Mamba Hit@5 improvement from 57.1% to $\ge 71.4\%$; (4) Zero regressions out of top-5 on the 25 passing baseline queries. |
| **B** | **How many current `NOT_RETRIEVED` gold cases must dense/hybrid recover?** | **$\ge 4$ of 5 into candidate pool; $\ge 3$ of 5 into Top-5.** | Dense-only or hybrid candidate pool (@20) must recover at least 4 of 5 (80%). Hybrid Top-5 ranking must place at least 3 of 5 (60%) into the top five. Specifically, Chinese cross-language queries against English papers must be retrieved without requiring an LLM rewrite call. |
| **C** | **What held-out Hit@K / first-gold-rank improvement is required?** | **Held-out Mamba Hit@5 $\ge 71.4\%$ ($\ge 10/14$), Hit@1 $\ge 50.0\%$ ($\ge 7/14$).** | Baseline on Mamba is Hit@5 = 57.1% (8/14) and Hit@1 = 35.7% (5/14). Hybrid retrieval must recover at least 2 of the 3 unretrieved cross-language questions into Top-5, with 0 regressions on the 8 passing questions. Mean Reciprocal Rank (MRR) must improve by $\ge +0.10$. |
| **D** | **How much end-to-end reduction in avoidable abstention is required?** | **$\ge 75\%$ reduction in avoidable cross-language abstention.** | When the local-first path runs without an external LLM rewrite provider, lexical retrieval currently yields 0 hits and forces 100% abstention (`INSUFFICIENT_EVIDENCE`) on Chinese queries against English papers. Hybrid retrieval must supply grounded evidence allowing valid answers for $\ge 75\%$ of answerable cross-language queries. |
| **E** | **What false-supported-answer rate is acceptable?** | **Strictly 0.0% (Zero tolerance).** | 16/16 unanswerable questions must continue to abstain (`INSUFFICIENT_EVIDENCE`). 0 false supported answers. Dense retrieval must not return "topically loose" text that induces hallucinations. Every cited claim must be mechanically grounded in the cited paragraph. |
| **F** | **What latency / storage / model-size ceiling is acceptable for production adoption?** | **Query latency $\le 50$ ms p95; build latency $\le 15$ s / 150 chunks; storage $\le 200$ MB model, $\le 1$ MB/doc.** | Measured on local CPU (AVX2): (1) Query embedding + dense search + RRF fusion $\le 50$ ms p95; (2) Cold document embedding $\le 15$ s for 150 chunks, $\le 30$ s for 300 chunks; (3) Cached document search $\le 50$ ms (0 ms embedding); (4) Model on disk $\le 200$ MB (quantized int8) or $\le 500$ MB (fp32); (5) Resident RAM $\le 300$ MB; (6) Per-document vectors $\le 1$ MB. |
| **G** | **Must the embedding model be multilingual?** | **YES, non-negotiable.** | 4 of the 5 diagnostic `NOT_RETRIEVED` queries and 3 of the 4 held-out Mamba `NOT_RETRIEVED` queries are cross-language (Chinese user query against English academic text). An English-only model (e.g. `all-MiniLM-L6-v2`) fails by construction due to tokenization fragmentation and disjoint semantic space. A multilingual model with cross-lingual alignment (e.g. `multilingual-e5-small`) is mandatory. |
| **H** | **Should dense retrieval run on every Whole Paper query, only as fallback, or another strategy?** | **Experiment: evaluate 3 arms. Production recommendation: Always-on hybrid for Whole Paper and Section scopes; bypass for Selection.** | In the experiment, all 3 arms (Lexical, Dense, Hybrid) must be measured. For production: Always-on hybrid RRF fusion on Whole Paper and Section queries is recommended because lexical failures include English synonyms (which cannot be predicted by script mismatch) and dense CPU latency ($\sim 20$ ms) is trivial. Selection scope bypasses dense retrieval entirely. |
| **I** | **Should the experiment embed ParagraphIR only, ParagraphIR + captions, or all indexed blocks?** | **Embed ParagraphIR + Captions (with prepended Section Titles).** | Captions are first-class evidence (answering figure/table questions). Embedding units must strictly mirror FTS5 chunks (`chunks` table: paragraphs and figure/table captions). Section titles must be prepended (`"{section_title}\n{text}"`) to provide contextual grounding. Raw layout blocks (headers, footers, abandon) must NOT be embedded. |
| **J** | **How should lexical and dense rankings be fused?** | **Reciprocal Rank Fusion (RRF, $k=60$) treated as independent ranked query variants.** | Dense retrieval outputs a ranked list of chunk IDs ordered by cosine similarity. This list is passed to `fuse()` as an additional variant (e.g. `dense:0`). RRF combines ordinal ranks without requiring score normalization between BM25 and cosine distance. Coverage reranking applies on top. |
| **K** | **If the experiment succeeds, is a vector database actually needed for documents of the current size?** | **NO. A vector database is architecturally rejected.** | A document contains 50–300 chunks. Matrix multiplication of $1 \times 384$ against $300 \times 384$ in NumPy takes $< 0.1$ ms. Vector databases introduce external processes, network overhead, and complex maintenance without any performance or scalability advantage at document-copilot scale. |
| **L** | **Can production use SQLite/file-backed embeddings or in-memory vectors instead?** | **YES. SQLite BLOB column or flat binary file (`embeddings.npy`) in the document directory.** | Embeddings must be persisted in the per-document directory (`<documents_dir>/<document_id>/`). Storing vectors as raw bytes in SQLite (`search.db` table `embeddings`) or beside it as `embeddings.npy` provides 100% document isolation, zero cross-document leakage, and instant memory-mapped or buffered loading. |

---

## 4. Architecture & experiment design

### 4.1 System architecture

```
[Document Ingestion]
      │
      ▼
Canonical DocumentIR  ──►  FTS5 Lexical Index (search.db)
      │
      ▼
Text Preparation (Paragraphs + Captions + Section Titles)
      │
      ▼
Local ONNX Runtime Embedding Model (CPU, AVX2)
      │
      ▼
Document Vectors Cache (<documents_dir>/<document_id>/search.db or embeddings.npy)
```

```
[User Query]
      │
      ├───────────────────────────────┬───────────────────────────────┐
      ▼                               ▼                               ▼
[Arm A: Lexical Pipeline]    [Arm B: Dense Pipeline]        [Arm C: Hybrid Pipeline]
  - Query expansion            - Format: "query: {text}"      - Runs Arm A & Arm B
  - FTS5 BM25 per variant      - ONNX embedding (1x384)       - RRF (k=60) rank fusion
  - Depth: 20/variant          - Exact cosine sim (NumPy)     - Coverage boost (α=0.05)
  - Output: Ranked Chunks      - Depth: 20 candidates         - Output: Combined Bundle
                               - Output: Ranked Chunks
```

### 4.2 Candidate embedding model specification

- **Model Identifier:** `intfloat/multilingual-e5-small`
- **Architecture:** XLM-RoBERTa backbone, 12 layers, hidden dimension $D = 384$.
- **License:** MIT License (Permissive commercial and research use).
- **Execution Engine:** `onnxruntime` with `CPUExecutionProvider` on AVX2-enabled CPU (no AVX-512 dependency).
- **Quantization:** Dynamic int8 quantization (`quantize_dynamic` targeting AVX2) or optimized fp32 ONNX.
- **Input Formatting Convention (Mandatory for E5):**
  - Query: `"query: " + query_text.strip()`
  - Passage / Chunk: `"passage: " + (f"{section_title}\n" if section_title else "") + chunk_text.strip()`
- **Pooling & Normalization:** Mean pooling over non-padding tokens, followed by $L_2$ vector normalization:
  $$\mathbf{v}_{\text{norm}} = \frac{\mathbf{v}}{\|\mathbf{v}\|_2}$$
- **Similarity Metric:** Inner product of $L_2$-normalized vectors (mathematically identical to cosine similarity):
  $$\text{sim}(\mathbf{q}, \mathbf{d}) = \mathbf{q}_{\text{norm}} \cdot \mathbf{d}_{\text{norm}}$$

---

## 5. The two independent gates

The gates are completely decoupled. The experiment can pass Gate 1 and fail Gate 2.

```
                  ┌───────────────────────────────┐
                  │    DS-QA-007 Experiment       │
                  └───────────────┬───────────────┘
                                  │
                                  ▼
                  ┌───────────────────────────────┐
                  │  GATE 1: EXPERIMENT SUCCESS   │
                  │  (Scientific Rigor & Proof)   │
                  └───────┬───────────────┬───────┘
                          │               │
                     FAIL │               │ PASS
                          ▼               ▼
                     [INVALID]   Is Semantic Retrieval
                                 Justified for Prod?
                                          │
                                 ┌────────┴────────┐
                              NO │                 │ YES
                                 ▼                 ▼
                          [GATE 2: FAIL]    [GATE 2: PASS]
                          "Not Worth It"    "Adopt in Prod"
```

### Gate 1: Experiment Success Gate (Scientific Validity)
*A result of "semantic retrieval is not worth adopting" can pass this gate.*
To pass Gate 1, the experiment must:
1. Accurately reproduce the DS-QA-006 lexical baseline on commit `80c753c`.
2. Measure and record all three arms (Lexical, Dense, Hybrid) over both the 33-question diagnostic set and the 14-question fresh held-out Mamba set.
3. Quantify candidate-pool recall@20 and recall@50 for all 5 diagnostic `NOT_RETRIEVED` cases and all 4 Mamba `NOT_RETRIEVED` cases.
4. Execute 100% locally on CPU without external services, vector databases, or GPU requirements.
5. Record complete diagnostic artifacts (`gate_experiment.json`, latency profiles, memory footprints) in the qa/ run log.

### Gate 2: Production Adoption Gate (Readiness to Enter Default QA Path)
*Requires unambiguous value addition over DS-QA-006.*
To pass Gate 2, hybrid retrieval must satisfy:
1. **NOT_RETRIEVED Recovery:** Recovers $\ge 4$ of the 5 diagnostic `NOT_RETRIEVED` cases into the candidate pool (@20), and $\ge 3$ of 5 into Top-5.
2. **Held-Out Generalization:** Lifts Mamba Hit@5 from 57.1% to $\ge 71.4\%$ ($\ge 10/14$), lifting at least 2 cross-language queries into Top-5.
3. **Zero Regression Floor:** Exactly 0 regressions out of Top-5 on the 25 passing baseline queries in the diagnostic suite, and 0 regressions on the 8 passing Mamba queries.
4. **Grounding Safety:** 16/16 unanswerable questions abstain; 0 false supported answers; 100% citation validity.
5. **Production Budgets:** Query latency $\le 50$ ms p95 (CPU); cold index build $\le 15$ s for 150 chunks; model size $\le 200$ MB (int8) or $\le 500$ MB (fp32); zero vector database.

---

## 6. Criteria

### P0 — Non-negotiable correctness, safety, isolation, and experiment integrity

- **AC-P0-01 Exact reproduction of DS-QA-006 lexical baseline.**
  Under configuration `scope=whole_paper`, `top_k=10`, local lexical retrieval on commit `80c753c` must reproduce the frozen numbers:
  Hit@1 = 54.5% (18/33), Hit@3 = 69.7% (23/33), Hit@5 = 75.8% (25/33), Hit@10 = 84.8% (28/33), exactly 5 `NOT_RETRIEVED` cases, and 0 regressions.
- **AC-P0-02 Three-arm comparative evaluation protocol.**
  The experiment harness must evaluate three distinct arms over identical document chunks:
  - **Arm A (Lexical baseline):** FTS5 BM25 multi-variant retrieval + RRF ($k=60$) + term coverage ($\alpha=0.05$).
  - **Arm B (Dense only):** Local ONNX embedding + cosine similarity ranking.
  - **Arm C (Hybrid):** RRF ($k=60$) fusion of Arm A variants and Arm B dense ranking + term coverage ($\alpha=0.05$).
- **AC-P0-03 Zero regression floor on baseline passing queries.**
  In Arm C (Hybrid), all 25 queries that achieved rank $\le 5$ in the DS-QA-006 baseline must remain at rank $\le 5$. Regressions == 0.
- **AC-P0-04 Canonical source identity preservation.**
  Retrieval identity must strictly remain `chunk_id` / `paragraph_id` from `DocumentIR`. Dense retrieval must never return abstract vectors or synthetic text. Two paragraphs with identical text or embeddings must preserve distinct chunk IDs, section IDs, page numbers, and bounding boxes.
- **AC-P0-05 Strict scope invariance & selection bypass.**
  Dense retrieval must respect active `Scope`:
  - `page`: Cosine similarity scored only against chunks whose `page_range` contains the target page.
  - `section`: Scored only against chunks where `section_id == target_section_id`.
  - `selection`: Dense retrieval and lexical search are **completely bypassed**; selected paragraphs are returned in document reading order.
  - `whole_paper`: Scored against all in-document chunks.
- **AC-P0-06 Strict cross-document isolation.**
  Embeddings for document A must be stored strictly within document A's local directory (`<documents_dir>/<doc_id>/`). A query executed against document A must have no programmatic or filesystem access to document B's vectors or index.
- **AC-P0-07 Grounding and abstention safety floor.**
  On the 16-question unanswerable negative benchmark, hybrid retrieval must maintain 16/16 correct abstentions (`INSUFFICIENT_EVIDENCE`), 0 false supported answers, and 0 citation fabrications.
- **AC-P0-08 Citation structural validity & bbox identity.**
  All citations generated from dense or hybrid retrieval must resolve to concrete `ResolvedCitation` objects with 100% valid 1-based `page_number`, valid `block_ids`, non-empty `bboxes` ($[x0, y0, x1, y1]$), and verbatim text snippets from `DocumentIR`.
- **AC-P0-09 Score-independent rank fusion (No direct score mixing).**
  Hybrid fusion must use Reciprocal Rank Fusion (RRF) or ordinal rank aggregation. Direct linear combination or summation of raw BM25 scores with cosine similarity scores ($\text{BM25} + \beta \cdot \text{sim}$) without rigorous statistical calibration is strictly forbidden.
- **AC-P0-10 Local CPU execution & zero vector database.**
  Dense embedding inference and similarity search must run 100% locally on CPU (`CPUExecutionProvider`). No external vector database service (Qdrant, Chroma, Milvus, etc.), external vector daemon, GPU requirement, or remote embedding API call is permitted.
- **AC-P0-11 Production serving path invariance during experiment.**
  Production code in `app/qa/retrieval.py` and `app/qa/answering.py` must retain default lexical behavior during the experiment. Experimental dense/hybrid code must be guarded behind an explicit parameter or executed via offline benchmark harnesses until Gate 2 is formally frozen.
- **AC-P0-12 Zero benchmark hardcoding & clean artifact isolation.**
  No query string, benchmark gold phrase, or document ID may appear in executed production code. All experimental scripts, temporary caches, and diagnostic outputs must be written to the qa/ run log (gitignored) or OS temp, leaving `backend/` tracked files clean.

---

### P1 — Performance, thresholds, resource ceilings, and specifications

- **AC-P1-01 Diagnostic NOT_RETRIEVED recovery thresholds.**
  Measured on the 5 diagnostic `NOT_RETRIEVED` cases:
  - Dense candidate pool (@20) must recover $\ge 4$ of 5 ($\ge 80\%$).
  - Arm C (Hybrid) must place $\ge 3$ of 5 ($\ge 60\%$) into the Top 5 direct hits ($rank \le 5$).
- **AC-P1-02 Held-out Mamba generalization thresholds.**
  Measured on the 14-question held-out Mamba benchmark (`heldout_mamba.py`, baseline Hit@5 = 57.1%):
  - Arm C (Hybrid) Hit@5 must reach $\ge 71.4\%$ ($\ge 10/14$).
  - Arm C (Hybrid) Hit@1 must reach $\ge 50.0\%$ ($\ge 7/14$).
  - At least 2 of the 3 unretrieved cross-language questions must enter the Top 5.
  - Regressions on the 8 passing Mamba baseline queries == 0.
- **AC-P1-03 Exact-term and technical query preservation.**
  On exact-term queries containing technical tokens (`ResNet-50`, `Algorithm 1`, `Figure 3`, `Eq. 4`, `CIFAR-10`), Arm C (Hybrid) must rank the gold paragraph in Top 1 ($rank = 1$) or identical to the lexical baseline. Dense similarity must not demote exact identifier hits.
- **AC-P1-04 Embedding model format and AVX2 compatibility.**
  The embedding model must be `intfloat/multilingual-e5-small` in ONNX format. It must execute successfully under AVX2 without requiring AVX512-VNNI instructions. Query and passage text must strictly adhere to the `"query: "` and `"passage: "` prefix conventions.
- **AC-P1-05 Latency ceilings (Production Adoption Gate).**
  Measured on Intel Core Ultra 9 285H (or equivalent modern client CPU, single thread / 4 threads CPUExecutionProvider):
  - Query latency: Query embedding + vector dot product + RRF fusion $\le 50$ ms p95 (over $\le 300$ candidate chunks).
  - Cold document index build: $\le 15$ seconds for papers with $\le 150$ chunks; $\le 30$ seconds for papers with $\le 300$ chunks (batch size $\ge 16$).
  - Cached document startup: 0 ms embedding time; vector cache load from disk $\le 20$ ms.
- **AC-P1-06 Storage and memory footprints (Production Adoption Gate).**
  - Embedding model disk footprint $\le 200$ MB (quantized int8) or $\le 500$ MB (fp32).
  - Per-document vector storage on disk $\le 1.0$ MB (for up to 500 chunks).
  - Resident memory (RAM) overhead of the embedding runtime during inference $\le 300$ MB.
- **AC-P1-07 Minimal dependency boundary.**
  No heavyweight dependencies (such as `torch`, `transformers`, or `sentence-transformers`) may be added to `backend/pyproject.toml`. If exact XLM-RoBERTa tokenization requires `tokenizers`, it must be declared explicitly as a single minimal rust-backed dependency, maintaining the AC-11 minimal-dependency policy.

---

### P2 — Telemetry, diagnostics, and operational observability

- **AC-P2-01 Diagnostics telemetry and attribution.**
  `Diagnostics` in `EvidenceBundle` must report:
  - `dense_candidates_scored: int`
  - `dense_latency_ms: float`
  - `ranking_strategy: str` (e.g. `"rrf_coverage_hybrid"`)
  - Per-item provenance indicating whether an item was retrieved by lexical only, dense only, or both.
  - Zero leakage of raw document text in log envelopes.
- **AC-P2-02 In-memory document vector cache.**
  If a document is queried repeatedly within an active session, document vectors must remain memory-resident in a lightweight LRU cache (capped at 3 active documents), eliminating disk I/O on repeated queries.

---

## 7. Verification protocol

### 7.1 Baseline reproduction test
Execute:
```powershell
backend\.venv\Scripts\python.exe .agent\results\qa\gate_check.py
```
**Assertion:** Output matches DS-QA-006 exactly: Hit@1 = 54.5%, Hit@3 = 69.7%, Hit@5 = 75.8% (25/33), Hit@10 = 84.8%, LOW_RANK lifted = 4/7, regressions = 0.

### 7.2 Three-arm experiment execution
Execute:
```powershell
backend\.venv\Scripts\python.exe .agent\results\qa\run_experiment_arms.py
```
**Assertion:** Records `experiment_results.json` comparing Arm A (Lexical), Arm B (Dense), and Arm C (Hybrid) across:
1. The 33 diagnostic questions (ResNet, Diffusion Policy, PPO).
2. The 14 held-out Mamba questions (`heldout_mamba.py`).
3. Evaluates Candidate Pool Recall@20 and Hit@1/3/5/10 for each arm.

### 7.3 Grounding safety and unanswerable verification
Execute:
```powershell
backend\.venv\Scripts\python.exe .agent\results\qa\qa_benchmark.py
```
**Assertion:** 16/16 unanswerable questions return `status == "insufficient_evidence"`, 0 false supported answers, and 0 dropped or hallucinated citations.

### 7.4 Latency and resource profiling
Execute:
```powershell
backend\.venv\Scripts\python.exe .agent\results\qa\profile_dense.py
```
**Assertion:** Evaluates query latency ($\le 50$ ms p95), document indexing time ($\le 15$ s for 150 chunks), model disk size ($\le 200$ MB int8 / $\le 500$ MB fp32), and per-document vector storage ($\le 1$ MB).

### 7.5 End-to-end browser verification
Execute:
```bash
node frontend/scripts/e2e-qa.mjs
```
**Assertion:** Against a live backend with hybrid retrieval enabled:
1. Chinese query against English paper retrieves top-ranked evidence.
2. Answering model produces grounded response with inline citation markers `[E1]`.
3. Clicking citation marker smoothly scrolls PDF viewer to the exact bounding box on the original page.
4. Zero frontend or console errors.
