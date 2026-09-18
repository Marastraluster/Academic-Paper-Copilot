# DS-CTX-004: Academic Prompt Translation Baseline — Acceptance Criteria

> **Document Role**: Independent Acceptance Criteria Author  
> **Project**: Local-First Academic PDF Reader + Bilingual Translator ("Academic PDF Copilot")  
> **Baseline Suite**: Backend 666 passed · Frontend 75 passed  
> **Scope**: Specifications and verification gates only. **No production code.**

---

## 1. P0 Acceptance Criteria (Must Have / Release Blockers)

```
       ┌───────────────┐
       │ Translate PDF │
       └───────┬───────┘
               │ Mode Dispatch
       ┌───────┴───────────────────────────────┐
       ▼                                       ▼
┌──────────────┐                        ┌──────────────┐
│   ACADEMIC   │                        │  CONTEXTUAL  │
│ (Prompt Only)│                        │  (Analysis)  │
└──────┬───────┘                        └──────┬───────┘
       │ Analysis skipped                      │ Runs analysis (~392s)
       │ No DocumentIR/Glossary                │ Rich context payload
       ▼                                       ▼
┌──────────────┐                        ┌──────────────┐
│ Cache Key:   │                        │ Cache Key:   │
│ Pure Source  │                        │ Context Hash │
│ + Prompt Ver │                        │ + Source     │
└──────────────┘                        └──────────────┘
```

