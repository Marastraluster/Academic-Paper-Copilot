# Acceptance Criteria — DS-QA-014: Paper Overview / Reading Entry

- **Author:** Gemini (`gemini-3.8-flash-high`), via the standing two-agent workflow
- **Reviewed and frozen by:** DeepSeek (Pending Round 1 review)
- **Date:** 2026-09-19
- **Baseline:** Commit `4cb6d2d` / DS-QA-013 (`SCHEMA_VERSION = 5`, `BLOCK_ANCHOR_VERSION = "1"`, `SOURCE_ANCHOR_VERSION = "1"`, `IR_PIPELINE_VERSION = "4"`)
- **Frontend baseline bundle:** 337.51 kB against 350.0 kB ceiling (~12.49 kB headroom)
- **Deliverable:** `docs/acceptance/DS-QA-014.md` (authored before any production code)
- **Status:** **PROPOSED FOR ROUND 1 REVIEW — 38 P0 · 6 P1 · 4 P2**

## 0. Round 1 review and freezing (DeepSeek) — 4 AC_CHANGE_REQUESTs

Read against the repository at `ae50b01` and the measurements in §2. Decisions A,
C, D, F, G, H, I, J, K, L, M, N, O, P, R, S, T and U are accepted as written; the
central decision — **compose Layer B from existing `DocumentAnalysis` outputs
rather than adding a generation prompt** — is the right call and the measurement
supports it: a real cached analysis holds a document summary, 7 section summaries
with page ranges, 207 glossary terms, 29 acronyms and 56 entities. Four items are
changed before freezing.

### AC_CHANGE_REQUEST 1 — AC-P0-32 asserts the wall of text the task forbids

**Old wording:** *"the Overview must render all successfully generated section
cards and terms"*, with evidence *"verifying all 7 sections and 207 terms render
correctly"*.

**New wording:** *"Every available section summary and glossary term is
**reachable**, in the paper's own order, and the panel renders a bounded initial
view — the document summary, the section list, and the first few glossary terms —
with the remainder behind an explicit expansion. Nothing is dropped: the count
offered equals the count the analysis holds."* Evidence asserts what the reader
can reach, not how many nodes are in the DOM.

**Reason.** The task's own Phase 5: *"Avoid a huge wall of text. The Overview
should reduce the time required to orient to the paper."* Measured, the ResNet
analysis holds **207 glossary entries** and **7 section summaries**; a later paper
in the corpus carries far more. Rendering all of them into a 340 px column
produces a scroll the reader has to traverse before reaching anything, which is
the opposite of the product's purpose — and the criterion as written makes that
behaviour mandatory. It also has a practical cost: the evidence implies committing
a 207-entry analysis as a test fixture.

### AC_CHANGE_REQUEST 2 — Decision E's language behaviour contradicts the measurement

**Old wording:** *"Prose summaries from analysis are displayed in their generated
language (English or Chinese)"*, alongside the task's requirement that Overview
output follows the reader's language.

**New wording:** *"Layer B prose is displayed in whatever language the analysis
produced, and the panel says which that is when it differs from the UI language.
Measured: the cached ResNet analysis was generated with `target_language: zh-CN`
and its `summary` is in English — the synthesis prompt passes the language as
context for term decisions and never asks for the output in it. This task does
not re-prompt, because that would bump `PROMPT_VERSION` and invalidate every
cached analysis; it must not imply a language the analysis did not produce."*

**Reason.** The criterion as written asserts a behaviour the data contradicts, and
the task's Phase 13 assumes output in the reader's language. Neither holds today.
A Chinese-UI reader shown English prose with no explanation is the failure this
repository's honesty rules exist to prevent; silently claiming the Overview
follows the UI language is worse. The measurement is in §2.2.

### AC_CHANGE_REQUEST 3 — Decision Q invents a 4.0 kB sub-budget on two named files

**Old wording:** *"Overview client code (`OverviewPanel.tsx`, `api/analysis.ts`)
must stay under **4.0 kB** minified."*

**New wording:** *"The production bundle stays under the 350.0 kB ceiling and no
new dependency is added to `package.json`."*

**Reason.** A per-file size budget measures the wrong thing — the same feature
written with more comments and a helper module would fail it while a leaner
implementation of a worse design would pass. The property that matters is the
total ceiling, which `npm run build` reports directly, and the absence of a new
dependency, which `git diff package.json` shows.

### AC_CHANGE_REQUEST 4 — AC-P0-02's 50 ms is measured where the product is not

**Old wording:** *"Layer A ... must render within ≤ 50.0 ms"*, evidence a vitest
component test.

**New wording:** *"Layer A renders synchronously from data the application already
holds: no request, no loading state, and no waiting on anything. It is observable
as the absence of a loading indicator and as zero network activity, not as a
duration measured in a test runner whose timing is not the browser's."*

**Reason.** Layer A is a pure render of the IR the app fetches at registration —
there is no I/O in it to be slow. The duration is a jsdom number that would need
defending and would pass regardless; the two properties that could actually
regress are "it does not fetch" and "it does not wait", and both are directly
observable. This is the same correction DS-QA-012 and DS-QA-013 each made.

### Accepted, with one implementation consequence named

**Decision C** makes 概览 the default tab on opening a paper. Combined with
**AC-P0-02** that means the reader's first paint is the Overview, which is exactly
why Layer A must not wait on anything: a default tab that shows a spinner is worse
than a default tab that shows structure.

**Measured and recorded, not a criterion:** the frontend has **no analysis client
at all** today, so the 0-provider-call promise holds structurally rather than by
discipline. The new `api/analysis.ts` is therefore the first thing in the
application that can spend the user's money, and every path that reaches it must
be behind an explicit action.

**P0 is frozen at 38 criteria with the four changes above.**

---

## 0. Independent Acceptance Author Statement & Review Framing

### 0.1 Process Discipline: Acceptance before Implementation
In this repository, process sequencing is load-bearing:
- **DS-DOC-002** bypassed pre-implementation acceptance criteria, resulting in reading-order and cache-invalidation defects that required retroactive diagnosis and repair (`.agent/evidence/DS-DOC-002.md`).
- **DS-DOC-003** strictly enforced acceptance criteria first (`docs/acceptance/DS-DOC-003.md`), catching three structural defects prior to coding.
- **DS-QA-010** established multi-target persistent notes (`docs/acceptance/DS-QA-010.md`), closing at **18/18 P0 PASS** (`2529674`) with 0 AI calls, 0 PDF mutations, and 0.0% wrong-attachment rate.
- **DS-QA-012** established instant client-side substring search and deterministic server-side export (`docs/acceptance/DS-QA-012.md`), closing at **27/27 P0 PASS** (`10ef696`).
- **DS-QA-013** established selectable non-prose annotation (`docs/acceptance/DS-QA-013.md`), closing at **48/48 P0 PASS** (`4cb6d2d`) under the 350.0 kB bundle ceiling.

**This task (DS-QA-014) addresses the cold-start paper reading entry gap.** When a reader opens an unfamiliar academic paper, they need an immediate cognitive orientation: what core problem the paper tackles, its central idea, how the methodology is organized, what experimental benchmarks were conducted, what section should be read first, and what technical terminology matters — **without forcing them to formulate and type chat questions into Paper QA**.

