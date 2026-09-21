# ADR-001 — PDFMathTranslate Integration Strategy

- **Status:** Accepted
- **Date:** 2026-09-15
- **Phase:** 0
- **Deciders:** project maintainer
- **Evidence:** `docs/REPO_AUDIT.md` §6-§9, §13

## Context

The project's core translation capability must not be rebuilt (brief §3). We must therefore
choose how to consume PDFMathTranslate, which was audited at commit `c0fa967` (declared
version 1.9.12).

Findings bearing on the decision:

1. **PyPI lags the repo.** PyPI's newest release is 1.9.11; the audited source is 1.9.12.
   Installing from PyPI would mean integrating code we have not audited.
2. **All required additions are additive.** User-supplied endpoint/model/key is already
   supported by `OpenAIlikedTranslator` (`translator.py:1058`). Context injection can be done
   from a translator subclass, because `TranslateConverter` constructs the translator with
   `envs=envs` (`converter.py:166`) — no upstream edit needed.
3. **The one requirement that would need a real upstream edit** — per-block page attribution
   — is not required for the MVP, because glossary and document-summary context are
   document-scoped, not page-scoped (REPO_AUDIT §6).
4. **Upstream is fast-moving and 5.9k LOC.** A hard fork would be cheap to make and
   expensive to maintain.
5. **The library installs and imports cleanly** on Python 3.12.13 (verified by execution).

## Decision

**Consume PDFMathTranslate as a pinned dependency, installed from a pinned commit, behind a
thin adapter layer in our own package. Do not fork. Do not vendor modified source.**

Rules that follow from this:

- Pin the exact commit hash in `backend/pyproject.toml` and re-record it here on change.
- All integration code lives under `backend/app/pdfkernel/`. Upstream is imported as a
  library; it is never edited.
- Call the **public** API (`high_level.translate`) with **explicit named arguments**. Never
  pass or rely on `**locals()` — `translate_stream` propagates it implicitly
  (`high_level.py:339`), so an extra local variable can silently become a kernel argument.
- Context injection uses the **subclass + immutable document-context map** strategy
  (REPO_AUDIT §6, strategy b).
- **MVP ships the `fast` kernel only.** `precise` requires an uninitialised second repository
  and an isolated venv (`.gitmodules`, `pdf2zh/kernel/PDFMathTranslate-next.git` is empty).
  This aligns with brief §70.

## Escalation rule

If per-block page attribution becomes necessary, we convert to a **documented patch series**
against the pinned commit — never a silent fork — and raise an `AC_CHANGE_REQUEST` if
The acceptance criteria are affected (brief §10).

## Consequences

**Positive**
- Upstream upgrades are a pin bump plus a re-run of our adapter tests.
- Our diff surface is small enough to review by hand.
- No obligation to maintain a divergent 5.9k-LOC codebase.

**Negative**
- We cannot use upstream internals that are not exported.
- Progress granularity stays coarse (per page) unless we add our own instrumentation.
- If strategy (b)'s text-keyed context lookup proves insufficient, we pay a migration cost
  to the patch-series model.

## Alternatives considered

| Option | Rejected because |
|---|---|
| Install `pdf2zh` from PyPI (1.9.11) | Would integrate unaudited, older code |
| Git submodule of upstream | Adds a checkout step to every clone without solving anything |
| Hard fork into `_reference` / `vendor/` | Maintenance burden with no MVP benefit |
| Rewrite the PDF pipeline | Explicitly forbidden by brief §3 |
