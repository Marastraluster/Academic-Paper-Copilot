# ADR-002 — License Posture (AGPL-3.0 Dependency)

- **Status:** **Decided** — local / personal use only
- **Date:** 2026-09-15
- **Phase:** 0
- **Deciders:** **User** (decided 2026-09-15)
- **Evidence:** `docs/REPO_AUDIT.md` §19

## DECISION (user, 2026-09-15)

> **Intended end use: local / personal use only. No distribution.**

Under AGPL-3.0 this imposes **no source-disclosure obligation**, and the current
architecture stands unchanged. PDFMathTranslate remains the translation kernel.

**Standing constraint this creates:** the project must not distribute binaries or expose the
service to remote users. If that changes, this ADR is reopened *before* any distribution —
the analysis below remains valid and the Phase 12 gate still applies.

**Retained safeguard:** the kernel stays behind the thin adapter required by ADR-001, so the
translation engine remains swappable at low cost should the intent change.

## Context

Phase 0 (brief §91) requires a license audit before integration. Findings:

| Component | License | Verified at |
|---|---|---|
| PDFMathTranslate | **AGPL-3.0** | `LICENSE` (661 lines), `pyproject.toml` → `license = "AGPL-3.0"` |
| PyMuPDF | **AGPL-3.0** (dual-licensed commercially) | `pyproject.toml` → `pymupdf<1.25.3` |
| babeldoc | not yet audited | `pyproject.toml` → `babeldoc>=0.1.22,<0.3.0` |

This is not a single-dependency problem. PyMuPDF carries the same obligation independently,
so the constraint cannot be removed by swapping one library.

## What AGPL-3.0 means here

- **Local private use, no distribution:** no source-disclosure obligation. The MVP as
  specified — local-first, user's own endpoint and key — sits in this regime.
- **Distributing the desktop app (Phase 12):** AGPL §5/§13 apply. The distributed combined
  work must carry the complete corresponding source under AGPL-3.0, our integration code
  included.
- **Network use (AGPL §13):** if the software is ever exposed to remote users, those users
  must be offered the corresponding source.
- **A closed-source commercial product built on this is not permissible** without a
  commercial license from the upstream authors.

## Decision

1. Keep our repository's license **compatible with AGPL-3.0**. Our code is treated as part
   of the combined work from the start, so that Phase 12 is not a re-licensing event.
2. **Do not treat this as legal advice.** A real license review is required before any
   distribution.
3. **Phase 12 is a hard decision gate.** Before packaging, the user must choose one of:
   - **A.** Distribute under AGPL-3.0 (open source), satisfying §5/§13.
   - **B.** Obtain a commercial license from the upstream authors.
   - **C.** Ship for personal/local use only, and do not distribute binaries.
4. Audit `babeldoc`'s license **before** Phase 12 packaging.
5. Preserve upstream copyright notices and license text in any distribution.

## Consequences

**Positive**
- The licensing constraint is surfaced in Phase 0 rather than discovered at packaging time.
- Local-first development proceeds with no blocker.

**Negative**
- If the user intends to ship a proprietary product, the core translation engine is not
  usable as-is and the architecture would need to change. **This is the single largest
  non-technical risk to the project**, and it is cheaper to discover now than in Phase 12.

## Open question for the user — RESOLVED

> ~~Is this project intended for local/personal use, open-source distribution, or commercial
> distribution? The answer determines whether PDFMathTranslate can remain the translation
> kernel.~~

**Resolved 2026-09-15: local / personal use only.** No distribution → no AGPL obligation →
PDFMathTranslate remains the kernel.