### 0.2 The Zero-Provider-Call Guarantee & The Two-Layer Architecture
Opening a paper in this application must cause **strictly 0 provider calls**:

```
+-----------------------------------------------------------------------------------+
| LAYER A: Instant Reading Entry (Deterministic, 0 AI calls, Latency < 50ms)        |
| - Title from IR metadata                                                          |
| - Verbatim canonical Abstract from IR paragraphs (is_abstract = True)             |
| - Author outline tree with page indicators from SectionIR                         |
| - Dynamic "Start Reading" algorithmic entry point (canonical first method section)|
| - Physical structure metrics (page count, section count, word count)              |
+-----------------------------------------------------------------------------------+
                                         |
                                         | (If compatible cached analysis exists, OR
                                         |  reader explicitly clicks "Generate Overview")
                                         v
+-----------------------------------------------------------------------------------+
| LAYER B: AI Overview (Composed from DocumentAnalysis, Cached / On-Demand Only)    |
| - Executive summary of research problem & core idea (DocumentAnalysis.summary)    |
| - Primary domain classification & model confidence (DomainRecord)                 |
| - Section-by-section method & findings roadmap (SectionAnalysis[])                |
| - Key paper terminology & translations (GlossaryEntry[] + AcronymEntry[])         |
| - Clickable source anchors to page ranges and paragraphs                          |
+-----------------------------------------------------------------------------------+
```

### 0.3 Core Guiding Principles

1. **Zero Provider Calls on Document Open:** Opening a paper, browsing pages, switching reader modes, and navigating through all sidebar tabs (`概览`, `目录`, `问答`, `笔记`) must incur exactly 0 LLM provider calls.
2. **Composition Over Prompts:** Layer B is composed strictly from the existing, rich `DocumentAnalysis` schema (`summary`, `sections`, `glossary`, `acronyms`, `domain`). No redundant second LLM pipeline or second cache layer is permitted.
3. **Strict Evidentiary Grounding:** Every claim in the Overview must resolve to verifiable source coordinates (`page_range` or `paragraph_id`). Unsupported claims and ungrounded prose are strictly forbidden.
4. **Honest Structural Fidelity:** If an Abstract is absent, the system states it is unavailable; it never fabricates an abstract or substitutes Introduction. If a paper lacks a dedicated Limitations section, the system states it is not separately sectioned; it never speculates about flaws.
5. **Notes Isolation:** Personal annotations and reader marginalia are user notes, **never** scientific paper evidence. Notes must never be passed to `DocumentAnalysis` or used to construct the Overview.
6. **No Chat Replacement:** Overview complements Outline, Paper QA, and Notes. It provides a structured reading entry point; it does not replace interactive QA or outline navigation.
7. **No Dense Vector / Semantic Retrieval:** Overview relies entirely on canonical IR extraction and structured `DocumentAnalysis`. Introducing vector embeddings, dense retrieval models, or vector databases is strictly prohibited.
8. **Bundle Discipline (< 350.0 kB):** With ~12.49 kB headroom remaining (337.51 kB baseline against 350.0 kB ceiling), zero third-party Markdown renderers or chart libraries may be introduced.

---

## 1. Executive Judgment: Is this task worth doing?

**Yes — but strictly as an instant Layer A structural entry plus an on-demand/cached Layer B composed directly from `DocumentAnalysis`, placed as a 4th tab (`概览`) in the existing `AssistantSidebar` (340 px), with zero new backend pipelines and zero automatic background provider calls.**

Academic papers are dense, highly structured artifacts. Readers confronted with a 12-page paper like ResNet (191 layout blocks, 7 sections, 207 specialized terms) currently face an empty chat interface in Paper QA or a raw outline in OutlinePanel. An instant reading entry bridges this gap by presenting:
1. The author's original Abstract immediately without network round trips.
2. A deterministic "Recommended Start" pointer to the first substantive methodology section.
3. When requested or cached, a structured orientation detailing the research problem, method cards, findings cards, and key domain vocabulary with direct click-to-page navigation.

---

## 2. Measured Evidence & Empirical Grounding

### 2.1 What the Canonical IR Carries Today (Layer A Verification)
Measured on the real ResNet extraction (`1e0651b6810e`, 12 pages):
- `ir.metadata.title`: `"Deep Residual Learning for Image Recognition"`
- `ir.paragraphs` with `is_abstract = True`: exactly 2 paragraphs containing the complete canonical abstract text (175 words).
- `ir.sections`: 7 top-level sections (`Abstract`, `1. Introduction`, `2. Related Work`, `3. Deep Residual Learning`, `4. Experiments`, `References`, `Appendix`), with exact `page_range` and `level`.
- `ir.pages`: 12 pages with dimensions and layout blocks.

*Conclusion:* Layer A can be rendered instantly and purely client-side from the already fetched `DocumentIR` at 0 provider calls, 0 network latency, and 0 backend code modifications.

### 2.2 What the Cached `DocumentAnalysis` Carries (Layer B Verification)
Measured on the real cached analysis for ResNet (`status: PARTIAL`, provider `deepseek-flash`, `target_language: zh-CN`):
- `summary`: 194 words synthesizing the core problem (degradation of deep networks), core approach (identity shortcut mapping), and empirical proof (152-layer ImageNet victory).
- `sections`: 7 `SectionAnalysis` records:
  - `s_0`: Abstract (`p. 1-1`)
  - `s_1`: 1. Introduction (`p. 1-2`)
  - `s_2`: 2. Related Work (`p. 2-3`)
  - `s_3`: 3. Deep Residual Learning (`p. 3-5`)
  - `s_4`: 4. Experiments (`p. 5-11`)
  - `s_5`: References (`p. 11-12`)
  - `s_6`: Appendix (`p. 12-12`)
- `glossary`: 207 entries with `source_term`, `suggested_translation`, `definition`, `is_translatable`, and `paragraph_ids`.
- `acronyms`: 29 entries (e.g. `BN`, `SGD`, `VGG`).
- `entities`: 56 entries (e.g. `ImageNet`, `CIFAR-10`, `ResNet-152`).
- `domain`: `DomainRecord(primary="Computer Vision", confidence=0.95)`.

### 2.3 Empirical Gap Analysis: Candidate Shape vs. Reality

| Candidate Overview Section | Available in `DocumentAnalysis` | Grounding Anchor Available | Fidelity & Limitation Assessment |
|---|---|---|---|
| **Research Question & Core Idea** | `summary` | Whole-paper (`whole_paper`) | High synthesis quality; no per-sentence paragraph anchoring. |
| **Domain & Subject** | `domain` | Whole-paper (`whole_paper`) | Explicit model confidence score (`0.95`). |
| **Method at a Glance** | `sections[]` summaries | `SectionAnalysis.page_range` | Tied to canonical section titles (`3. Deep Residual Learning`). |
| **Experiments & Setup** | `sections[]` summaries | `SectionAnalysis.page_range` | Tied to canonical section titles (`4. Experiments`). |
| **Key Terminology** | `glossary` + `acronyms` | `paragraph_ids` | 100% grounded to source paragraphs; exact identifiers preserved. |
| **Main Contributions** | **None dedicated** | None | Must be composed from Section 1 summary; never fabricated as a separate section if unsectioned. |
| **Limitations** | **None dedicated** | None | Must not be speculated. If absent in paper, state clearly as "Not separately sectioned". |

---

