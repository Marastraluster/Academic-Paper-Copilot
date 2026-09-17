# Acceptance Criteria: DS-CTX-003 Context Effectiveness & Translation-Unit Mapping Benchmark

**Target:** Verification of Context-Aware Translation Value & Unit Mapper Integrity  
**Role:** Independent Acceptance Criteria Author  
**Scope:** Measurement & Benchmarking Only — *No production code, no UI, no Paper QA, no Context Engine redesign prior to baseline quantification.*

---

## 1. P0 Criteria (Mandatory & Objectively Verifiable)

### P0-1: Categorical Mapping Coverage & Granular Segmentation Audit
* **Criterion:** The benchmark suite MUST evaluate and report mapping resolution not as a single global percentage, but partitioned across structural block types, page positions, and document layout types.
  * **Structural Block Types:** `PROSE`, `HEADING`, `CAPTION`, `TABLE_CELL`, `FORMULA_STANDALONE`, `REFERENCE_ENTRY`.
  * **Categorical Metric:**
    $$\text{Coverage}_{\text{type}} = \frac{\text{Resolved Units of Type}}{\text{Total Upstream Units of Type}}$$
  * **Observable Output:** A machine-readable benchmark report (`benchmark_mapping_coverage.json`) and summary table breaking down total units, resolved count, and coverage percentage for each block type.
* **Rationale:** A global 68% is uninterpretable. If 100% of references and table cells are rejected while 95% of body prose is resolved, the mapper is working nearly perfectly. If 40% of body prose is dropped, paragraph-level context is non-viable.

### P0-2: Deterministic Failure Taxonomy Classification
* **Criterion:** 100% of unresolved translation units in the benchmark evaluation MUST be programmatically classified into mutually exclusive root-cause buckets matching the exact taxonomy:
  1. `UNIT_TOO_SHORT` (length < 40 chars)
  2. `NON_PROSE_REGION` (reference, header, footer, page number, lone equation)
  3. `NORMALIZATION_HYPHENATION` (cross-line hyphenation / whitespace discrepancy)
  4. `UPSTREAM_MERGED` (one translation unit spans $\ge 2$ IR paragraphs)
  5. `UPSTREAM_SPLIT` (one IR paragraph spans $\ge 2$ translation units)
  6. `FORMULA_PLACEHOLDER_MISMATCH` (`{vN}` token count or positional divergence)
  7. `DUPLICATE_SOURCE_TEXT` (identical text blocks causing score ties $\ge 0.80$)
  8. `NO_IR_CORRESPONDENCE` (artifact of OCR/layout extraction absent from DocumentIR)
  9. `BELOW_SCORE_THRESHOLD` (best match score $< 0.80$ despite length $\ge 40$)
* **Rationale:** Optimizing the mapper without knowing whether failures are upstream layout segmentation mismatches, short string rejections, or whitespace normalization issues risks loosening string-matching thresholds inappropriately.

### P0-3: Anti-Loosening & Structural Safety Invariants
* **Criterion:** Under no circumstance shall coverage be increased by relaxing spatial boundaries or lowering strict match thresholds. Specifically:
  1. **Strict Page Boundary:** Units MUST NEVER match an IR paragraph on a different page.
  2. **No Nearest-Neighbor Heuristics:** If string similarity falls below 0.80, the mapper MUST NOT attach the "nearest" or "adjacent" paragraph.
  3. **Categorical Confidence:** Every mapping resolution MUST emit a discrete enum tag: `EXACT` (1.0 substring), `NORMALIZED` (score $\ge 0.80$), `GEOMETRIC` (bounding-box enclosure, if metadata provided), `FALLBACK` (document-only), or `UNMAPPED`. No uncalibrated continuous decimal floats may act as context-injection gates.
