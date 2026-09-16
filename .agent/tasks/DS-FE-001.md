# DS-FE-001 — Application Shell + Main Reader Workspace

- **Phase:** 2 (Frontend Foundation)
- **Status:** AC authoring — implementation NOT started
- **Owner:** DeepSeek (implementation) · Gemini (acceptance criteria)
- **Created:** 2026-09-15

## Goal

Deliver the application shell and the main reader workspace **layout** for Academic PDF
Copilot: a dense, calm, desktop-class workspace in which later features (PDF rendering,
translation, AI assistant) have a definite place to land.

This task is **layout, structure, and state scaffolding only.** It does not render real PDFs.

## Product Context

Academic PDF Copilot is a local-first desktop tool for reading English academic papers with
lossless bilingual translation and an AI paper assistant. Target users read
AI / Robotics / Engineering / Science papers — formula-dense, two-column, figure- and
citation-heavy.

The product is a **desktop productivity tool**, not a web app or a landing page.

### Required workspace structure (from the product brief §27)

```
┌────────────────────────────────────────────────────────────────┐
│ Logo   paper.pdf   原文 | 双语 | 译文   AI翻译   Search   ⚙  │
├──────────────┬─────────────────────────────────────────────────┤
│              │                                                 │
│ AI Assistant │       PDF Workspace                             │
│              │                                                 │
│ 当前论文      │   Original PDF       │   Translated PDF         │
│              │                      │                          │
│ 总结本页      │                      │                          │
│ 解释选中内容  │                      │                          │
│ 解释公式      │                      │                          │
│              │                      │                          │
│ ──────────── │                      │                          │
│ Ask paper... │                      │                          │
│          ➤   │                      │                          │
├──────────────┴─────────────────────┴───────────────────────────┤
│ Translating... Page 5 / 18  ███████████████░░░  72%           │
└────────────────────────────────────────────────────────────────┘
```

### Regions

1. **Top bar** — product mark, current document name, reader-mode switch
   (`原文 | 双语 | 译文` = Original / Bilingual / Translation), an AI-translate action,
   search, and settings.
2. **AI sidebar** (left) — collapsible, **320–380 px** (brief §29). Contains document scope
   controls, quick actions (总结本页 / 解释选中内容 / 解释公式 / 总结方法 / 提取创新点 /
   总结实验结果), a scrollable conversation area, and a composer pinned to the bottom.
3. **PDF workspace** (centre/right) — the visual protagonist. In bilingual mode it hosts two
   side-by-side viewers (Original | Translated). It must absorb the remaining width.
4. **Progress/status bar** (bottom) — translation progress, page position, engine state.

## Technical Context

**Stack (decided):** React + TypeScript + Vite + Zustand + PDF.js. Styling: **Tailwind CSS +
shadcn/ui** (brief §73 — one UI framework only, no mixing).

**Constraints that shape this task:**

- `frontend/` is currently empty — this task creates the project scaffold.
- `strict: true` in tsconfig; no unbounded `any` (brief §87).
- This is a **localhost web MVP**; Tauri packaging is Phase 12 and must not be anticipated in
  the code structure beyond keeping the backend URL configurable.
- The backend does not exist yet. The shell must render correctly with **no backend
  running** — that is the default state, not an error state.

**Visual register (brief §72):** academic, calm, modern, dense but clean. Closer to an IDE
or a research tool than to a consumer app. Explicitly **avoid**: landing-page styling, giant
dashboard cards, decorative gradients, excessive glassmorphism, gratuitous animation.

## Files Allowed To Modify

```
frontend/**                 (entire subtree — new project)
.agent/tasks/DS-FE-001.md
.agent/evidence/DS-FE-001.md
.agent/screenshots/DS-FE-001.png
```

## Files Forbidden To Modify

```
backend/**                  (does not exist yet)
docs/**                     (architecture is frozen for this task)
_reference/**               (upstream, read-only)
.agent/tasks/DS-*.md other than DS-FE-001
```

No production file outside `frontend/` may be touched.

## Requirements

R1. Vite + React + TypeScript project scaffolded under `frontend/`, with `strict: true`.
R2. Tailwind CSS + shadcn/ui configured. No second UI framework.
R3. Application shell renders all four regions from the layout above.
R4. Top bar shows: product mark, document name (placeholder acceptable), the three-way
    reader-mode switch, AI-translate action, search, settings.
R5. AI sidebar is collapsible; its width sits within 320–380 px when expanded.
R6. Sidebar contains: scope selector, quick-action list, conversation area, bottom composer.
R7. PDF workspace renders **placeholder** viewer surfaces — in bilingual mode, two side-by-side
    surfaces. No real PDF parsing in this task.
R8. Bottom status bar shows translation progress and page position as placeholder state.
R9. Reader mode is real, working state (Zustand) — switching modes changes the workspace
    layout, not just a label.
R10. Sidebar collapse is real, working state, and the workspace reflows to reclaim the width.
R11. The workspace fills the viewport with no page-level scrollbar; scrolling is internal to
     the sidebar conversation area and to each viewer.
R12. Renders correctly at 1024, 1440, and 1920 px widths.
R13. Light theme only (brief §74). Structure must not preclude a later dark theme.

## Known Constraints

- No backend. Any data shown is local placeholder state. The UI must not appear broken,
  loading forever, or error out because the backend is absent.
- No PDF.js rendering in this task — placeholder surfaces only. This keeps the shell
  verifiable in isolation.
- Non-goals: real PDF rendering, translation, the assistant's actual behaviour, settings
  persistence, Tauri.

## Expected Tests

- `npm run typecheck` — passes with `strict: true`.
- `npm run build` — succeeds.
- Component tests for: mode switching updates workspace layout; sidebar collapse toggles and
  workspace reflows; shell renders with no backend present.
- Manual verification at 1024 / 1440 / 1920 px, captured to
  `.agent/screenshots/DS-FE-001.png`.

## Dependencies

None. This is the first implementation task in the project.

## Known Risks

- **Scope creep toward a dashboard.** The framing "workspace shell" invites card-grid
  styling; the brief explicitly forbids it. Density and restraint are the acceptance risk.
- **Layout collapse at 1024 px** once a 340 px sidebar is subtracted — the workspace must
  still be usable.
- Mode switching that only relabels rather than re-laying-out would be a hollow
  implementation; R9 exists to prevent that.