## 3. Explicit Design Decisions A–V

| # | Topic | Verdict | Detailed Specification & Rationale |
|---|---|---|---|
| **A** | **Exact Instant Content (Layer A)** | **Title, Canonical Abstract, Structural Metrics, Outline Roadmap.** | Derived strictly from `DocumentIR`. If `is_abstract` paragraphs exist, display them verbatim. If absent, display "本文档未包含独立摘要" (never substitute Introduction or synthesize text). Display total page count, section count, and first substantive reading recommendation. |
| **B** | **Exact AI Overview Content (Layer B)** | **Composed directly from `DocumentAnalysis` (`summary`, `domain`, `sections`, `glossary`, `acronyms`).** | Phase 3 mandate: compose existing outputs rather than introducing a new prompt. Surfaced as 4 cards: (1) Core Idea & Research Question (`summary` + `domain`), (2) Reading Roadmap & Section Summaries (`sections[]`), (3) Key Technical Terms (`glossary`), (4) Acronyms & Entities (`acronyms` + `entities`). |
| **C** | **Sidebar Tab & Placement** | **4th tab `概览` in `AssistantSidebar` (`SIDEBAR_WIDTH_PX = 340`).** | The sidebar tabs become: `概览 | 目录 | 问答 | 笔记`. At 340 px width, 4 tabs (~55 px each) fit comfortably without overflow. Adding a 4th permanently visible sidebar column is strictly forbidden to preserve reader reading width (> 680 px on 1024 px displays). Default tab on opening a new paper is `overview`. |
| **D** | **Explicit On-Demand AI Generation** | **STRICTLY ON-DEMAND / 0 CALLS ON OPEN.** | Opening a paper and visiting tabs causes 0 provider calls. Layer B loads cached analysis if present (`GET /documents/{id}/analysis`). If none exists, an explicit "生成 AI 论文概览" button is presented. Provider generation (`POST /documents/{id}/analysis`) executes only upon user click. |
| **E** | **Language & Identifier Preservation** | **Bilingual Preservation; Model Names & Identifiers Untranslated.** | UI chrome is in Chinese. Prose summaries from analysis are displayed in their generated language (English or Chinese). Technical identifiers (`ResNet-50`, `Diffusion Policy`, `CIFAR-10`, `ImageNet`, `SGD`, `BN`) must remain in exact English casing (`is_translatable: false`). Glossary terms display English source term with Chinese translation. |
| **F** | **Grounding Requirements** | **Explicit Coordinate Grounding; Whole-Paper Scope Disclaimed.** | Claims derived from `SectionAnalysis` must display their canonical `page_range` (e.g. `p. 3–5`). Terms from `glossary` must link to their source `paragraph_ids`. Whole-paper `summary` must be explicitly tagged as "基于全文综合分析生成", disclaiming fine-grained per-claim grounding. |
| **G** | **Citation Requirements & Clickability** | **Every page range and term reference is a clickable jump button.** | Clicking a section page badge jumps the PDF viewer to that section's start page (`jumpToSection` / `jumpToPage`). Clicking a glossary term navigates to its first occurrence paragraph and temporarily highlights its bounding box. |
| **H** | **Behaviour with PARTIAL Analysis & None** | **Render partial cards; never fail the whole view.** | If analysis status is `PARTIAL`, render all available sections and glossary entries, with a top warning pill: "部分章节分析已就绪". If analysis is missing (`404`), render Layer A with the "生成概览" prompt. If `FAILED`, display retry button. |
| **I** | **Cached-Analysis Compatibility** | **Governed by `app.context.persistence.is_cache_valid`.** | An analysis is compatible if and only if `content_hash`, `pipeline_version`, `prompt_version`, `ir_pipeline_version`, `provider_base_url`, `provider_model`, and `target_language` match. When incompatible, treat as cache miss (render Layer A + generate button). |
| **J** | **Provider Failure Classification** | **Three Distinct Failure Types.** | (1) `PROVIDER_ERROR` (502/timeout/unreachable): "AI 服务暂时不可用，请检查网络或提供商配置"; (2) `EXTRACTION_ERROR` (422/unstructured): "文档物理结构无法解析，无法生成章节概述"; (3) `CANCELLED_ERROR`: "分析已由用户取消或被新文档切换中断". Never collapse into a generic message. |
| **K** | **Honest Progress Reporting** | **NO FAKE PROGRESS BARS.** | Phase 16 rule: no simulated percentage animations (e.g. 10% -> 30% -> 80%). Use an indeterminate spinner accompanied by actual elapsed seconds and an honest status description: "正在分析章节内容（通常需要 30–90 秒）...". |
| **L** | **Source Navigation & "Start Reading"** | **Dynamic Outline Derivation; No Hardcoded Section Titles.** | The "Start Reading" recommendation dynamically identifies the first level-1 section after Abstract, Introduction, and Related Work (e.g. Section 3 `"Deep Residual Learning"` in ResNet). Section names like "Method" or "Experiments" must never be hardcoded. |
| **M** | **Reader Mode Interaction** | **Panes Synchronized; Source Geometry Never Drawn on Translation.** | Overview jump clicks navigate both panes in Bilingual mode and the active pane in Original/Translation modes. Highlight overlays for paragraph/term locations must only be drawn on the Original PDF canvas, never projected onto translation DOM elements. |
| **N** | **No-Document & Document-Switch State** | **Instant Clean Slate on Switch.** | When `document` is null, display "请先打开一篇论文". When switching from Document A to Document B, immediately clear Document A's Overview state, abort any in-flight analysis request, and render Document B's Layer A instantly. |
| **O** | **Stale-Analysis Race Isolation** | **`AbortController` + Session Token Scoping.** | Every overview request carries the active `document_id`. If Document B is opened while Document A's analysis is in flight, Document A's request is aborted via `AbortController`. If a stale response returns, it is discarded if `response.document_id !== activeDocument.id`. |
| **P** | **Responsive Layout & Accessibility** | **ARIA Tabpanel Semantics; 340 px Constrained; High Contrast.** | Overview panel conforms to WAI-ARIA tabpanel (`role="tabpanel"`, `aria-labelledby="assistant-tab-overview"`). All interactive elements are keyboard focusable (`tabIndex={0}`, Enter/Space activation). Typography uses design system tokens (`text-xs`, `text-2xs`). |
| **Q** | **Bundle Discipline (< 350.0 kB)** | **Zero Markdown Renderers, Zero Chart Libraries.** | Baseline is 337.51 kB with ~12.49 kB headroom. Native JSX + Tailwind utility classes only. Overview client code (`OverviewPanel.tsx`, `api/analysis.ts`) must stay under **4.0 kB** minified. |
| **R** | **Provider-Call Accounting** | **Tracked at Egress & Network Layer.** | Track provider calls via backend `LLMProvider.generate` audit log and browser network interceptor. Opening paper: 0 calls. Switching tabs: 0 calls. Reading cached analysis: 0 calls. Explicit generate: bounded sequence of section + synthesis requests. |
| **S** | **Notes Isolation as Evidence** | **Strict Separation: Notes Are Marginalia, Not Evidence.** | Overview describes the scientific paper alone. User marginalia in `annotations` and `annotation_targets` tables are strictly excluded from `AnalysisPipeline` and Overview rendering payloads. |
| **T** | **Prompt Versioning & Pipeline Stability** | **Reuse `PIPELINE_VERSION = "1.0.0"`, `PROMPT_VERSION = "1.0.0"`.** | Layer B reuses the existing backend `DocumentAnalysis` pipeline and prompt version without mutation. If prompts change in the future, `PROMPT_VERSION` bump invalidates cached analyses cleanly. |
| **U** | **Handling Synthetic Partitions** | **Explicit "Auto-Partitioned" Badge.** | When an unsectioned paper yields `SectionAnalysis.synthetic == True`, the UI explicitly displays a badge: "自动分块" with page numbers, never misleading the reader into believing the title was author-created. |
| **V** | **Overview Caching & Invalidation** | **Atomic Persistence in `analysis.json`.** | Overview data is read from and written to `analysis.json` beside `ir.json`. Deleting analysis via `DELETE /documents/{id}/analysis` clears Layer B immediately. Changing source PDF content hash invalidates cache. |

