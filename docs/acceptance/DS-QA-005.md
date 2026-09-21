# Acceptance Criteria — DS-QA-005: Selection → ParagraphIR Mapping + Selection QA

- **Author:** project maintainer.
  The criteria returned its criteria in the session rather than writing this file; §2–§7 are
  transcribed from that output with nothing added or removed. §1 is the review,
  written before implementation.
- **Reviewed and frozen by:** project maintainer
- **Date:** 2026-09-18
- **Baseline:** `79ed9ec` (DS-QA-004 disposition)
- **Status:** **FROZEN**, with **4 `AC_CHANGE_REQUEST`s** raised in review below.
  **12 P0 · 0 P1 · 0 P2.**

---

## 1. Review before implementation

The criteria confirmed the local-mapping decision and corrected **five** premises, three of which
matter. Two of them I verified against the repository rather than taking on trust.

**It is right that a bounding rect is wrong for two columns.** The criterion requires
`range.getClientRects()` and forbids `getBoundingClientRect()`. Measured on the ResNet paper:
page 3's left column runs x=49→287 of a 612 pt page, so a selection's *overall* rect spans the
gutter and would intersect every right-column paragraph at the same height. My own probe had
already produced the same warning from the other direction — a range over four adjacent DOM
spans walked into a figure's axis labels — and the two together settle it: **geometry per line
fragment, never one box, and never DOM order.**

**It is right that headings are not paragraphs.** I checked rather than assuming: of 101
paragraphs in the ResNet IR, **zero** have a section title as their text. A selection of a
heading alone therefore maps to nothing, and inventing an id for it — or expanding it to the
section it governs — would be fabricating identity. AC-05's rejection is correct.

**It resolved cross-page selection by deferring it**, which is the honest call given the
viewer's windowing: both pages must be mounted for a browser range to span them, and an unmount
mid-drag collapses the range.

### AC_CHANGE_REQUEST 1 — AC-09 names an endpoint and a field that do not exist

| | |
|---|---|
| **As written** | *"the request payload to `/api/chat` or `/api/qa`"* with `{"query": ..., "scope": {...}}`. |
| **Problem** | There is no `/api/chat` and no `/api/qa`. The endpoint is `POST /api/documents/{document_id}/answer`, the field is `question`, and the payload also carries a `profile_id` — all of which DS-QA-002 and DS-QA-003 built and DS-QA-003's browser run exercises. A criterion naming a nonexistent route cannot be verified against the running system, and a test written to it would pass while proving nothing. |
| **Resolution** | The criterion keeps its substance — the scope object is exactly `{"type": "selection", "paragraph_ids": [...]}` with no extra keys, and an empty list must never fall back to `whole_paper` — and names the real endpoint and the real field. The `extra="forbid"` requirement, which is the load-bearing part, is unchanged and is already enforced by the backend. |
| **Not accepted** | Adding an `/api/qa` alias so the criterion as written becomes true. |

### AC_CHANGE_REQUEST 2 — AC-11 changes the user's scope without being asked

| | |
|---|---|
| **As written** | *"the Selection radio option must become enabled and **automatically selected**"* the moment a valid selection exists. |
| **Problem** | A reader who is reading — highlighting a sentence to keep their place, or to copy it — would have their chosen scope silently replaced. This project's brief for this task says the opposite twice: §37 *"enable: Selection scope"*, and §46 *"Selection merely makes the Selection scope available."* Silently changing a scope is the same family as silently widening one, which the whole scope model exists to prevent: the user's scope is a constraint until the user lifts it. |
| **Resolution** | A valid selection **enables** Selection and shows the preview; it does not change the selected scope. The user picks Selection, exactly as they pick the other three. The preview and the enabled state are what tell them it is available. |
| **Not accepted** | Auto-selecting it "because they clearly meant to ask about it". They may have meant to copy it. |

### AC_CHANGE_REQUEST 3 — AC-02 requires rotation support that has never been verified

