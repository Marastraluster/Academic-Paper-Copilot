# Evidence — DS-QA-003 Paper QA Sidebar + Citation Jumping

- **Date:** 2026-09-18
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-QA-003.md` (Gemini, frozen before implementation,
  with four `AC_CHANGE_REQUEST`s raised in review)
- **Baseline:** `1732024` (DS-QA-002)
- **Verdict:** **The grounded QA backend is now a reader experience. A question gets an answer
  with numbered citations; clicking one lands on the real page of the original PDF with the
  cited region marked. Abstention renders as an outcome, not a failure. Two defects were found
  by running it in a real browser, and neither was visible from the unit suite.**

## What was built

```
frontend/src/api/qa.ts          the typed answer contract, with `status` deliberately open
frontend/src/api/documents.ts   listSections()
frontend/src/qa/parse.ts        untrusted-response classification and citation normalisation
frontend/src/qa/answerBlocks.ts a zero-dependency Markdown-subset parser
frontend/src/qa/Citations.tsx   chips, tooltips, reference cards
frontend/src/qa/AnswerBody.tsx  the answer, typeset as prose
frontend/src/qa/QaTurnCard.tsx  the four outcomes, rendered differently on purpose
frontend/src/qa/session.ts      the imperative layer: scope building, quoting, jumping
frontend/src/qa/useQaSession.ts derivation over the store, no fetching
frontend/src/assistant/*.tsx    the existing placeholder, replaced in place
frontend/src/pdf/*              page reporting, citation jump, highlight overlay
frontend/scripts/e2e-qa.mjs     the real-browser verification
```

**The four outcomes are separate states, not one.** `answered`, `partial` and
`insufficient_evidence` are all successes; a provider failure is a different axis. An
unrecognised status is shown as unrecognised — never rendered as an answer, because a status
this build does not understand is a grounding it cannot vouch for.

**The two panes are not interchangeable.** A source page number and a source bounding box
describe the original document. In translation mode the reader is switched to the original
before jumping, and in bilingual mode only the original pane is asked to move. The translated
pane never receives a source box — visible in `shots/02-bilingual.png`, where the left pane
carries the highlight and the right one does not.

**Abstention is not an error.** The `insufficient_evidence` card is neutral, carries the
backend's rationale, and offers to widen the scope only when the backend said a wider scope
would have found something. The scope stays a constraint until the user lifts it.

**Selection is disabled, with its reason.** No selection → paragraph mapping exists, and
answering the whole paper while labelling it a selection would be a lie about what was
searched.

## Verification

```
backend       768 passed
frontend      112 passed   (78 before this task)
typecheck     PASS
build         exit 0
bundle        299.44 kB initial (ceiling 350 kB) · 483.14 kB PDF.js, still lazy
```

### Real browser, real backend, real provider — 37 of 37

Microsoft Edge via Playwright, the built bundle served by `vite preview`, the real backend, and
the real `Deepseek / deepseek-flash` profile. The backend ran against a **copy** of the
application database, so the run added nothing to the user's library while still resolving the
real credential from the OS store.

```
no document: the question box is disabled and the sidebar says why
reader opens the paper and QA unlocks
the four scopes are offered, selection honestly disabled
answerable question answers · citations render as numbers, not raw ids
the reference list carries a real page
clicking a citation moves the original viewer
the cited region is highlighted in the original pane
no page number is echoed from the model — chips carry the IR's page
a Chinese question produces a grounded outcome, never an error
a partly answerable question is marked partial, and names what was unsettled
an unanswerable question abstains, and is not presented as a failure
a page-scoped question records the page it searched
the excerpt translates against the real provider
translation mode: a citation switches to the original, says why, highlights the source,
                  and never marks the translated pane
bilingual: only the original pane moves; the translated pane gets no source box
no horizontal scroll and a usable reader column at 1024 / 1440 / 1920
```

**Source immutability: PASS.** The PDF handed to the browser is byte-identical afterwards, and
every stored `source.pdf` hashes to one of the two files that were uploaded.

**No console errors across the whole run.**

## Two defects the browser run found, and the unit suite could not

**The highlight vanished on a remount.** A citation clicked in translation mode switches the
reader back to the original — which *remounts* the pane. On mount, React runs effects in
declaration order: the jump effect set the mark, and a later effect that clears it for a new
document wiped it immediately. In the single-pane case the pane was already mounted, so the bug
was invisible. Fixed by clearing the mark where the document is loaded, which runs before the
jump effect; there is now a regression test that clicks a citation from translation mode and
asserts the mark survives the remount.

**And one measurement error of mine, recorded because it nearly became a false finding.** The
first layout check reported that the reader had an unusable column at 1024 and 1440 px. It was
measuring while the reader was still in **bilingual** mode, where two panes share the width, so
it was reporting half the reader and calling it a defect. It now measures both layouts
separately, and bilingual panes are held to their own, lower bound.

## Gemini criteria, as evaluated

**P0: 19 of 19.** **P1: 6 of 6.** **P2: 0 of 3** — the collapsible reference list, the history
export, and the diagnostics disclosure were not built. Recorded as absent rather than
approximated; the criteria mark them optional.

### The four change requests

1. **The baseline line named the wrong commit and test count** — `3438e5a` / 718 where DS-QA-002
   is `1732024` / 768. Corrected before implementation.
2. **The pending banner promised index construction during an upload.** Nothing is indexed until
   the first question is asked; the banner now says the document is being registered, matching
   `TopBar`'s existing wording. The failed-registration message was corrected the same way: it
   says registration failed, not that an index failed to build.
3. **The "action link to settings" had nothing to link to** — `TopBar`'s settings button has no
   handler and profiles are created by `scripts/configure_provider.py`. The alert names that
   command instead.
4. **The bbox transform is correct for rotation 0 only.** A rotated page draws no highlight
   rather than a confident rectangle in the wrong place; the jump and the excerpt still happen.

## Known limitations

1. **The Chinese question abstained in the browser run**, because the uploaded document has no
   `DocumentAnalysis` and the cross-lingual path needs the glossary. That is DS-QA-002's measured
   behaviour, not a regression — the run asserts the UI renders the honest outcome without an
   error and without inventing citations. An answered Chinese question with citations to English
   source is covered by the DS-QA-002 real-provider evidence and by unit tests.
2. **The 5 P2 items and 3 P2 criteria above are unimplemented.**
3. **Selection scope is deferred**, as the frozen criteria decided.
4. **A rotated page gets no highlight**, by AC_CHANGE_REQUEST 4.
5. **The backend limitations DS-QA-002 recorded are unchanged** — retrieval can miss
   conceptually related evidence, the validator withholds roughly 5% of answers, and one
   over-abstention was observed. The sidebar surfaces all of them as abstentions rather than
   papering over them.
6. **The browser run used a two-page excerpt** for the translation-mode checks, to keep one real
   translation inside a few minutes. The mode interaction does not depend on the excerpt.

## Recommended next task

**DS-QA-004 — Retrieval recall.** The sidebar now makes the measured retrieval limitation
visible to a reader rather than to a benchmark: an abstention is honest, but a user who asks
"which datasets were used" and is told the paper does not say will not find that acceptable for
long. The failure class is known and documented — the question's vocabulary is not the paper's —
and the brief's ordering (entity/type-aware expansion → bounded query rewriting → hybrid
retrieval → embeddings) is the one to follow, from evidence at each step rather than all at once.

**Selection QA + source highlighting** is the other candidate, and it is now the smaller one: the
highlight machinery, the coordinates and the jump all exist and are verified; what is missing is
the DOM-selection → `ParagraphIR` mapping.