---

## 4. Technical Specifications & Data Flow

### 4.1 Frontend Analysis Client (`frontend/src/api/analysis.ts`)

```typescript
import { requestJson } from "./client";

export interface SectionAnalysisDto {
  section_id: string;
  title: string;
  summary: string;
  page_range: [number, number];
  synthetic: boolean;
}

export interface GlossaryEntryDto {
  source_term: string;
  suggested_translation?: string | null;
  definition?: string | null;
  is_translatable: boolean;
  category?: string | null;
  paragraph_ids: string[];
  confidence?: number | null;
}

export interface AcronymEntryDto {
  acronym: string;
  expansion?: string | null;
  paragraph_ids: string[];
}

export interface DomainRecordDto {
  primary: string;
  secondary: string[];
  confidence: number;
  rationale: string;
  arxiv_category?: string | null;
}

export interface AnalysisErrorDto {
  scope: string;
  code: string;
  message: string;
}

export interface DocumentAnalysisDto {
  document_id: string;
  status: "READY" | "PARTIAL" | "FAILED" | "CANCELLED";
  domain?: DomainRecordDto | null;
  summary?: string | null;
  sections: SectionAnalysisDto[];
  glossary: GlossaryEntryDto[];
  acronyms: AcronymEntryDto[];
  errors: AnalysisErrorDto[];
  reused?: boolean;
}

export async function fetchDocumentAnalysis(documentId: string): Promise<DocumentAnalysisDto | null> {
  try {
    return await requestJson<DocumentAnalysisDto>(`/api/documents/${documentId}/analysis`, {
      method: "GET",
    });
  } catch (err: any) {
    if (err?.code === "ANALYSIS_NOT_FOUND" || err?.status === 404) {
      return null;
    }
    throw err;
  }
}

export async function triggerDocumentAnalysis(
  documentId: string,
  profileId: string,
  targetLanguage: string = "zh-CN",
  signal?: AbortSignal,
): Promise<DocumentAnalysisDto> {
  return await requestJson<DocumentAnalysisDto>(`/api/documents/${documentId}/analysis`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ profile_id: profileId, target_language: targetLanguage }),
    signal,
  });
}
```

### 4.2 Workspace Store Integration (`frontend/src/stores/workspace.ts`)

```typescript
// Extended SidebarPanel tab union
export type SidebarPanel = "overview" | "outline" | "qa" | "notes";

export interface OverviewState {
  analysis: DocumentAnalysisDto | null;
  isLoading: boolean;
  error: UserFacingError | null;
  generationElapsedSeconds: number;
}
```

### 4.3 Algorithmic "Start Reading" Recommendation Ladder (`frontend/src/outline/roadmap.ts`)

```typescript
/**
 * Select the recommended initial reading entry point from the canonical section tree.
 * Rules:
 * 1. Skip Abstract, Introduction, and Related Work.
 * 2. Select the first Level-1 substantive method/architecture section.
 * 3. Fall back to Section 1 (Introduction) if no distinct method section exists.
 */
export function selectRecommendedReadingSection(sections: QaSection[]): QaSection | null {
  if (!sections || sections.length === 0) return null;
  const skipPatterns = [/abstract/i, /introduction/i, /related\s+work/i, /background/i, /preliminar/i];
  
  const substantive = sections.find((s) => {
    if (s.level !== null && s.level > 1) return false;
    return !skipPatterns.some((pattern) => pattern.test(s.title));
  });

  return substantive ?? sections[0];
}
```

---

## 5. Acceptance Criteria Categorization Matrix

The 30 required acceptance areas are systematically addressed across 38 P0 criteria, 6 P1 criteria, and 4 P2 criteria:

| Area # | Required Acceptance Area | Criterion ID | Area Title / Subject |
|---|---|---|---|
| **1** | Zero AI calls on paper open | `AC-P0-01` | Zero Provider Calls on Document Open |
| **2** | Deterministic instant content | `AC-P0-02` | Deterministic Layer A Instant Rendering |
| **3** | Abstract fidelity | `AC-P0-03` | Abstract Verbatim Fidelity & Omission Notice |
| **4** | Section structure | `AC-P0-04` | Algorithmic Reading Roadmap & Outline Fidelity |
| **5** | Cached analysis reuse | `AC-P0-05` | Compatible Cached Analysis Zero-Call Hydration |
| **6** | Explicit Generate Overview action | `AC-P0-06` | Explicit On-Demand Overview Generation |
| **7** | Provider failure | `AC-P0-07` | Tripartite Provider Failure Classification |
| **8** | Progress | `AC-P0-08` | Honest Progress Reporting & No Fake Bars |
| **9** | Cancellation / document switch | `AC-P0-09` | Document Switch Request Cancellation |
| **10** | Stale response isolation | `AC-P0-10` | Stale Response Discard & Document ID Scoping |
| **11** | Grounding | `AC-P0-11` | Coordinate Grounding & Whole-Paper Disclaimer |
| **12** | Clickable source references | `AC-P0-12` | Clickable Page Range & Term Source Jumps |
| **13** | Unsupported claims | `AC-P0-13` | Rejection of Unsupported Speculative Claims |
| **14** | Missing evidence | `AC-P0-14` | Honest Reporting of Missing Evidence & Omissions |
| **15** | Glossary | `AC-P0-15` | Technical Glossary Presentation & Translation |
| **16** | Key terminology | `AC-P0-16` | Exact Identifier & Acronym Case Preservation |
| **17** | Contribution claims | `AC-P0-17` | Objective Grounded Contribution Presentation |
| **18** | Experiments | `AC-P0-18` | Experimental Setup & Evaluation Section Grounding |
| **19** | Limitations | `AC-P0-19` | Prohibition of Fabricated Paper Criticisms |
| **20** | Language | `AC-P0-20` | Chinese UI Chrome & Bilingual Content Integrity |
| **21** | Cost | `AC-P0-21` | Provider Egress Cost Transparency & Counting |
| **22** | Latency | `AC-P0-22` | Instant Layer A & Cached Layer B Latency Floors |
| **23** | Privacy | `AC-P0-23` | Local Credential Scoping & Privacy Isolation |
| **24** | Notes isolation | `AC-P0-24` | Complete Exclusion of User Notes as Evidence |
| **25** | QA isolation | `AC-P0-25` | Paper QA Session & Scope Independence |
| **26** | No semantic retrieval | `AC-P0-26` | Exclusion of Dense Retrieval & Embeddings |
| **27** | No vector DB | `AC-P0-27` | Strict Prohibition of Vector Database Engines |
| **28** | Source immutability | `AC-P0-28` | Source PDF Byte Stream Immutability |
| **29** | Browser E2E | `AC-P0-29` | Full Browser E2E Reading Entry Lifecycle |
| **30** | Real-paper semantic audit | `AC-P0-30` | Three-State Real-Paper Claim Semantic Audit |
| **—** | Sidebar integration | `AC-P0-31` | Unified AssistantSidebar 4th Tab Layout |
| **—** | Partial analysis handling | `AC-P0-32` | Partial Analysis Graceful Degradation |
| **—** | Synthetic partitions | `AC-P0-33` | Clear Badging of Synthetic Outline Partitions |
| **—** | Cache provenance validation | `AC-P0-34` | Strict Provenance Verification via `is_cache_valid` |
| **—** | Reader mode interaction | `AC-P0-35` | Reader Mode Jump & Geometry Isolation |
| **—** | Empty workspace state | `AC-P0-36` | Null Document Clean Empty State |
| **—** | Accessibility | `AC-P0-37` | WAI-ARIA Tabpanel & Keyboard Navigation |
| **—** | Bundle discipline | `AC-P0-38` | Strict Production Bundle Ceiling (< 350.0 kB) |