| | |
|---|---|
| **As written** | AC-02 (P0): a page with `PageIR.rotation ∈ {90, 180, 270}` must have the inverse affine transform applied, per four formulas given in the specification. |
| **Problem** | The formulas are plausible and untested. They assume one particular relationship between how PyMuPDF measured the paragraph boxes and how PDF.js lays out a rotated viewport, and getting that wrong maps a horizontal span onto a vertical coordinate — which is not a degraded result but a *confidently wrong* one, worse than the unavailable state it replaces. DS-QA-003 deliberately drew no highlight on a rotated page for exactly this reason, and this task must not undo that judgement by assertion. |
| **Resolution** | The transform is implemented as specified **and verified against a real rotated fixture** — a PDF built with a nonzero `/Rotate` whose text is known — by round-tripping a selection through it and comparing the recovered paragraph to the one the text actually belongs to. If it round-trips, rotation is supported; if it does not, rotation **fails safe**: the selection maps to nothing, Selection stays unavailable, and the limitation is recorded rather than the formula being tuned until a fixture agrees with it. |
| **Not accepted** | Shipping the formulas on the strength of their plausibility, or dropping AC-02 without a measurement. |
| **Measured, and it fails safe** | Three real fixtures were built by rotating a body page of the ResNet paper by 90°, 180° and 270°. On the 90° one, a drag anchored on a text-layer **span's own text** — not on the mapper's transform, which would round-trip even if both halves were wrong together — resolved to **no paragraph at all** and Selection stayed disabled. Investigating why showed the two conventions are not reconcilable by inspection: PyMuPDF reports a rotated page's `rect` as 792×612 while reporting its text blocks in unrotated coordinates, and PDF.js's viewport transform already carries the rotation. **The affine was therefore removed**, and a rotated page now maps to nothing. A wrong inverse returns a confidently wrong paragraph, which is worse than the unavailable state it replaces — the same judgement DS-QA-003 made about highlights. Recorded as a measured refusal, not as an unfinished feature. |

### AC_CHANGE_REQUEST 4 — AC-12's "garbage collected" is not an observable assertion

| | |
|---|---|
| **As written** | AC-12: *"cached `DocumentIR` data must be garbage collected when the document is closed or switched."* |
| **Problem** | JavaScript has no observable garbage collection, so this cannot be asserted — a test can only check that a reference was dropped, which is what the criterion means and does not say. Worse, the honest version is checkable: the store's IR entry must be `null` after a switch, and the *previous* document's paragraph ids must not be sendable. |
| **Resolution** | Restated as: after a document switch or close, the cached IR is released from the store and the selection state is empty, asserted directly. The in-flight request is aborted via `AbortController`, which the criterion already required and which is observable. |
| **Not accepted** | Leaving it as written and marking it PASS on the strength of "nothing references it any more". |

### AC_CHANGE_REQUEST 5 — clearing the selection must not abort a question already asked

| | |
|---|---|
| **As written** | AC-12: *"When the user clears the selection, switches documents, or changes reader mode, the client must immediately abort the in-flight request."* |
| **Problem** | Two of those three are right and one is not. A document switch and a mode change invalidate the question's premise, so aborting is correct and is implemented. **Clearing the selection does not.** The reader asked a question about a specific passage; clicking elsewhere afterwards does not retract the question, and the answer is being computed from the paragraphs they chose — which are frozen onto the turn and shown on its card. Aborting would discard an answer the user asked for, and the stale-state the criterion is guarding against does not exist: the turn carries its own document identity and its own scope label, so it can neither be shown against another paper nor relabelled with a scope it was not asked in. |
| **Resolution** | The abort stays for document switch and mode change, and is dropped for clearing the selection. The property AC-12 was defending — that nothing stale is ever displayed — is preserved by the turn's own identity binding, which is asserted by existing tests. |
| **Not accepted** | Aborting on clear to satisfy the sentence literally, which turns a click in the margin into a cancelled answer. |

### Note on the matching thresholds (§4.2), recorded rather than claimed as measured