### P0.1: Mode Enum Definition, Backward-Compatible Aliasing, and Serialization
* **Specification**:
  1. [`app/context/translation_context.py`](file:///app/context/translation_context.py) must explicitly support three runtime modes:
     * `off` (canonical internal identifier for Basic mode)
     * `academic` (canonical internal identifier for Academic prompt-only mode)
     * `standard` (canonical internal identifier for Contextual mode)
  2. `VALID_MODES` tuple must contain `("off", "academic", "standard")`.
  3. Deserialization of persisted user settings, stored task JSONs, or SQLite database records containing legacy values (`"off"`, `"standard"`) must succeed without error or migration failure.
  4. Passing any unrecognized mode string (e.g., `"full"`, `"custom"`, `None`) must immediately raise a structured `ValueError` or validation rejection before job scheduling.
* **Verification**: Unit tests verifying that deserializing configs with `"off"`, `"standard"`, and `"academic"` instantiate valid contexts, while invalid strings fail fast with a descriptive error.
* **Rationale**: Prevents data corruption and crashes across persisted session states while introducing the new mode cleanly.

---

### P0.2: Decoupled Academic Prompt Dispatch Without Analysis Dependency
* **Specification**:
  1. In [`ContextualOpenAIlikedTranslator.prompt()`](file:///app/pdfkernel/contextual_translator.py), when `mode == "academic"`:
     * The translator must dispatch directly to [`prompts.translation_messages(...)`](file:///app/context/prompts.py).
     * All context payload arguments (`document_summary`, `academic_domain`, `section_title`, `section_summary`, `glossary`, `previous_paragraph`, `next_paragraph`) must be explicitly passed as `None` (or omitted).
     * Execution must NOT require a `UnitContextProvider` instance (i.e. `self._provider` may be `None`).
     * Execution must NOT read or require the thread-local `_UNIT_CONTEXT`.
     * Execution must NOT invoke `DocumentAnalysis`, `DocumentIR`, `EvidenceMapper`, or section/glossary builders.
  2. Latency between the translation request invocation and the first outbound LLM HTTP call must be $\le 50\text{ ms}$ (zero pre-computation analysis delay).
  3. When `mode == "off"`, `prompt()` falls back to upstream's minimal envelope (`super().prompt(...)`).
  4. When `mode == "standard"`, existing context-driven injection is retained unchanged.
* **Verification**: Mock `DocumentAnalysis` to raise an exception if invoked. Execute an Academic translation job. Verify zero exceptions are raised, outbound prompt contains only the academic instructions + source target, and translation completes.
* **Rationale**: Eliminates the 392-second analysis bottleneck observed in DS-CTX-003, making academic-grade translation instant.

---

### P0.3: Cache Key Isolation and Analysis-Churn Invariance (Trap Avoidance)
* **Specification**:
  1. For `academic` mode:
     * Upstream cache parameters (`params`) must register `context_mode: "academic"` and `prompt_version: TRANSLATION_PROMPT_VERSION`.
     * The cache key text argument (`original_text`) passed to the cache backend MUST be the pure `source_text`. It must **NOT** be prepended with a `context_hash`, `analysis_hash`, `section_hash`, `glossary_hash`, or NUL byte delimiter (`\0`).
     * Cache entries created in `academic` mode must be strictly invariant to `DocumentAnalysis` changes: re-running, mutating, or invalidating `DocumentAnalysis` for a document must result in a **CACHE HIT** for identical `source_text` under identical generation parameters.
  2. Cross-Mode Cache Isolation:
     * A cached translation from `off` (Basic) must never return a hit for `academic` or `standard`.
     * A cached translation from `academic` must never return a hit for `off` or `standard`.
     * A cached translation from `standard` must never return a hit for `academic` or `off`.
  3. For `standard` (Contextual) mode:
     * Retains the existing composite key format: `context_hash + "\0" + source_text`.
* **Verification**:
  * Step A: Translate unit $U_1$ in `academic` mode $\to$ Cache miss, LLM called, result cached.
  * Step B: Mutate document analysis metadata (force different summary and glossary) $\to$ Re-translate $U_1$ in `academic` mode $\to$ Must assert **CACHE HIT** (0 LLM calls).
  * Step C: Request $U_1$ in `off` and `standard` modes $\to$ Must assert **CACHE MISS** for each.
* **Rationale**: Prevents cache thrashing and invalidation loops where background paper analysis updates invalidate already translated academic units that never consumed that analysis.

---

### P0.4: Academic Prompt Envelope Specification & Dynamic Language Parameterization
* **Specification**:
  1. [`TRANSLATION_PROMPT_VERSION`](file:///app/context/prompts.py) must be explicitly defined and incremented (e.g., `"2.1.0"`).
  2. When all context parameters are `None`, [`prompts.translation_messages(...)`](file:///app/context/prompts.py) must render an envelope that degrades cleanly:
     * It must contain the system message establishing the academic persona: preserve technical meaning, mathematical notation (LaTeX), single-brace placeholders (`{vN}`), citations (`[N]`, `Author et al.`), model names, datasets, benchmarks, acronyms, code identifiers, URLs, DOIs; prohibit preambles, summaries, and commentary; instruct ambiguity resolution based on immediate sentence context and scholarly discourse.
     * The user message must contain **only**:
       ```text
       === TARGET SOURCE TEXT (TRANSLATE THIS ONLY) ===
       {target_text}
       ```
     * Absent sections: headers for `=== ACADEMIC CONTEXT ===`, `=== GLOSSARY ===`, `=== PREVIOUS PARAGRAPH ===`, and `=== NEXT PARAGRAPH ===` must be **completely omitted** (no empty headers or blank sections).
  3. **Target Language Parameterization**:
     * `target_language` must be accepted as an explicit parameter in [`translation_messages`](file:///app/context/prompts.py).
     * The prompt template must contain no hardcoded target language strings (e.g., no hardcoded "Simplified Chinese" or "zh-CN" literals).
     * Parameterizing `target_language="German"` or `target_language="Traditional Chinese"` must dynamically inject that language name into the instruction without altering the rest of the envelope structure.
* **Verification**: Unit tests rendering prompts with `target_language="Japanese"` and `target_language="German"` asserting that:
  * Neither output contains `"Simplified Chinese"`.
  * Neither output contains empty `=== GLOSSARY ===` or `=== ACADEMIC CONTEXT ===` headers.
  * Both contain the respective target language string in the translation directive.
* **Rationale**: Guarantees the prompt contract remains clean, token-efficient, and structurally decoupled from language assumptions.

---

### P0.5: Placeholder Safety & Layout Machinery Non-Regression
* **Specification**:
  1. Variable placeholders in translation units must remain strictly **single-braced** `{vN}` (e.g., `{v0}`, `{v1}`).
  2. Post-translation validation must perform multiset comparison between source and target placeholders:
     * Identical counts of every `{vN}` index must be present in the output.
     * Corrupted or hallucinated shapes (e.g., `{{v0}}`, `<b0>`, `{v 0}`, `[v0]`) must be rejected.
  3. Exactly **one** targeted repair prompt invocation is permitted on validation failure.
  4. If the repair attempt fails to restore valid placeholders, the translator MUST safely return the un-translated **source text** unit, preventing corrupted layout tags from entering PDF reconstruction.
  5. The entire existing test baseline (**666 backend tests**, **75 frontend tests**) must pass with zero regressions.
* **Verification**: Automated regression test suite execution (`pytest backend`, `npm test frontend`), plus parameterized test cases injecting malformed LLM responses (`{{v0}}`, missing `{v1}`) to assert exact 1-repair then fallback-to-source behavior.
* **Rationale**: Layout tags reconstruct the visual PDF; a single missing or malformed tag breaks PDF generation.

---

### P0.6: End-to-End PDF Translation Verification in Academic Mode
* **Specification**:
  1. Complete translation of a real multi-page academic PDF (e.g., Diffusion Policy arXiv:2303.04137) in `academic` mode must succeed end-to-end.
  2. Outputs generated:
     * Mono-lingual translated PDF (`*_mono.pdf`).
     * Dual-lingual bilingual PDF (`*_dual.pdf`).
  3. Verification invariants:
     * Source PDF file remains byte-identical (strict read-only immutability).
     * Output page count exactly matches source PDF page count.
     * Vector layout, embedded figures, charts, and table boundaries are preserved intact without displacement or rendering artifacts.
     * Target language font glyphs (CJK/Unicode) render cleanly without unmapped character boxes (tofu / ``).
     * Zero `.analysis.json` or glossary artifacts are written to disk during the run.
* **Verification**: Automated end-to-end integration test running the PDF through the translation pipeline in `academic` mode, inspecting output files, page counts, and disk directory diffs.
* **Rationale**: Confirms that Academic mode is a fully operational, independent document pipeline, not just an isolated prompt test.

---

### P0.7: Three-Arm Empirical Benchmark & Objective Decision Gate
* **Specification**:
  1. A controlled three-arm benchmark must be executed under identical conditions:
     * **Paper**: Diffusion Policy (arXiv:2303.04137), 15 fixed evaluation prose units from DS-CTX-003.
     * **Model / Provider**: `deepseek-flash` (or frozen API snapshot).
     * **Arms**:
       * Arm 1: `BASIC` (`mode="off"`)
       * Arm 2: `ACADEMIC` (`mode="academic"`)
       * Arm 3: `CONTEXTUAL` (`mode="standard"`)
     * **Repeats**: 3 repeated runs per arm (15 units $\times$ 3 repeats = 45 calls per arm; 135 total LLM calls).
  2. Data Collection:
     * Cost: Prompt tokens, completion tokens, token multiplier vs Basic.
     * Latency: Wall-clock time per unit, plus document-level analysis duration.
     * Provider Failures: Recorded independently per arm (HTTP 429, 5xx, timeouts).
     * Quality: Pairwise scoring (BETTER / SAME / WORSE) evaluated across:
       * Technical accuracy and academic tone.
       * Identifier retention (variable names, model names, benchmarks).
       * Citation preservation.
       * Ambiguous term disambiguation (`policy`, `action`, `observation`).
  3. **Objective Default Decision Gate**:
     * **Decision A (ACADEMIC DEFAULT)** is triggered IF AND ONLY IF:
       $$\text{BETTER}_{\text{Acad vs Basic}} > \text{WORSE}_{\text{Acad vs Basic}} \quad (\ge 20\% \text{ net win rate})$$
       $$\text{Prompt Tokens}_{\text{Academic}} \le 2.0 \times \text{Prompt Tokens}_{\text{Basic}} \quad (\le 350 \text{ tokens/unit})$$
       $$\text{Analysis Duration}_{\text{Academic}} = 0\text{ s} \quad (\text{vs } 392\text{ s for Contextual})$$
       $$\text{Provider Failure Rate}_{\text{Academic}} \le 2.2\% \quad (\le 1 / 45)$$
     * **Decision B (BASIC DEFAULT, ACADEMIC OPTIONAL)** is triggered IF:
       Academic quality shows no statistically significant improvement over Basic ($\text{BETTER} \le \text{WORSE}$), or creates token/latency overhead with negligible win rate.
     * **Decision C (CONTEXTUAL STILL JUSTIFIED)** is triggered IF:
       Contextual demonstrates $> 20\%$ net wins over Academic specifically on ambiguous terminology disambiguation, contradicting DS-CTX-003.
     * **Decision D (INCONCLUSIVE)** is triggered IF:
       Provider failure rate across any arm exceeds $10\%$ ($> 4 / 45$), requiring a re-run under stable network conditions.
  4. **Strict Constraint**: Default mode in code MUST NOT be set to Academic until the benchmark data is collected and formally satisfies Decision A criteria.
* **Verification**: Execution of the benchmark script, generation of a persistent JSON results log and Markdown score card verifying all four gate metrics.
* **Rationale**: Eliminates guesswork and adheres to empirical product governance.

---

### P0.8: Resolution Protocol for Intermittent Test `test_force_regenerates_and_leaves_every_other_artifact_alone`
* **Specification**:
  1. The test [`test_force_regenerates_and_leaves_every_other_artifact_alone`](file:///tests/test_artifacts.py) must be executed in a dedicated 20-run stress loop (`pytest -k test_force_regenerates_and_leaves_every_other_artifact_alone --count=20`).
  2. If a failure is observed:
     * Capture the exact failure assertion and timestamp values.
     * If the failure is due to filesystem timestamp granularity (e.g., Windows NTFS / FAT32 `mtime` resolution where file regeneration completes in $< 15\text{ ms}$ resulting in identical `mtime`), apply an explicit deterministic clock mock or insert a bounded clock advance (`mtime = old_mtime + 1.0` or test-scoped sleep exceeding filesystem resolution).
     * If the failure is due to concurrent filesystem locks, enforce clean file descriptor closing.
  3. If zero failures occur across 20 consecutive runs:
     * Document exact operating environment parameters (OS version, filesystem type, Python version, single vs multi-worker pytest).
     * Classify the previous DS-CTX-003 failure as an environmental filesystem-tick flake under high CI/runner CPU load.
     * The test assertion MUST NOT be deleted, weakened, or skipped.
* **Verification**: 20 consecutive green runs logged in CI/test runner with zero assertion bypasses.
* **Rationale**: Maintains test suite integrity without sweeping flaky test behavior under the rug.

---

## 2. P1 Acceptance Criteria (Important / Core UX & Architecture)

### P1.1: Frontend UI Mode Exposure & Explicit Signaling
* **Specification**:
  1. Translation settings panel must expose the three modes with clear, user-facing labels:
     * **Academic** (Default candidate pending benchmark gate): *"Research-grade academic prompt. High fidelity, fast, low token cost."*
     * **Basic**: *"Upstream standard prompt. Fastest, minimal token usage."*
     * **Contextual (Experimental)**: Badged with an `[Experimental]` tag. Tooltip or subtext must state: *"Requires full document pre-analysis (~5–10 min) and 6.6× tokens. Recommended only for interdisciplinary papers with heavy custom notation."*
  2. When switching to Academic or Basic mode, the UI must NEVER trigger or display whole-document analysis progress bars.
* **Verification**: Playwright / frontend component tests verifying dropdown options, label text, experimental badging, and conditional progress bar rendering.
* **Rationale**: Protects user expectations. 392 seconds of analysis without warning causes user abandonment.

---

### P1.2: Lazy DocumentAnalysis Invocation Contract
* **Specification**:
  1. Opening an academic PDF, rendering pages, reading dual text, or initiating Basic/Academic translations must strictly NEVER trigger `DocumentAnalysis`.
  2. `DocumentAnalysis` pipeline execution must be deferred until explicitly demanded by:
     * Initiating a Contextual translation.
     * Accessing future Paper QA or Whole-Paper Summarization features.
* **Verification**: Integration test opening 5 different PDFs and translating in Academic mode; assert no `.analysis.json` or glossary cache files are created in the workspace.
* **Rationale**: Preserves system resources and disk I/O on local machines.

---

### P1.3: Unmatched Unit Fallback in Academic Mode
* **Specification**:
  1. In Academic mode, translation units that do not map to body prose (captions, headings, table cells, running headers) do not require IR evidence mapping.
  2. Non-prose units that undergo translation must receive the clean academic prompt envelope without synthetic section titles or document summaries.
  3. Units classified as non-translatable (isolated equation lines, author affiliation blocks, page numbers) must bypass LLM dispatch entirely and return the raw text.
* **Verification**: Unit tests on 10 non-prose translation units verifying that LLM prompt contains no synthetic context and that equation units bypass LLM calls.
* **Rationale**: Consistent with DS-CTX-003 findings where 90% of unmatched units were correctly refused or lacked context.

---

### P1.4: Telemetry & Token Cost Observability
* **Specification**:
  1. Every completed translation job must record structured telemetry:
     * `mode`: `"off"` | `"academic"` | `"standard"`
     * `prompt_tokens`: integer
     * `completion_tokens`: integer
     * `translation_latency_ms`: integer
     * `analysis_latency_ms`: integer (must be `0` for Academic and Basic)
     * `cached_units_count`: integer
     * `live_units_count`: integer
* **Verification**: Inspect job execution metadata in test logs to verify all fields are populated accurately.
* **Rationale**: Provides empirical operational data for ongoing model cost and performance monitoring.

---

## 3. P2 Acceptance Criteria (Nice to Have / Future-Proofing)

### P2.1: Automated Benchmark CLI Harness
* **Specification**:
  1. A standalone developer CLI command (e.g., `python -m app.tools.benchmark_modes --pdf <path> --units <json>`) must automate:
     * Running the 3 arms $\times$ $N$ repeats.
     * Calculating token multipliers, latencies, and provider failure counts.
     * Outputting a formatted Markdown comparison table and JSON summary.
* **Verification**: CLI execution test on a sample fixture with `--dry-run` producing valid JSON and Markdown.
* **Rationale**: Facilitates future regression benchmarking as underlying LLMs evolve.

---

### P2.2: Multi-Language Academic Prompt Invariant Validation
* **Specification**:
  1. Test suite includes parameterized checks for non-CJK target languages (`"German"`, `"French"`, `"Spanish"`, `"Japanese"`).
  2. Verifies that LaTeX math notation (`$x$`, `\begin{equation}`), placeholders (`{v0}`), and citation brackets (`[1]`, `Author et al.`) remain uncorrupted regardless of target language grammar.
* **Verification**: Automated pytest suite running translation mock across 4 distinct target languages.
* **Rationale**: Prevents Western language grammar from mutating LaTeX tokens or placeholder syntax.

---

### P2.3: Cache Metadata Inspection Utility
* **Specification**:
  1. A developer utility function `get_cache_entry_info(key)` capable of decoding and inspecting cache metadata to confirm whether an entry was generated under `basic`, `academic`, or `contextual` mode without manual SQLite inspection.
* **Verification**: Unit test querying cache entries and validating returned mode tags.
* **Rationale**: Reduces debugging time when triaging cache hit/miss behavior.

---

## 4. Explicitly Not Applicable (Out of Scope)

| Feature / Area | Why Explicitly Excluded |
| :--- | :--- |
| **Paper QA / Document Chat** | DS-CTX-004 is strictly focused on translation baseline optimization. Paper QA is a separate feature where Document Intelligence artifacts (`DocumentAnalysis`, `DocumentIR`) remain fully justified and preserved. |
| **Vector Embeddings / RAG Stores** | The system is local-first, deterministic, and layout-driven. Fuzzy vector search adds bloat and non-determinism; context injection is structural, not embedding-based. |
| **Deleting / Deprecating Document Intelligence Artifacts** | `DocumentIR`, `ContextBuilder`, and glossary extraction scored 96.3% accuracy in DS-CTX-003. They are not obsolete; they are simply decoupled from the high-frequency per-unit translation path. |
| **Context Payload Expansion / Re-Engineering** | DS-CTX-003 conclusively proved that expanding context payloads for translation resulted in a 6.58× token multiplier with no disambiguation benefit. Attempting to "fix" Contextual mode with more context violates the task constraints. |
| **Secondary PDF Parser Replacement** | Upstream PDF layout and text extraction kernels are frozen. No parsing engine churn (e.g., swapping PyMuPDF / PDFMiner). |
| **Hardcoded Terminology Dictionaries** | The academic prompt must generalize across scientific disciplines; maintaining manual per-paper translation dictionaries is out of scope. |

---

## 5. Direct Answers to the Two Questions

### Question 1: Should Academic prompt-only mode become the default translation mode based on the DS-CTX-003 evidence?

#### **Answer: Provisionally YES, but formally gated on executing the P0.7 Three-Arm Benchmark.**

#### **Reasoning**:
1. **The Weight of Evidence**:
   * DS-CTX-003 demonstrated that the prompt-only arm achieved identical improvements to Standard (Contextual) mode on technical term retention, citation preservation, and academic tone (including character-identical outputs on critical units).
   * It achieved this while eliminating the **6.58× token multiplier** (186 tokens vs 1,226 tokens) and the **392-second analysis delay**.
   * It also eliminated the provider failures (Standard failed 2/45 times due to payload size / rate limits, whereas prompt-only / off had 0/45 failures).
2. **The Procedural Discipline**:
   * DS-CTX-003 was run on a single paper (Diffusion Policy), 15 units, and a single model (`deepseek-flash`).
   * Adopting Academic as default *in production code* prior to running the standardized 3-arm $\times$ 3-repeat benchmark would violate empirical rigor ("Do not select A before measurement").
   * **Conclusion**: Academic mode is the designated primary candidate for default. If the P0.7 benchmark confirms the DS-CTX-003 findings under the formal gate criteria, **Decision A (ACADEMIC DEFAULT)** must be immediately committed. If the quality delta over Basic is negligible, **Decision B** applies.

---

### Question 2: Should Contextual mode remain user-visible, become Advanced/Experimental, or remain backend-only for now?

#### **Answer: EXPERIMENTAL (Badged with explicit cost and latency disclosure).**

```
┌────────────────────────────────────────────────────────┐
│ Translation Mode                                       │
├────────────────────────────────────────────────────────┤
│ (•) Academic [Default]                                 │
│     Fast, research-grade prompt, low token cost        │
│                                                        │
│ ( ) Basic                                              │
│     Upstream minimal translation                       │
│                                                        │
│ ( ) Contextual [Experimental]                          │
│     ⚠️ Requires full-paper analysis (~5-10 min)        │
│     and 6.6x token payload. High timeout risk.         │
└────────────────────────────────────────────────────────┘
```

#### **Reasoning**:
1. **Why NOT "Visible Advanced"**:
   * Labelling a feature "Advanced" implies it is production-ready for power users who want superior quality.
   * In reality, Contextual mode incurs a **392-second wait for 3 pages**, consumes **6.58× tokens**, exhibits an **elevated provider failure rate (2/45)**, and produced **zero observed disambiguation wins** on real academic units.
   * Exposing this as a standard peer option would lead users to assume it is "better," resulting in extreme latency, unexpected API bills, frequent provider timeouts, and product churn.
2. **Why NOT "Hidden / Developer Only"**:
   * The DS-CTX-003 sample was 15 units from one robotics paper. While definitive for routine body prose, robotics vocabulary is locally constrained.
   * Completely burying Contextual mode behind flags prevents power users, academic researchers, and internal evaluators from testing it on highly polysemous, interdisciplinary papers (e.g., computational biology or mathematical economics) where document-level glossaries might provide an edge.
   * Hiding it entirely also risks bit-rot of the integration machinery before Paper QA matures.
3. **The Justification for "Experimental"**:
   * Marking it `EXPERIMENTAL` accurately conveys the product reality: it is a research prototype under active evaluation.
   * Accompanied by clear modal or tooltip warnings regarding pre-analysis latency and token consumption, it protects mainstream users from catastrophic slowdowns while preserving access for evaluation.

---

## 6. Premises Believed Wrong or Requiring Clarification

### 1. The "Disambiguation Failure" Generalization Across Scientific Domains
* **The Premise in the Brief**: Contextual mode provided zero disambiguation benefit on `policy`, `action`, `observation`, indicating that context payloads do not pay.
* **Critique**: The premise is true for the test case, but the deduction that "context payload never disambiguates" is over-generalized from a homogeneous sample. In *Diffusion Policy* (arXiv:2303.04137), the immediate sentence and paragraph already provide strong local conditioning (e.g., *"we train a policy to predict robot actions from camera observations"*). Modern LLMs have ingested millions of robotics papers; their attention heads do not require a document glossary to map `policy` to 策略 (robotics/RL) rather than 政策 (public policy) in that context.
* **The Real Architectural Flaw**: The failure was not that context is useless, but that **per-unit payload injection is the wrong vehicle for document intelligence**. Sending a 1,000-token global summary and glossary with *every single sentence* is an architectural anti-pattern. Context belongs in whole-document understanding and QA, not repeated $N$ times across 500 paragraphs.

---

### 2. Leaky Cache Identity Architecture
* **The Premise in the Brief**: Cache identity travels in the cache key text as `context_hash + "\0" + source_text` because `add_cache_impact_parameters` mutates shared state and threads would race.
* **Critique**: Prepending metadata to `original_text` was an expedient workaround for thread concurrency in upstream's cache, but it creates a fragile leaky abstraction. If Academic mode were to touch this prefix logic at all, a mode consuming zero context would remain vulnerable to hash mutations.
* **Correction in Criteria**: P0.3 strictly specifies that Academic mode must bypass prefixing entirely. The text passed to the cache must be pure `source_text`, and mode separation must be enforced strictly via the static `context_mode: "academic"` parameter in `params`.

---

### 3. Conflating One-Off Analysis Latency with Ongoing Translation Cost
* **The Premise in the Brief**: The 392-second analysis duration is cited as a direct argument against the Contextual translation mode.
* **Critique**: While 392 seconds is fatal to user experience, attributing it directly to Contextual *translation* conflates an implementation defect with a cost ceiling. The 392s was a one-time pre-computation delay because analysis was coupled synchronously to the translation trigger. If analysis had been asynchronous, that latency would not recur on cached runs.
* **The Real Disqualifier**: What truly invalidates Contextual mode for translation is not the pre-computation delay, but the **perpetual 6.58× token multiplier** and the **higher provider error rate (2/45 vs 0/45)** on every single call thereafter, with zero observable translation quality improvement.

---

### 4. Flaky Test Dismissal as an "Unreproduced Mystery"
* **The Premise in the Brief**: `test_force_regenerates_and_leaves_every_other_artifact_alone` failed once in a full run and passed four times elsewhere; it should just be observed and categorized.
* **Critique**: On Windows filesystems (NTFS), file modification timestamps (`mtime`) have discrete tick resolutions. If a test forces regeneration and checks `new_mtime > old_mtime` without a bounded time advance or mock, high CPU load during parallel pytest execution can cause file writes to complete within the same tick resolution window ($< 15.6\text{ ms}$), causing intermittent assertion failures.
* **Correction in Criteria**: P0.8 establishes a deterministic resolution protocol (20-run stress loop and clock-tick validation) rather than accepting test flakiness as normal project overhead.

---

### 5. Target Language Invariance Assumption
* **The Premise in the Brief**: Decoupling the target language into a parameter is sufficient to ensure universal academic translation.
* **Critique**: LLMs treat English-to-Chinese translation differently than English-to-German or English-to-French. In Western target languages, models frequently attempt to translate Latin terms (*et al.*, *in vitro*, *a priori*), mathematical abbreviations, or merge single-brace placeholders (`{v0}`) into surrounding punctuation.
* **Correction in Criteria**: P0.4 and P2.2 mandate specific invariant testing on non-CJK target languages to ensure placeholder multiset validation and LaTeX math preservation hold across varied linguistic structures.