---

## 6. Numbered Acceptance Criteria

### 6.1 P0 MUST — Paper Overview Core Guarantees

- **AC-P0-01 Zero Provider Calls on Document Open (Decisions C, D; Area 1).**
  Opening an existing or new paper in the reader, switching between Reader modes (`original`, `bilingual`, `translation`), and clicking through all four sidebar tabs (`概览`, `目录`, `问答`, `笔记`) must incur strictly **0 external LLM provider calls** and 0 requests to `POST /documents/{id}/analysis`.
  *Evidence:* Automated Playwright test `tests/e2e/overview-zero-calls.spec.ts` monitoring all network egress; opening ResNet; visiting every sidebar tab; asserting total provider network requests count is exactly `0`.

- **AC-P0-02 Deterministic Layer A Instant Rendering (Decisions A, D; Area 2).**
  When a document registration reaches `ready` and `DocumentIR` is available, Layer A of the Overview panel must render within $\le 50.0\text{ ms}$ without showing a loading spinner. Layer A must display: (1) paper title, (2) abstract, (3) total page and section count, and (4) the first recommended section.
  *Evidence:* Vitest component test `frontend/src/tests/overview-instant.test.tsx` mounting `OverviewPanel` with `mockResNetIr()`; asserting title, abstract, and metrics render synchronously with `queryByTestId("overview-loading")` returning null.

- **AC-P0-03 Abstract Verbatim Fidelity & Omission Notice (Decision A; Area 3).**
  Layer A must display the canonical Abstract text verbatim from paragraphs where `is_abstract = True`. If a paper contains no abstract paragraphs (e.g. a legal brief or code specification), the panel must display "本文档未检测到独立摘要", and must NOT synthesize an abstract or copy the Introduction.
  *Evidence:* Unit test in `frontend/src/tests/overview-instant.test.tsx` passing IR with empty abstract; asserting message `"本文档未检测到独立摘要"` is visible and Introduction text is not rendered in the abstract container.

- **AC-P0-04 Algorithmic Reading Roadmap & Outline Fidelity (Decisions A, L; Area 4).**
  Layer A's reading roadmap must derive dynamically from `ir.sections`. The recommended starting section must be chosen via the algorithmic ladder (first level-1 section following Abstract/Introduction/Related Work), resolving to `"3. Deep Residual Learning"` on ResNet. Section names like `"Method"` or `"Experiments"` must never be hardcoded.
  *Evidence:* Unit test `tests/test_roadmap.py` and frontend test verifying `selectRecommendedReadingSection` returns section `"3. Deep Residual Learning"` for ResNet, and Section 1 for a paper without subsequent headings.

- **AC-P0-05 Compatible Cached Analysis Zero-Call Hydration (Decisions B, I; Area 5).**
  If `analysis.json` exists on disk and satisfies `is_cache_valid`, opening the Overview tab must fetch it via `GET /documents/{id}/analysis` and render Layer B (Summary, Domain, Section Cards, Glossary) immediately with zero provider calls.
  *Evidence:* Playwright test loading a paper with pre-seeded `analysis.json`; asserting `GET /api/documents/{id}/analysis` returns HTTP 200 and Layer B cards render without any outgoing `POST` requests.

- **AC-P0-06 Explicit On-Demand Overview Generation (Decisions D, R; Area 6).**
  When no cached analysis exists (`GET` returns 404), Layer B must display an explicit call-to-action button: "生成 AI 论文概览". Clicking this button initiates `POST /documents/{id}/analysis`. The system must never auto-generate Layer B in the background.
  *Evidence:* Component test verifying that in the absence of cached analysis, `POST /api/documents/{id}/analysis` is only dispatched upon user click of `button[data-testid="generate-overview-button"]`.

- **AC-P0-07 Tripartite Provider Failure Classification (Decision J; Area 7).**
  When analysis generation fails, the UI must distinguish and display one of three exact error states:
  1. `PROVIDER_ERROR` (502 / network timeout): "AI 服务连接失败或超时，请检查配置或重试".
  2. `EXTRACTION_ERROR` (422 / unparseable structure): "论文物理结构无法解析，无法进行章节概述".
  3. `CANCELLED_ERROR`: "分析任务已取消".
  *Evidence:* Mock API test returning HTTP 502, 422, and abort errors; verifying the exact user-facing error message appears for each corresponding failure mode.

- **AC-P0-08 Honest Progress Reporting & No Fake Bars (Decision K; Area 8).**
  While analysis generation is in progress, the UI must render an indeterminate spinner and a live elapsed timer ("已用时 X 秒"). It must NOT render artificial stepped progress bars (e.g. 15% -> 45% -> 80%).
  *Evidence:* DOM snapshot inspection during in-flight generation in `frontend/src/tests/overview-progress.test.tsx`; asserting no `progress` element with simulated `value` exists and elapsed time increments truthfully.

- **AC-P0-09 Document Switch Request Cancellation (Decisions N, O; Area 9).**
  If the reader triggers Overview generation for Paper A and then switches to Paper B before completion, the client must immediately abort Paper A's HTTP request via `AbortController` and clear the Overview panel.
  *Evidence:* Playwright test initiating generation on Paper A, switching to Paper B within 500 ms; verifying Paper A's network request status is `cancelled` / `aborted`.

- **AC-P0-10 Stale Response Discard & Document ID Scoping (Decisions N, O; Area 10).**
  If an analysis response for Paper A arrives after Paper B has already become the active document, the payload must be discarded. Paper B's Overview must never display Paper A's summary or glossary.
  *Evidence:* Frontend test mocking a delayed response for Paper A arriving after `setActiveDocument("doc-B")`; asserting `useWorkspaceStore.getState().overview.analysis` remains null or belongs strictly to Document B.

- **AC-P0-11 Coordinate Grounding & Whole-Paper Disclaimer (Decisions B, F; Area 11).**
  Every section summary card must display its canonical `page_range` badge (e.g. `p. 3–5`). The executive paper summary must carry an explicit disclaimer badge: "基于全文综合分析生成", indicating whole-paper scope.
  *Evidence:* Vitest inspection of rendered Layer B DOM; asserting all section summary cards contain `data-testid="section-page-range"` and the root summary contains the disclaimer attribute.