The containment and n-gram thresholds — token containment ≥ 0.35, character 3-gram Jaccard
≥ 0.25, the 80 pt² and 40% area bounds — are **the specified defaults**, not measurements.
The task brief asks for thresholds measured against real selections rather than chosen and
called empirical, so the implementation uses these values and the evidence reports **what they
actually admit and reject** on the real fixtures. If a threshold turns out to admit a figure
label or reject a real paragraph, that is recorded as a finding, not quietly retuned until the
tests agree.

---

## 2. Decisions A–J, as frozen

| | Decision | Rule |
|---|---|---|
| **A** | Multi-paragraph selection | Send all intersecting `paragraph_ids`, deduplicated, ordered by canonical `DocumentIR` reading order, capped at **20** with an advisory message. |
| **B** | Geometric overlap | **Line-fragment overlap.** Per `getClientRects()` fragment `R` and paragraph box `B`: vertical overlap ≥ 50% of the shorter height **and** horizontal overlap `Δx ≥ 4.0 pt`. Paragraph is a candidate if `Σ area(R ∩ B) ≥ min(80 pt², 0.40 × Σ area(R))`. |
| **C** | Geometry vs text | **Geometry primary, text a validator.** Geometry generates candidates; normalization and containment reject figure labels, headers, marginalia and column bleed. |
| **D** | Granularity | **Whole `paragraph_id`.** No offsets, no substrings. The UI shows the selected text as a cosmetic preview only, and paragraph scope is not character-exact. |
| **E** | Cross-page | **Deferred in P0.** Different page containers → `UNSUPPORTED_CROSS_PAGE`, Selection disabled, message `"暂不支持跨页选区问答，请限制在单页内选择"`. |
| **F** | Headings and captions | **Rejected if isolated.** Neither is a `ParagraphIR`; a selection of only those maps to `[]` and Selection stays disabled. Selected alongside prose, only the prose ids are sent. |
| **G** | Low confidence / partial | **Partial permitted, low confidence rejected.** At least one paragraph validating with confidence enables Selection with the validated subset; all candidates failing leaves it unavailable. |
| **H** | Mode availability | Original, and Bilingual **from the original pane only**. |
| **I** | Bilingual | Selections on the translated pane are rejected: `"选区问答仅支持在原文栏中选中文本"`. |
| **J** | Translation mode | Selection disabled, with a one-click `"切换至原文模式以使用选区问答"` that switches to Original at the current page. |

## 3. Coordinate transform, as frozen

```
client rect (range.getClientRects())
  → subtract the [data-testid="pdf-page-container"] rect      page-local CSS px
  → divide by the live scale published on that container       unscaled display points
  → inverse rotation transform by PageIR.rotation              canonical PDF points
  → intersect with ParagraphIR.bboxes
```

Rotation (verified, or failing safe — AC_CHANGE_REQUEST 3), with `W`/`H` the page's
`width_pt`/`height_pt`:

```
  0°:  x0 = x,            y0 = y
 90°:  x0 = y,            y0 = H - (x + w)
180°:  x0 = W - (x + w),  y0 = H - (y + h)
270°:  x0 = W - (y + h),  y0 = x
```

## 4. Text normalization and validation, as frozen

`N(T)`: NFKC (decomposes ligatures), strip soft hyphens and zero-width spaces, reconcile
line-break hyphenation (`(\w+)-\s*\n\s*(\w+)` → `$1$2`), collapse whitespace, trim, lowercase.

Validation gate:
* **≤ 5 tokens:** `N(selection)` must be a substring of `N(paragraph.text)`.
* **> 5 tokens:** token containment ≥ 0.35, else character 3-gram Jaccard ≥ 0.25.

## 5. Acceptance criteria

### P0

- **AC-01 Coordinate and geometry inversion.** At any zoom or fit-width, `getClientRects()`
  converts to PDF points via the container's published scale and offset, matching
  `ParagraphIR.bboxes` within ±2.0 pt, independent of zoom and device pixel ratio.
- **AC-02 Affine rotation support.** Non-zero `rotation` applies the inverse transform of §3,
  must not map horizontal spans to vertical coordinates, and must not produce negative
  coordinates. *(AC_CHANGE_REQUEST 3.)*