* **Rationale:** Attaching incorrect context (e.g., injecting paragraph $K$'s terminology and neighbors into unrelated paragraph $M$) causes neighbor contamination, hallucination, and wrong glossary enforcement. Low coverage with clean context is strictly superior to high coverage with noisy context.

### P0-4: Domain-Ambiguous Benchmark Paper Dataset
* **Criterion:** The evaluation benchmark MUST be executed against a verified open-access paper rich in polysemous and domain-dependent academic terminology (e.g., embodied AI, reinforcement learning, control theory, or state-space models).
  * **Disqualification:** ResNet-152 (He et al., 2015) is explicitly disqualified as the primary benchmark dataset due to severe pretraining bias (LLMs already output `残差学习` / `恒等映射` with zero context).
  * **Target Vocabulary:** The paper MUST contain at least 10 unique instances across 5 core ambiguous terms whose correct technical translation in context differs from general prose translation (e.g., `policy` $\rightarrow$ 策略 vs 政策/方针; `state` $\rightarrow$ 状态 vs 声明/州; `action` $\rightarrow$ 动作 vs 行动; `rollout` $\rightarrow$ 轨迹采样/展开 vs 推出; `reward` $\rightarrow$ 奖励 vs 报酬; `agent` $\rightarrow$ 智能体 vs 代理人).
  * **Provider Invariant:** Benchmark MUST use the configured `deepseek-flash` provider. No paid external endpoints may be added.
* **Rationale:** Context-aware translation costs ~2x prompt tokens. It must be tested where context is actually necessary to resolve semantic ambiguity.

### P0-5: Repeated-Run Stability Protocol (N $\ge$ 3)
* **Criterion:** Every evaluated translation unit in the test subset MUST undergo at least three ($N=3$) independent execution passes under identical temperature, model, and system configuration.
  * **Evaluation Object:** Stability is measured on the **decision classification** (`BETTER`, `SAME`, `WORSE`), NOT exact lexical string identity.
  * **Stability Metric:**
    $$\text{Stability Rate} = \frac{\text{Units with Identical Classification across all 3 Runs}}{\text{Total Evaluated Units}}$$
  * **Acceptance Threshold:** At least 80% of evaluated units must exhibit unanimous classification across all 3 runs ($3/3$ BETTER, $3/3$ SAME, or $3/3$ WORSE). If $>20\%$ of units flip between BETTER and WORSE across identical runs, the evaluation run MUST be marked `UNSTABLE_EVIDENCE`.
* **Rationale:** The prior benchmark swung from 1-of-7 to 4-of-5 better. An unrepeatable benchmark cannot justify architectural defaults.

### P0-6: Bidirectional Quality & Active Harm Quantification
* **Criterion:** The benchmark MUST actively search for and tally translation degradations introduced by context. It is strictly forbidden to report only improvements.
  * **Harm Taxonomy:** Every evaluation pair must be audited for:
    1. `WRONG_GLOSSARY`: Injecting a term override that is locally incorrect.
    2. `NEIGHBOR_CONTAMINATION`: Injecting tokens, identifiers, or facts from adjacent paragraphs into the target unit.
    3. `SECTION_CONTAMINATION`: Forcing section-summary phrasing into standalone statements.
    4. `OVERTRANSLATION`: Translating code identifiers, dataset acronyms, or math variables.
    5. `CONTEXT_LEAKAGE`: Prompt sentinels or context framing text appearing in target translation.
  * **Net Gain Metric:**
    $$\text{Net Context Value} = \frac{N_{\text{BETTER}} - N_{\text{WORSE}}}{N_{\text{TOTAL}}}$$
  * **Acceptance Floor:** For Standard mode to be viable, the harm ratio must satisfy:
    $$\frac{N_{\text{WORSE}}}{N_{\text{BETTER}}} < 0.15 \quad (\text{fewer than 1 regression per 6.7 improvements})$$
* **Rationale:** A feature that improves 8 units but damages 4 creates negative user trust; in academic reading, an inaccurate or hallucinated term is far more costly than an un-optimized literal translation.

### P0-7: Cost & Latency Accounting Breakdown
* **Criterion:** The benchmark suite MUST measure and report the full systemic overhead of Context-Aware Translation:
  * **Tokens:** Mean Prompt Tokens, Mean Completion Tokens, and Mean Context Token Multiplier ($T_{\text{prompt, Standard}} / T_{\text{prompt, Off}}$).
  * **Latency:** Mean per-unit wall-clock latency (ms) and P95 latency.
  * **Cold vs. Cached Execution:** Benchmark MUST separate:
    1. *First Run (Cold):* Wall-clock time including `DocumentAnalysis` IR extraction + cold LLM translation.
    2. *Warm Run (Cached Context):* Translation latency when `DocumentAnalysis` results are pre-computed in cache.
* **Rationale:** Recommending Standard as default requires transparently documenting whether the user is paying a 100% token penalty and significant startup latency for marginal semantic gains.

### P0-8: Deterministic Four-Way Decision Mapping
* **Criterion:** The benchmark conclusion MUST deterministically map to exactly one of the four predefined outcomes using quantitative thresholds:
  * **Decision A (`STANDARD RECOMMENDED`):**
    * Prose mapping coverage $\ge 85\%$, AND
    * Net Context Value $\ge +15\%$ on ambiguous terminology, AND
    * Classification Stability $\ge 80\%$, AND
    * Harm Ratio $N_{\text{WORSE}} / N_{\text{BETTER}} < 0.10$.
  * **Decision B (`STANDARD OPTIONAL`):**
    * Prose mapping coverage $\ge 75\%$, AND
    * Net Context Value $> 0\%$ (statistically positive), AND
    * Harm Ratio $< 0.20$, BUT
    * Token multiplier $\ge 1.7\times$ OR gains are concentrated only in specific technical sub-disciplines.
  * **Decision C (`CONTEXT NOT YET JUSTIFIED`):**
    * Prose mapping coverage $\ge 75\%$, BUT
    * Net Context Value $\le 0\%$ OR Classification Stability $< 70\%$ OR Harm Ratio $\ge 0.20$.
  * **Decision D (`MAPPING BOTTLENECK`):**
    * Prose mapping coverage $< 75\%$, preventing a statistically reliable determination of context effectiveness on continuous prose.
* **Rationale:** Prevents subjective post-hoc rationalization. "Standard" cannot be crowned default simply because effort was invested in building it.

### P0-9: Safety Machinery Regression Verification
* **Criterion:** The benchmark harness MUST verify zero regressions against existing safety and caching machinery:
  1. **Formula Preservation:** Multiset equivalence of `{vN}` placeholders between source and translation must remain 100%. If multiset verification fails, fallback to source text must trigger deterministically.
  2. **Cache Key Isolation:** The per-unit cache key MUST contain the effective context hash and exclude API keys. Identical source units with different injected contexts MUST produce cache misses.
  3. **Thread Concurrency:** 4 concurrent worker threads sharing a single translator instance must execute without context cross-talk (thread-local context verified via canary injection in test assertions).
  4. **Immutability:** Source PDF text and DocumentIR instances MUST be cryptographically verified as unmodified before and after mapping.
* **Rationale:** Measuring context effectiveness must not destabilize core data integrity or cache correctness.

---

## 2. P1 Criteria (Deferrable with Stated Reason)

### P1-1: Multi-Paper Cross-Domain Validation Suite
* **Criterion:** Execute the benchmark across 3 distinct academic subfields (e.g., 1 Robotics/Control, 1 Math/SSM, 1 Multimodal/NLP) and 2 different layout structures (IEEE double-column vs. arXiv single-column).
* **Deferral Rationale:** P0 requires establishing the measurement methodology and answering the core questions on one verified ambiguous paper first. Broad cross-domain profiling is valuable for generalizability but would delay identifying whether the mapper is fundamentally broken.

### P1-2: Upstream Geometric Metadata Passing (Bounding Box & Page ID)
* **Criterion:** Extend the upstream caller of `translate(self, text)` to supply `TranslationUnitMetadata(page_number, bbox, upstream_block_id)` to enable geometric enclosure matching against DocumentIR paragraphs.
* **Deferral Rationale:** Modifying upstream translation signatures touches reader/translator contracts. P0 must first measure whether the existing text-only mapper is truly the bottleneck on prose before modifying upstream pipeline interfaces.

### P1-3: Automated LLM-as-a-Judge Evaluation Calibration
* **Criterion:** Implement a calibrated, dual-prompt LLM judge harness to automate the classification of `BETTER / SAME / WORSE` against human expert ground truth on 50 sampled units.
* **Deferral Rationale:** For the initial 1-paper benchmark, manual human/expert verification of classifications ensures ground-truth reliability without introducing LLM-judge bias or evaluator prompt variance.

---

## 3. P2 Criteria (Polish & Usability)

### P2-1: Visual Mapping Diagnostic Overlay
* **Criterion:** Generate an HTML/SVG debug visualization displaying the PDF page with bounding boxes colored by mapping status: Green (`EXACT`), Blue (`NORMALIZED`), Orange (`FALLBACK`), Red (`UNMAPPED`).
* **Rationale:** Helpful for developer ergonomics when diagnosing spatial segmentation discrepancies, but has zero impact on numeric benchmark validity.

### P2-2: Benchmark CLI Interactive Summary
* **Criterion:** A standalone CLI command (`agy benchmark context-eval`) that formats the benchmark output into a terminal table with progress bars, token expenditure gauges, and color-coded decision banners.
* **Rationale:** Convenience tooling; standard machine-readable JSON artifacts suffice for acceptance verification.

---

## 4. Explicitly Not Applicable (Out of Scope)

1. **Paper QA / Chatbot Capabilities:** The scope is strictly translation-unit mapping and context-aware translation effectiveness. No document-level Q&A or RAG chat flows are to be measured or touched.
2. **Frontend UI Integration / Toggles:** No settings screens, switches, or visual indicators in the reader UI are to be implemented or modified during this task.
3. **Context Engine Algorithmic Redesign:** No new summarization models, alternative embedding retrievers, or prompt engineering overhauls. The existing `ContextBuilder` must be evaluated as it currently operates.
4. **Third-Party Paid Model Testing:** The benchmark MUST NOT use paid commercial endpoints (OpenAI GPT-4o, Anthropic Claude 3.5 Sonnet). It is strictly scoped to the system's target model (`deepseek-flash`).
5. **OCR / Layout Model Retraining:** Upstream PDF segmentation quirks must be mapped or compensated for downstream; replacing or retraining the underlying layout engine is out of scope.

---

## 5. Direct Answers to the Core Questions

### Question 1: What mapping coverage is sufficient before paragraph-level contextual translation can be considered representative?

#### Direct Answer:
**$\ge 85\%$ coverage on Body Prose (`PROSE` block type), with $\ge 80\%$ sequence continuity across adjacent prose units.** Aggregate document coverage across all regions is the wrong metric and should be ignored.

#### Reasoning:
1. **The Denominator Fallacy:** A 12-page paper typically has 25–35% of its visual units in non-prose categories: section titles, table cells, inline/display math fragments, figure captions, author affiliations, and bibliography entries. These units *should not* receive paragraph-level neighbor context—doing so actively causes hallucinations and neighbor contamination. Therefore, an aggregate coverage of 68% might already represent $\sim 90\%$ coverage of actual prose.
2. **Why 85% for Prose:** In academic papers, discourse coherence and technical argument flow occur across contiguous paragraphs. If prose coverage is below 85%, neighbor context chains break: paragraph $N+1$ cannot retrieve paragraph $N$ as its preceding neighbor. A 15% missing rate leaves occasional isolated gaps, but anything below 85% causes systemic fragmentation of the context window.
3. **Sequence Continuity Requirement:** Even with 85% coverage, if every third paragraph is unmapped in an alternating pattern, 0% of units receive valid two-sided neighbor context ($N-1$ and $N+1$). Therefore, representative coverage requires that at least 80% of adjacent prose pairs $(N, N+1)$ are both successfully mapped.

---

### Question 2: Should unmatched translation units receive document-level fallback, section-level fallback, or Off-mode translation?

#### Direct Answer:
**Unmatched units should receive Off-mode translation (zero context) by default. Document-level fallback should be strictly restricted or eliminated for unmapped units.** Section-level fallback is currently architecturally impossible and should not be attempted until geometric metadata is passed from upstream.

#### Reasoning:
1. **The Asymmetry of Harm vs. Benefit in Document Fallback:**
   * An unmatched unit is usually a fragment: a table cell ("Accuracy (%)"), a short heading ("3. Methodology"), an isolated variable definition, or an orphaned line split by layout parsing.
   * Injecting a 250-word global document summary and domain taxonomy into the prompt of a 5-word text fragment creates extreme prompt asymmetry. LLMs frequently suffer from **context leakage** and **overtranslation** in this regime—interpreting a simple table header through the lens of the paper's overarching thesis, or hallucinating descriptive prose.
   * Furthermore, document-level fallback charges double the token cost for a unit where global context provides zero disambiguation value.
2. **Off-Mode as the Safe, Economical Default:**
   * Falling back to Off-mode translation eliminates prompt token waste and prevents hallucination/leakage on fragments.
   * If a unit cannot be grounded in its local paragraph, translating it literally as an isolated segment is safer and matches user expectations for short snippets and table entries.
3. **The Section-Level Fallback Reality Check:**
   * In the current codebase, `translate(self, text)` receives only a raw Python string. Sections exist solely as nodes in `DocumentIR`, linked to paragraphs. There is no direct string-to-section index.
   * To enable section-level fallback for a unit that fails paragraph string matching, **upstream must pass the unit's page number and bounding box coordinates**. Only then could the system perform a spatial point-in-polygon query against the section's bounding envelope in DocumentIR. Because this spatial metadata is not currently delivered to the mapper, section-level fallback is architecturally impossible today. Demanding it without changing the upstream call signature is a phantom requirement.

---

## 6. Challenged Premises & Architectural Methodological Risks

### Premise 1: "The mapper algorithm can achieve high coverage relying strictly on text normalization and token overlap."
* **Challenge:** **False.** Upstream translation units are generated by visual layout segmentation (grouping contiguous text bounding boxes on a page). DocumentIR paragraphs are formed by semantic prose continuation logic. When a paragraph breaks across a column or wraps around a floating figure, the visual layout detector frequently segments it into 2 or 3 translation units.
* A token-overlap threshold ($\ge 0.80$) applied to a split half-paragraph will fail because $\text{len}(\text{unit}) < \text{len}(\text{para})$ and token coverage drops below the substring threshold. Attempting to solve this by lowering the score threshold below 0.80 will cause catastrophic false-positive collisions on short sentences.
* **Architectural Reality:** High prose mapping coverage cannot be achieved purely via string gymnastics in `unit_mapper.py`. Upstream must pass the visual bounding box and page number so that split units can be geometrically mapped to the enclosing IR paragraph.

### Premise 2: "Counting term frequency improvements (e.g., `shortcut connection 8 -> 11 BETTER`) measures context effectiveness."
* **Challenge:** **Flawed methodology.** Counting the raw frequency of a preferred Chinese term in the translated output conflates *translation accuracy* with *prompt lexical bias*.
* If injecting the context prompt causes the LLM to repetitively insert `残差连接` where the English source used a neutral pronoun or passive verb ("they are connected"), that is **overtranslation / stylistic distortion**, not an improvement.
* **Correction:** Evaluation must evaluate **per-unit semantic accuracy and correctness in sentence context**, verifying that the term was warranted by the source syntax, not merely counting string occurrences across a document.

### Premise 3: "Run instability (1-of-7 vs. 4-of-5) is primarily due to LLM stochasticity on ResNet."
* **Challenge:** **Partially incorrect; high risk of thread-safety or caching race conditions.**
* While `deepseek-flash` has temperature variance, a shift from 14% to 80% on identical text suggests an environmental flaw.
* In the verified ground truth: *"context travels in a thread-local and per-unit identity in the cache key argument, because four worker threads share one translator instance."*
* If thread-local state is modified or read across an `async` boundary, or if a thread pool worker reuses a thread without clearing thread-local storage, context from unit $A$ can bleed into unit $B$.
* **Mandatory Diagnostic:** Before accepting run instability as "model variance," the benchmark harness must run in single-threaded mode ($W=1$) versus multi-threaded mode ($W=4$). If $W=1$ is stable and $W=4$ exhibits high variance, the issue is thread-local state leakage, not LLM stochasticity.

### Premise 4: "ResNet-152 is an adequate baseline paper if we just add ambiguous terms to the evaluation list."
* **Challenge:** **False.** ResNet is universally present in the pretraining corpus of every modern foundation model. The tokens `residual`, `shortcut`, and `identity mapping` have near-deterministic weight associations in DeepSeek.
* You cannot test the disambiguation capability of context on a paper whose translation weights are already frozen into the model's parametric memory. A contemporary paper (2024–2025) or a niche control theory paper is strictly necessary.

### Premise 5: "DocumentAnalysis must remain untouched and consumes DocumentIR only."
* **Challenge:** **Valid for architecture, but limits section fallback.**
* Keeping `DocumentAnalysis` consuming `DocumentIR` only is the correct architectural boundary (avoiding dual-parser drift). However, the team must recognize the corollary: if `DocumentIR` does not expose an efficient spatial R-tree index for bounding boxes, mapping unsegmented units geometrically will be computationally expensive ($O(N \times M)$ scan per unit). This constraint reinforces why Off-mode fallback is the only sound choice today.