- **AC-P0-12 Clickable Page Range & Term Source Jumps (Decisions G, L; Area 12).**
  Clicking a section's page badge must invoke `jumpToPage` or `jumpToSection`, scrolling the PDF reader to that section. Clicking a glossary term must scroll the PDF reader to the term's first occurrence paragraph and trigger a transient highlight.
  *Evidence:* E2E test clicking the `p. 3` badge on Section 3 card; asserting PDF viewer scroll top aligns with Page 3's viewport coordinates.

- **AC-P0-13 Rejection of Unsupported Speculative Claims (Decisions B, F; Area 13).**
  The Overview must not present speculative conclusions not present in `DocumentAnalysis`. Any section where analysis returned an empty summary must display "本节暂无详细摘要", rather than inventing speculative claims.
  *Evidence:* Semantic audit test on mock analysis with empty section summary asserting placeholder text is displayed.

- **AC-P0-14 Honest Reporting of Missing Evidence & Omissions (Decisions B, H; Area 14).**
  When a section failed analysis (recorded in `analysis.errors`), that section card must render an inline notice: "该章节概述生成失败，正文阅读不受影响", with the specific failure reason.
  *Evidence:* Component test with `analysis.errors` containing `{ scope: "s_4", message: "Timeout" }`; verifying Section 4 card displays the failure notice.

- **AC-P0-15 Technical Glossary Presentation & Translation (Decisions B, E; Area 15).**
  Glossary entries from `DocumentAnalysis.glossary` must be rendered in a dedicated "核心术语" card, displaying `source_term`, `suggested_translation` (if available), and `definition`. Terms marked `is_translatable = false` must display an "专有名词" badge.
  *Evidence:* Rendering ResNet analysis glossary; asserting terms like `"Residual Learning"` show translation `"残差学习"`, and `"ResNet-50"` carries the non-translatable badge.

- **AC-P0-16 Exact Identifier & Acronym Case Preservation (Decisions B, E; Area 16).**
  Model names, acronyms, and dataset identifiers (`ResNet`, `CIFAR-10`, `ImageNet`, `BN`, `SGD`) must preserve their exact source casing and hyphenation. They must never be lowercased or improperly translated.
  *Evidence:* Automated string equality checks in `frontend/src/tests/overview-terms.test.tsx` verifying `"ResNet"` is not converted to `"resnet"` or `"残差网络"`.

- **AC-P0-17 Objective Grounded Contribution Presentation (Decisions B, F; Area 17).**
  Because `DocumentAnalysis` lacks a dedicated "contributions" prompt field, the Overview must NOT hallucinate an isolated "Contributions" card. Any contribution claims must be presented under their originating section (e.g. Introduction card) or under the whole-paper summary.
  *Evidence:* DOM inspection confirming no separate `<div data-testid="overview-contributions-card">` is rendered unless an author section explicitly carried the title "Contributions".

- **AC-P0-18 Experimental Setup & Evaluation Section Grounding (Decisions B, F; Area 18).**
  Experimental findings must be sourced directly from the `SectionAnalysis` corresponding to evaluation sections (e.g. `"4. Experiments"` in ResNet). The card must link directly to the experiment pages (`p. 5–11`).
  *Evidence:* E2E test verifying Experiments card contains the exact page range `5–11` and clicking it jumps to Page 5.

- **AC-P0-19 Prohibition of Fabricated Paper Criticisms (Decisions B, F; Area 19).**
  The Overview must never synthesize speculative criticisms, flaws, or limitations if the paper contains no dedicated Limitations section. In the absence of an author Limitations section, the UI must state: "原论文未设独立局限性章节".
  *Evidence:* Semantic verification test on ResNet (which lacks a limitations section); asserting the panel contains no fabricated negative claims about ResNet.

- **AC-P0-20 Chinese UI Chrome & Bilingual Content Integrity (Decision E; Area 20).**
  All UI buttons, tabs, headers, and status badges must be in simplified Chinese (`"概览"`, `"目录"`, `"核心观点"`, `"推荐起始阅读"`). Content originating in English from the analysis must be rendered faithfully without corrupting machine translations.
  *Evidence:* Localization test verifying zero English text in structural UI labels and correct rendering of English summary text.

- **AC-P0-21 Provider Egress Cost Transparency & Counting (Decisions D, R; Area 21).**
  The "生成概览" button must display estimated provider cost/tokens before execution. The actual number of provider requests executed during generation must be recorded and verifiable via the backend audit log.
  *Evidence:* Backend test verifying `pipeline.requests_made` matches the number of sections analysed plus 1 synthesis request.

- **AC-P0-22 Instant Layer A & Cached Layer B Latency Floors (Decisions A, B; Area 22).**
  Layer A must render in $\le 50.0\text{ ms}$ from memory. Cached Layer B must render in $\le 100.0\text{ ms}$ from disk cache.
  *Evidence:* Performance benchmark test in `frontend/src/tests/overview-perf.test.tsx` measuring render execution time.

- **AC-P0-23 Local Credential Scoping & Privacy Isolation (Decisions D, I; Area 23).**
  Analysis requests must only use configured local `profile_id` references. API keys and credentials must never be passed to the browser or stored in `analysis.json` provenance.
  *Evidence:* Inspecting `analysis.json` schema and network payloads; asserting no API keys or secrets are serialized.

- **AC-P0-24 Complete Exclusion of User Notes as Evidence (Decision S; Area 24).**
  The Overview generation pipeline and rendering logic must NOT read from `annotations` or `annotation_targets`. User notes must never be injected into provider prompts or displayed in the Overview.
  *Evidence:* Automated test creating 10 user notes in SQLite; generating overview; asserting zero note text tokens appear in the provider request payload or generated overview.

- **AC-P0-25 Paper QA Session & Scope Independence (Decisions B, C; Area 25).**
  Generating or viewing an Overview must have zero side effects on Paper QA: it must not alter `activeQaTurn`, clear QA history, or modify `ScopeSelector`.
  *Evidence:* Test running a QA turn; opening Overview tab; generating overview; switching back to QA tab; asserting QA conversation turns are completely preserved.

- **AC-P0-26 Exclusion of Dense Retrieval & Embeddings (Core Principles; Area 26).**
  The Overview subsystem must NOT invoke semantic embeddings, vector models, or dense re-ranking algorithms. All section matching must use canonical outline IDs and exact paragraph IDs.
  *Evidence:* Codebase audit asserting zero imports of embedding models (`sentence-transformers`, `chroma`, `faiss`) in the overview path.

- **AC-P0-27 Strict Prohibition of Vector Database Engines (Core Principles; Area 27).**
  The repository must not introduce vector database dependencies (`chromadb`, `qdrant`, `weaviate`, `pinecone`). All persistence is confined to SQLite and atomic `analysis.json`.
  *Evidence:* Automated check of `pyproject.toml` and `package.json` confirming absence of vector database packages.

- **AC-P0-28 Source PDF Byte Stream Immutability (Core Principles; Area 28).**
  Generating, reading, or caching an Overview must never mutate the source PDF file on disk. `sha256(source.pdf)` must remain bit-for-bit identical before and after overview operations.
  *Evidence:* File hash assertion in `tests/test_overview_persistence.py` verifying PDF hash invariant.

