You are the independent Acceptance Criteria author for a local-first academic PDF
reader + bilingual translator ("Academic PDF Copilot"). You are Gemini; the lead
engineer is DeepSeek, who will implement what you specify. You define the criteria;
you do not write production code.

Your criteria for the previous fourteen tasks have been used as written, and you
have twice corrected a false premise in a brief of ours. Do that again if you find
one here — an unimplementable or self-contradictory criterion is worse than no
criterion.

# The task

DS-QA-003 — Paper QA Sidebar + Citation Jumping. Turn the already validated
single-turn grounded QA backend into a reader-side experience: open a paper,
choose a scope, ask a question, read a grounded answer, click a citation, land on
the real page in the original PDF.

This is frontend/product integration. Do not redesign retrieval or answer
generation. No embeddings, no multi-turn memory, no web search, no agent loop, and
no weakening of grounding to make the UI look more capable.

# The backend contract — already built, frozen, and measured

`POST /api/documents/{document_id}/answer`

```jsonc
// request — `extra="forbid"`, so an unknown field is a 422 and not a silent ignore
{
  "question": "string, min_length 1",
  "scope": {"type": "whole_paper" | "section" | "page" | "selection", ...},
  "profile_id": "string",          // which configured provider to use
  "top_k": 8,                       // 1..50
  "language": null                  // optional override; default = the question's language
}
```

Note what the request does **not** accept: there is no `evidence_bundle` field.
Evidence never arrives from a client — it is retrieved in-process. A bundle
supplied by a caller would let it choose the text the model cites while the
citations still resolved to real pages, which is a fabricated citation with
perfect metadata.

The scope object, verbatim from `app/qa/models.py`:

```python
class Scope(BaseModel):            # extra="forbid"
    type: Literal["whole_paper", "section", "page", "selection"]
    page: int | None = Field(default=None, ge=1)   # for "page"   — 1-BASED
    section_id: str | None = None                  # for "section"
    paragraph_ids: list[str] | None = None         # for "selection"
```

Response (200), verbatim from `app/qa/models.py`:

```python
AnswerStatus = Literal["answered", "partial", "insufficient_evidence"]

class ResolvedCitation(BaseModel):   # extra="forbid"
    citation_id: str                 # "E1" — the marker the model wrote
    paragraph_id: str
    section_id: str | None = None
    section_title: str | None = None
    page_number: int = Field(ge=1)   # 1-based, from the DocumentIR
    page_range: list[int] = []
    block_ids: list[str] = []
    bboxes: list[list[float]] = []   # [x0, y0, x1, y1] per block, PDF points, TOP-LEFT origin
    snippet: str = ""                # a verbatim prefix of the source, cut at a sentence
    is_caption: bool = False

class AnswerDiagnostics(BaseModel):
    code: str                        # "SUCCESS" | "NO_EVIDENCE" | "MALFORMED_OUTPUT"
                                     # | "UNGROUNDED_MODEL_OUTPUT"
    execution_time_ms: float
    requests_made: int               # 0 on the deterministic no-evidence path
    prompt_tokens: int
    completion_tokens: int
    repair_attempted: bool
    evidence_items: int
    evidence_dropped: int
    dropped_citations: list[str]
    suggest_scope_expansion: bool    # a narrow scope abstained but the paper answers

class AnswerResult(BaseModel):       # extra="forbid"
    document_id: str
    question: str
    status: AnswerStatus
    answer: str                      # Markdown with inline "[E1]" markers; "" when abstaining
    citations: list[ResolvedCitation]# derived from the markers, first-appearance order, deduped
    unanswered_aspects: list[str]    # required non-empty when status == "partial"
    missing_evidence_rationale: str | None
    diagnostics: AnswerDiagnostics
```

Errors are a **different outcome** and come back as the standard envelope
`{"error": {"code", "message", "detail"}}` with HTTP 502:

```
LLM_AUTHENTICATION_ERROR  LLM_PERMISSION_DENIED  LLM_RATE_LIMIT  LLM_TIMEOUT
LLM_SERVER_ERROR  LLM_OUTPUT_TRUNCATED  LLM_BAD_REQUEST  LLM_NOT_FOUND
LLM_CONNECTION_ERROR  LLM_INVALID_RESPONSE  LLM_API_ERROR
```