- **AC-03 Two-column disambiguation.** A Column-1 selection vertically aligned with a Column-2
  paragraph gives that paragraph zero horizontal overlap and excludes it.
- **AC-04 Multi-paragraph aggregation.** Crossing paragraphs yields both ids, deduplicated,
  sorted by canonical reading order regardless of drag direction, capped at 20 with
  `"选区过大，已自动限制前20个段落"`.
- **AC-05 Non-prose rejection.** A selection of only a title, caption, formula or header
  resolves to `[]` and Selection stays disabled with
  `"所选内容为标题或图表说明，无法作为选区问答范围"`. A selection covering a title *and* the
  first line of body prose includes only the body paragraph.
- **AC-06 Cross-page boundary protection.** Different page containers → `UNSUPPORTED_CROSS_PAGE`,
  Selection disabled, `"暂不支持跨页选区问答，请限制在单页内选择"`.
- **AC-07 Reader mode enforcement.** Original: active. Bilingual: original pane only; the
  translated pane shows `"选区问答仅支持在原文栏中选中文本"`. Translation: disabled with
  `"切换至原文模式以使用选区问答"`, which switches to Original.
- **AC-08 Non-interference.** `Ctrl+C` copies normally; no context-menu hijack; no
  `preventDefault`/`stopPropagation` on selection listeners.
- **AC-09 Backend contract conformance.** The payload's scope is exactly
  `{"type": "selection", "paragraph_ids": [...]}` with no extra keys, and an empty list never
  falls back to `whole_paper` — the request is not dispatched. *(AC_CHANGE_REQUEST 1 for the
  endpoint and field names.)*
- **AC-10 Empty-query behaviour.** With a valid selection and an empty query, the backend
  receives `question: ""` with the selection scope, returns the selected paragraphs in reading
  order without FTS scoring or rewriting, and the UI renders the explanation.
- **AC-11 Scope selector and stale selection.** No selection or a collapsed one leaves Selection
  disabled as `选中内容（未选择）`. A valid selection enables it *(not auto-selects —
  AC_CHANGE_REQUEST 2)* and shows `已选 N 个段落: "…"` truncated at 60 characters. Clearing the
  selection or switching documents clears the preview and the state.
- **AC-12 Lifecycle teardown.** An in-flight selection-scoped request is aborted on clear,
  document switch or mode change, and the cached IR is released from the store.
  *(AC_CHANGE_REQUEST 4.)*

## 6. Failure-mode matrix, as frozen

| Scenario | Expected |
|---|---|
| Collapsed selection | Clear ids, disable Selection. |
| Reversed drag | Positive rects; canonical reading order. |
| Figure-axis selection | Text validation fails; scope stays disabled. |
| Hyphenated line wrap | `multi-` + `task` normalizes to `multitask`. |
| Formula inside a selection | Prose matches; non-text math spans ignored without failing the paragraph. |
| Triple-click | Full paragraph rects; one id at full confidence. |
| Keyboard selection | Same mapping, debounced ~150 ms on `selectionchange`. |
| Page unmounts while selected | Mapped ids persist in the store until cleared or replaced. |
| Document switch | Drop the IR cache, reset selection, clear the preview. |
| Backend unanswerable | `INSUFFICIENT_EVIDENCE`; scope is **not** widened automatically. |

## 7. Verification plan, as frozen

**Unit:** coordinate inversion at scales 1.0/1.715/2.0 against known rects ±0.5 pt; rotation at
90/180/270; two-column zero overlap; the normalizer (ligatures, hyphenation, whitespace);
the validation gate rejecting axis labels; reading-order sort of a reversed selection.

**Component:** scope selector lifecycle; the bilingual pane guard; the cross-page guard.

**Backend regression:** selection scope constrains candidates; extra keys → 422; empty query
returns the selection without FTS; a non-matching question yields `INSUFFICIENT_EVIDENCE` with
no out-of-selection hits.

**Browser E2E:** load ResNet (612×792 pt), drag across lines 2–4 of the Abstract at scale 1.715,
verify Selection enables with a preview, ask a question, verify every citation is inside the
Abstract paragraph, and verify `Ctrl+C` still copies.