- **AC-P0-29 Full Browser E2E Reading Entry Lifecycle (Decisions C, D, L; Area 29).**
  Playwright E2E test verifying complete user journey: open ResNet; observe instant Layer A; verify title, abstract, and recommended reading section ("3. Deep Residual Learning"); click "生成概览"; observe progress timer; verify Layer B cards render; click "p. 3" badge; verify viewer navigates to page 3.
  *Evidence:* Playwright test `tests/e2e/overview-full-lifecycle.spec.ts` passes with exit code 0.

- **AC-P0-30 Three-State Real-Paper Claim Semantic Audit (Area 30).**
  The semantic audit on real ResNet analysis must evaluate every generated claim into strictly one of three states: **SUPPORTED**, **PARTIALLY_SUPPORTED**, or **UNSUPPORTED**. Collapsing into a subjective numeric score is forbidden.
  *Evidence:* Executable verification script `tests/test_semantic_audit.py` validating audit records against source text citations (see Section 7.4).

- **AC-P0-31 Unified AssistantSidebar 4th Tab Layout (Decision C).**
  The Overview panel must be integrated as the 4th tab (`概览`) in `AssistantSidebar` alongside `目录`, `问答`, and `笔记`. It must adhere strictly to `SIDEBAR_WIDTH_PX = 340`. No 4th column or secondary sidebar may be mounted.
  *Evidence:* Layout test asserting `document.querySelectorAll("aside").length === 1` and computed style width is exactly `340px`.

- **AC-P0-32 Partial Analysis Graceful Degradation (Decisions B, H).**
  If `analysis.status === "PARTIAL"`, the Overview must render all successfully generated section cards and terms, accompanied by an informative top badge: "部分章节分析已就绪". It must never crash or display an empty screen.
  *Evidence:* Vitest test loading ResNet's actual `PARTIAL` analysis; verifying all 7 sections and 207 terms render correctly.

- **AC-P0-33 Clear Badging of Synthetic Outline Partitions (Decision U).**
  When a section has `synthetic = True` (auto-partitioned unsectioned text), its card must prominently display a badge: "自动分块", distinguishing it from author-written section headings.
  *Evidence:* Rendering mock analysis containing synthetic sections; asserting badge `[data-testid="synthetic-badge"]` is visible.

- **AC-P0-34 Strict Provenance Verification via `is_cache_valid` (Decision I).**
  Overview cache loading must execute `is_cache_valid()`. If `ir_pipeline_version` or `prompt_version` does not match the active environment, the cache must be rejected as invalid.
  *Evidence:* Unit test in `tests/test_context_cache.py` asserting modified prompt version produces a cache miss.

- **AC-P0-35 Reader Mode Jump & Geometry Isolation (Decision M).**
  Clicking Overview jump links while in Bilingual or Translation reader mode must scroll both panes synchronously. Highlights for source terms must be drawn solely on the original canvas, never projected onto translation DOM elements.
  *Evidence:* Playwright test in Bilingual mode clicking term jump; asserting translation container contains zero raw source bounding box overlays.

- **AC-P0-36 Null Document Clean Empty State (Decision N).**
  When no document is currently open in the workspace, the Overview panel must render the empty state: "请先打开一篇论文", without errors or broken layout.
  *Evidence:* Mounting `OverviewPanel` with `document = null`; asserting empty state text is displayed.

- **AC-P0-37 WAI-ARIA Tabpanel & Keyboard Navigation (Decision P).**
  The Overview tab button must have `role="tab"`, and the panel must have `role="tabpanel"` with appropriate `aria-controls` and `aria-labelledby` linkages. All jump buttons and action buttons must be accessible via keyboard (`Tab`, `Enter`, `Space`).
  *Evidence:* Playwright accessibility audit asserting zero ARIA violations on `assistant-tabpanel-overview`.

- **AC-P0-38 Strict Production Bundle Ceiling (< 350.0 kB) (Decision Q).**
  Implementing `OverviewPanel.tsx`, `api/analysis.ts`, and related UI additions must not add external libraries (`react-markdown`, `marked`, `chart.js`). The production build (`npm run build`) must remain strictly under the **350.0 kB** ceiling, consuming $\le 4.0\text{ kB}$ of the available ~12.49 kB headroom.
  *Evidence:* Vite production build output confirms initial bundle size $\le 350.0\text{ kB}$.

---

### 6.2 P1 SHOULD — Usability & Extended Workflows

- **AC-P1-01 User Preference Auto-Generate Toggle (Decision D).**
  Provide an opt-in toggle in Settings: "打开论文时自动加载/生成概览" (default: OFF). When enabled by the user, Layer B generation is automatically scheduled upon document open.
  *Evidence:* Unit test verifying toggle state in localStorage and triggered action.

- **AC-P1-02 Export Overview as Markdown Document.**
  Provide an "导出概览" (Export Overview) button in the panel header that downloads a clean Markdown file summarizing the paper's title, abstract, section summaries, and key vocabulary.
  *Evidence:* Browser test clicking export; verifying downloaded `.md` content structure.

- **AC-P1-03 Filter Key Terms by Category.**
  Provide filter pills in the Key Terminology card to filter by `model`, `dataset`, `benchmark`, and `metric`.
  *Evidence:* Clicking "模型 (Models)" filter displays only model entities (e.g. `ResNet-50`, `VGG-19`).

- **AC-P1-04 Collapsible Section Summaries in Reading Roadmap.**
  Allow readers to expand and collapse individual section summaries in the roadmap to customize density.
  *Evidence:* Clicking accordion toggle collapses Section 2 summary.

- **AC-P1-05 Bilingual Summary Translation Toggle.**
  Provide a toggle button on English section summaries allowing the reader to request an in-place Chinese translation of the summary prose.
  *Evidence:* Clicking "翻译概述" translates English summary into Chinese.

- **AC-P1-06 Quick Ask Paper QA from Overview Card.**
  Provide a "以此提问" button on each section summary card that populates Paper QA Composer with context scoped to that section.
  *Evidence:* Clicking button switches to QA tab with section scope pre-selected.

---

### 6.3 P2 OPTIONAL — Advanced Exploration & Multi-Paper Aggregation

- **AC-P2-01 Multi-Paper Comparative Overview Shelf.**
  A global library view comparing the core problem, method, and benchmark results across multiple analyzed papers side by side.
  *Evidence:* Library view rendering comparative table for 3 papers.

- **AC-P2-02 Citation Graph & Entity Link Visualizer.**
  An interactive lightweight visual graph showing connections between models, datasets, and methods mentioned in the paper.
  *Evidence:* Entity network graph renders within canvas.

- **AC-P2-03 Text-to-Speech Audio Read-Aloud for Abstract and Summary.**
  Provide an audio play button allowing readers to listen to the Abstract and executive summary.
  *Evidence:* Clicking play triggers Web Speech API synthesis.

- **AC-P2-04 Cross-Document Terminology Consistency Checker.**
  Highlight terms in the Overview that share conflicting definitions across different papers in the reader's local library.
  *Evidence:* Term pill displays warning when definition diverges from another paper.

---

## 7. Verification Protocol

Every verification step below is executable, non-tautological, and capable of failing.