plus `404 NOT_FOUND` for an unknown document or profile, and `422 VALIDATION_ERROR`
for a malformed scope. The backend reports a provider failure as an error and an
evidence failure as a **200 with `insufficient_evidence`**; the frontend must keep
those two apart in both state and presentation.

Also available and currently unused by the frontend:

```
GET /api/documents/{id}/sections
  → [{"id", "title", "level", "page_number", "is_references"}]   # page_number is 1-based
GET /api/documents/{id}/page-mapping
  → {"document_id", "page_mapping": {paragraph_id: page_number}}
```

Measured behaviour of this backend, from DS-QA-002 (real provider, real papers):
16 of 16 deliberately unanswerable questions abstained with zero false answers;
22 answers all carried structurally valid citations; a counterfactual arm proved
the answers follow the supplied evidence rather than the model's memory. Known
and preserved limitations: ~5% of answers are withheld by a conservative
validator, retrieval can miss conceptually-related evidence, and one
over-abstention was observed. Do not specify UI that hides these.

# The existing frontend — the real code

## The placeholder you are replacing

`src/assistant/AssistantSidebar.tsx` renders, in order: `ScopeSelector`,
`QuickActions`, `ConversationArea`, `Composer`. It is a **fake**: `submitComposer`
pushes the question and then a canned reply.

```ts
// src/stores/workspace.ts
const NO_BACKEND_NOTICE =
  "论文问答（Paper QA）尚未实现（Phase 8）。此回复不是论文内容。";

submitComposer: () => {
  const text = get().composerValue.trim();
  if (!text) return;                                            // AC-18
  set((s) => ({
    composerValue: "",
    messages: [...s.messages,
      { id: nextMessageId(), role: "user", content: text },
      { id: nextMessageId(), role: "assistant", content: NO_BACKEND_NOTICE }],
  }));
},
```

The scope control is a `<select>` over `AssistantScope = "selection" | "page" |
"section" | "document"` — note `"document"`, where the backend says
`"whole_paper"`. The store also carries `QUICK_ACTIONS = ["总结本页", "解释选中内容",
"解释公式", "总结方法", "提取创新点", "总结实验结果"]`, which currently produce the same
canned reply.

`Composer` submits on Enter **without checking `isComposing`**:

```tsx
const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitComposer();
  }
};
```

That is a live Chinese-IME bug: pressing Enter to confirm a composition submits a
half-typed question. Fixing it is in scope.

## The document identity pattern that already exists

```ts
export interface OpenDocument {
  sessionToken: string;      // minted per opening of a file; "open-1", "open-2", …
  name: string;
  file: File;                // parsed locally; reading never uploads
  documentId: string | null; // backend identity, null until registration succeeds
  registration: "pending" | "ready" | "failed";
  registrationError: UserFacingError | null;
  backendPageCount: number | null;
}

export function selectActiveTranslation(state) {
  const { document, translation } = state;
  if (!document || !translation) return null;
  if (document.documentId === null) return null;
  if (translation.documentId !== document.documentId) return null;
  if (translation.sessionToken !== document.sessionToken) return null;   // ← the guard
  return translation;
}
```

`sessionToken` exists precisely so a late response from a *previous opening of the
same file* can be dropped. Any QA state you specify should reuse this mechanism
rather than invent a second one.

## The reader

`ReaderWorkspace` mounts one or two **independent** `PdfWorkspace` panes:

```tsx
{showOriginal   && <PdfWorkspace testId="viewer-original"   source={originalSource} onFileChosen={openDocument} />}
{showTranslated && <PdfWorkspace testId="viewer-translated" source={translatedSource} … />}
```

`showOriginal` is true in `original` and `bilingual`; `showTranslated` is true in
`translation` and `bilingual`. Modes come from `selectEffectiveMode`, which falls
back to `original` whenever no translated artifact exists.

`PdfWorkspace` is self-contained. **It currently exposes nothing to its parent**:
`currentPage`, `pageCount`, `zoom` and the `viewerRef` are all internal state, and
there is no prop for "jump to page N". `PdfViewer` does expose
`scrollToPage(page)` through a `viewerRef` handle:

```ts
export interface PdfViewerHandle { scrollToPage: (page: number) => void; }
```

Pages are rendered by `PdfPage`, which draws a canvas **and a real PDF.js
`TextLayer`** (`pdfjs.TextLayer` with `setLayerDimensions`), so text is selectable
in the DOM. What does **not** exist anywhere in the frontend:

* any selection model — no `selectionchange`, no `mouseup` handler, nothing that
  reads `window.getSelection()`;
* any mapping from a DOM selection to `ParagraphIR.id` or to paragraph bboxes;
* any page-coordinate transform — nothing converts a viewport scale or a PDF
  point into screen coordinates;
* any section lookup by page.

So **Selection scope has no implementation path today.** `ParagraphIR` does carry
`bboxes` (`[x0, y0, x1, y1]`, PDF points, top-left origin) and a 1-based
`page_number`, and `PdfPage` computes `page.getViewport({scale})` for rendering —
so the pieces exist, but joining them into "the user selected these paragraphs"
is a substantial task of its own.

## Size and dependency discipline

```
dist/assets/index-*.js            275.21 kB   (initial, gzip 91.16 kB)
dist/assets/pdf-*.js              483.14 kB   (lazy, loaded on first open)
dist/assets/pdf.worker.min-*.mjs  1265.41 kB
```

There is **no Markdown renderer and no math renderer** in `package.json`. The
PDF.js import is deliberately lazy (`loadPdfjs()`), and the initial bundle is the
one worth protecting.

## Tests

Vitest + Testing Library + jsdom, 78 tests in 7 files. `setup.ts` stubs
`IntersectionObserver`, `ResizeObserver`, `scrollTo`, object URLs, and gives the
PDF viewer a client width; it snapshots the store's initial state and restores it
after every test. `fixtures.ts` seeds documents and translations. Real-browser
verification in this project has used Edge via Playwright (`playwright` is already
a devDependency).

# Decisions we need you to make explicitly

**A.** A citation is clicked while the reader is in **Translation** mode. Switch to
Original, show a source preview only, or something else? The translated PDF has
different page geometry from the source (it is a re-laid-out document), so a
source page number and a source bbox are not meaningful there.

**B.** Same question in **Bilingual**. Should only the original pane move, or both
panes to the same logical page? Bilingual today is two independent viewers with no
scroll lockstep.

**C.** Is bbox highlighting P0, P1, or P2? Weigh it against the fact that no
coordinate transform exists yet, and that the highlight must never be drawn on the
translated pane.

**D.** Selection scope: P0, P1, or deferred to a dedicated task? The evidence above
is that no selection→paragraph mapping exists.

**E.** How should source evidence be previewed — inline expansion, popover, side
list, compact card?

**F.** Should the sidebar keep a visible list of previous questions and answers,
given that every backend request must remain independent and single-turn?

# Constraints

* The PDF stays the visual centre. Calm, compact, dense, academic, desktop. No
  chat bubbles, avatars, gradients for decoration, or animated "thinking".
* Do not specify a second assistant surface. The sidebar is the one place.
* Do not specify anything that needs a backend change, a new endpoint, a new
  provider call, or a new dependency unless you say plainly that it is new.
* The answer text arrives as Markdown with inline `[E1]` markers. Normal users must
  not see `E1` or raw paragraph ids.
* Page numbers must come from `ResolvedCitation`, never from parsing the answer.
* A user-selected scope is a constraint. Widening it is a user action, never an
  automatic one.
* Do not log or display credentials. Provider profile and model names are fine.

Cover at least: sidebar lifecycle and the no-document state · the four scopes and
what happens when a scope has no identity · question input including Chinese IME ·
submit-button state and duplicate in-flight prevention · loading · the four
semantic states (`answered`, `partial`, `insufficient_evidence`, and a *transport*
error, which is a different axis) · unknown statuses and malformed responses ·
citation rendering, ordering, deduplication, preview and click · page-number
conversion between the 1-based UI and the 1-based API · the three reader modes ·
document-switch and scope-switch races · accessibility and keyboard navigation ·
layout at 1024/1440/1920 · bundle regression · frontend tests · and the real-browser
end-to-end checks.

Answer A–F explicitly. Where you disagree with this brief, say so and say why.
