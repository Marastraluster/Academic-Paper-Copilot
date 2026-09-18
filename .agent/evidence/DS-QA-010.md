# Evidence — DS-QA-010 Notes + Persistent Highlights

- **Date:** 2026-09-19
- **Commit:** `8e552de`
- **Acceptance criteria:** `docs/acceptance/DS-QA-010.md` (Gemini, authored before
  implementation, with two `AC_CHANGE_REQUEST`s resolved before any code)
- **Verdict:** **The persistence and migration layers work and are measured; the
  reader does not reload them.** That distinction is the whole report.

## DS-DOC-003 disposition first

- **AC-P0-13 (rotated pages) — PASS, measured.** My previous "not measured" was
  **wrong**: a rotated page extracts to one block, which is one *paragraph*, and
  paragraphs are the anchor domain. The anchor exists, is stable across a second
  extraction, and the bbox (y up to 743 on a 792×612 landscape page) is provably
  in unrotated PDF space. Highlight suppression was already measured in DS-QA-008.
- **AC-P0-14 (non-prose) — `AC_CHANGE_REQUEST`, scope narrowed.** Not unmeasured:
  **unmet**. References are anchored 2/2 (they are paragraphs); 14 caption and 4
  formula blocks are 0 inside any paragraph. v1 anchors paragraphs, and the
  criterion now says so. Final: **P0 15/16 PASS, 1 scope-narrowed.**
- **Flake — unreproduced.** Three further runs: 48/48, 48/48, 48/48. Five clean
  runs since one failure, no failing check identified. Recorded as unreproduced,
  not fixed.

## What works, and how it was measured

**Migration.** 004 added on a copy of the real database: v3 → v4, `documents` and
`profiles` preserved. `PRAGMA foreign_keys` is on, and `annotations` deliberately
has **no** foreign key to `documents` — asserted on the schema, not inferred.

**The historical replay, through the service layer** (`.agent/results/qa/replay_annotations.py`):

```
old 160 -> new 155 paragraphs, 150 anchors shared
  A  untouched paragraph     EXACT
  B  re-segmented            REATTACHED
  C  multi-paragraph span    EXACT + REATTACHED
  WRONG 0        original anchors intact: True
  comments intact: ['my note', 'across the change']
```

**Zero provider calls** across create, edit, delete and panel open — asserted in
the browser by watching every request for a provider host.

## Three defects found by running, not by reading

1. **The list route keyed on the document row.** Document ids are `uuid4().hex`,
   so re-uploading the same PDF produced an empty panel while the rows sat in the
   database. Fixed to list by `content_hash` — the change request's own point,
   which I had written and then not implemented on this path.
2. **`apiFetch` sets no `Content-Type`.** Every create was a 422; the UI reported
   "could not be saved". Caught by logging the response status, after the panel's
   own error text had already been misread once as a component failure.
3. **A `isCurrent` guard that compares session tokens.** Right for a question,
   wrong for a note list: the token is re-minted when the same file is
   re-registered, so the load was dropped on exactly the reopen this feature
   exists for.

## The defect that is not fixed

**The reader does not render persisted notes after a reload or a restart.**

```
browser: 13/17
  PASS  create highlight, note, edit, delete, overlay, citation-fade separation
  FAIL  annotations survive a reload       2 -> 0
  FAIL  annotations survive a restart      2 -> 0
```

**The backend is not the problem, and that is measured rather than assumed.** The
API returns the annotations correctly after a reload, with the right
`content_hash` and the stored rows:

```
[api] 200 GET …/annotations :: {"content_hash":"1e0651b6…","annotations":[{…
```

The panel renders nothing. Five fixes were attempted — aborting the same
document's load, keying the panel effect on the document, loading at
registration, guarding on the document instead of the session token, and tracking
which document the list describes. None resolved it, and I stopped rather than
continue spending on a single symptom.

The honest statement is that I do not know the cause. What I can say is what I
ruled out: it is not the persistence, not the API, not the route, not the anchor,
and not the migration — each of those is measured working.

## Downstream

```
backend 947 passed (927 + 20)   frontend 172 passed   typecheck PASS
build exit 0   bundle 329.70 kB (ceiling 350)
```

## Product decision

**PERSISTENCE WORKS, MIGRATION INSUFFICIENT** does not fit — migration is the part
that works best. **ANNOTATION MODEL REDESIGN REQUIRED** does not fit either — the
model is sound and the measurements say so.

The accurate decision is **NOT READY: the storage layer is proven and the reader's
load path is broken.** Recorded against the closest option rather than pretending
one of the three describes it.

## Known limitations

1. **The reload failure above**, cause unknown.
2. **Duplicate-text disambiguation is untested on real data** — the corpus has no
   duplicates at paragraph granularity.
3. **Cross-page selection is not supported**; a target is one page.
4. **Non-prose annotation is out of scope for v1** (AC-P0-14, narrowed).
5. **No frontend unit tests for the notes paths.** The coverage is the browser
   suite, and it is the suite that is failing.
6. **Performance and storage were not measured** — no annotation-count timings, no
   DB size delta.

## Next task

**Fix the reload path before building anything else on notes.** No new feature
should rest on a persistence layer whose read path has not been shown to work in
the product, and the next task is small: the storage, the API and the migration
are done and measured.