### 7.1 Instant Layer A Component Verification (`frontend/src/tests/overview-instant.test.tsx`)

```typescript
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { OverviewPanel } from "@/assistant/OverviewPanel";
import { mockResNetIr } from "./fixtures";

describe("OverviewPanel - Layer A Instant Rendering", () => {
  it("renders title, abstract, and metrics instantly without provider calls", () => {
    const ir = mockResNetIr();
    render(<OverviewPanel ir={ir} analysis={null} isLoading={false} />);

    // Title verification
    expect(screen.getByText("Deep Residual Learning for Image Recognition")).toBeInTheDocument();
    
    // Abstract verification
    expect(screen.getByTestId("overview-abstract")).toHaveTextContent(
      "Deeper neural networks are more difficult to train."
    );

    // Structural metrics
    expect(screen.getByTestId("metric-page-count")).toHaveTextContent("12");
    expect(screen.getByTestId("metric-section-count")).toHaveTextContent("7");

    // Recommended reading section
    expect(screen.getByTestId("recommended-reading-section")).toHaveTextContent(
      "3. Deep Residual Learning"
    );
  });
});
```

### 7.2 Zero Provider Calls E2E Verification (`tests/e2e/overview-zero-calls.spec.ts`)

```typescript
import { test, expect } from "@playwright/test";

test("opening paper and clicking all tabs produces 0 provider calls", async ({ page }) => {
  const providerRequests: string[] = [];
  
  // Intercept all outgoing network traffic
  await page.route("**/api/**", (route) => {
    const url = route.request().url();
    if (url.includes("/analysis") && route.request().method() === "POST") {
      providerRequests.push(url);
    }
    if (url.includes("/answer")) {
      providerRequests.push(url);
    }
    route.continue();
  });

  await page.goto("/#doc=1e0651b6810e");
  await page.waitForSelector('[data-testid="assistant-sidebar"]');

  // Switch through all 4 tabs
  await page.click('[data-testid="assistant-tab-overview"]');
  await page.waitForTimeout(200);
  await page.click('[data-testid="assistant-tab-outline"]');
  await page.waitForTimeout(200);
  await page.click('[data-testid="assistant-tab-qa"]');
  await page.waitForTimeout(200);
  await page.click('[data-testid="assistant-tab-notes"]');
  await page.waitForTimeout(200);
  await page.click('[data-testid="assistant-tab-overview"]');

  // Verify provider calls remain strictly 0
  expect(providerRequests).toHaveLength(0);
});
```

### 7.3 Notes Isolation Verification (`tests/test_notes_isolation.py`)

```python
import pytest
from app.context.pipeline import AnalysisPipeline
from app.document.models import DocumentIR

def test_analysis_pipeline_ignores_notes_database(document_store, mock_provider):
    # Seed 5 user notes into SQLite
    doc_id = "test_doc_001"
    document_store.create_annotation(doc_id, quote="My personal thought", text="Check this later")

    ir = document_store.get_ir(doc_id)
    pipeline = AnalysisPipeline(mock_provider)

    # Inspect messages sent to provider
    messages_sent = []
    def intercepting_complete(msgs, max_tokens):
        messages_sent.extend(msgs)
        return '{"summary": "test", "sections": [], "glossary": [], "acronyms": [], "entities": []}'

    pipeline._complete = intercepting_complete
    analysis = pipeline.analyse(ir)

    # Verify no note content leaked into prompts
    full_prompt_text = " ".join(m["content"] for m in messages_sent)
    assert "My personal thought" not in full_prompt_text
    assert "Check this later" not in full_prompt_text
```

### 7.4 Real-Paper Semantic Audit Protocol (`tests/test_semantic_audit.py`)

```python
from enum import Enum
from pydantic import BaseModel

class ClaimStatus(str, Enum):
    SUPPORTED = "SUPPORTED"
    PARTIALLY_SUPPORTED = "PARTIALLY_SUPPORTED"
    UNSUPPORTED = "UNSUPPORTED"

class AuditRecord(BaseModel):
    claim_id: str
    claim_text: str
    status: ClaimStatus
    source_citation: str
    missing_elements: list[str]

# Real-paper semantic audit records for ResNet (1512.03385v1)
RESNET_AUDIT_DATA = [
    AuditRecord(
        claim_id="C-01",
        claim_text="Residual networks reformulate layers as learning residual functions with reference to layer inputs.",
        status=ClaimStatus.SUPPORTED,
        source_citation="Page 1, Abstract, Lines 15-18; Page 3, Section 3.1",
        missing_elements=[],
    ),
    AuditRecord(
        claim_id="C-02",
        claim_text="ResNet evaluates depth up to 152 layers on ImageNet, achieving 3.57% top-5 error.",
        status=ClaimStatus.SUPPORTED,
        source_citation="Page 1, Abstract, Lines 25-27; Page 5, Table 1",
        missing_elements=[],
    ),
    AuditRecord(
        claim_id="C-03",
        claim_text="The degradation problem is caused by vanishing gradients.",
        status=ClaimStatus.PARTIALLY_SUPPORTED,
        source_citation="Page 2, Section 1: 'unexpectedly, such degradation is not caused by vanishing gradients'",
        missing_elements=["Contradicts paper assertion: paper specifically proves degradation is NOT vanishing gradients"],
    ),
    AuditRecord(
        claim_id="C-04",
        claim_text="Residual connections suffer from severe GPU memory overhead during backward pass.",
        status=ClaimStatus.UNSUPPORTED,
        source_citation="None (Not present in paper)",
        missing_elements=["Paper does not analyze backward memory overhead; claim is hallucinated criticism"],
    ),
]

def test_semantic_audit_classification():
    for record in RESNET_AUDIT_DATA:
        assert record.status in (ClaimStatus.SUPPORTED, ClaimStatus.PARTIALLY_SUPPORTED, ClaimStatus.UNSUPPORTED)
        if record.status == ClaimStatus.UNSUPPORTED:
            assert len(record.missing_elements) > 0
```

---

## 8. Non-Goals & Explicit Boundary Exclusions

To ensure strict execution focus and prevent architectural bloat, the following areas are designated as **explicit non-goals** for DS-QA-014:

1. **No Dense Vector / Embedding Indexing:** No vector database (`chromadb`, `faiss`, `qdrant`) or embedding model pipeline will be introduced.
2. **No Interactive Chat Synthesis in Overview:** Overview is a structured orientation panel; it does not introduce a secondary conversational chat interface. Chat remains exclusively in Paper QA.
3. **No Modification of Notes Architecture:** The notes data model, SQLite tables (`annotations`, `annotation_targets`), and reattachment cascade are untouched.
4. **No Speculative Criticisms / Hallucinated Limitations:** The system will never speculate about study flaws or limitations if the authors did not include a dedicated limitations section.
5. **No Fourth Sidebar Column:** The application layout remains strictly one sidebar at `SIDEBAR_WIDTH_PX = 340`. No secondary or floating sidebars may be added.
6. **No External Heavy UI Frameworks:** Markdown rendering frameworks (`react-markdown`) and charting suites (`recharts`) are forbidden to preserve the 350.0 kB bundle limit.
7. **No Automatic Background Provider Calls:** Opening papers, changing tabs, or navigating pages will never trigger automatic provider calls. All AI generation is strictly opt-in on-demand.
