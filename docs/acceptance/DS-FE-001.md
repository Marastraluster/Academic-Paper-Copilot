# DS-FE-001 — Acceptance Criteria (FROZEN)

> **Author:** Gemini 3.8 Flash (High) via Antigravity CLI — *independent Acceptance Criteria Agent*
> **Authored:** 2026-09-15, **before any implementation code was written**
> **Model invocation:** `agy -p <prompt> --model gemini-3.8-flash-high --output-format text`
> **Prompt:** `.agent/tasks/_gemini-prompt-DS-FE-001.md`
> **Raw model output:** `.agent/tasks/_gemini-ac-DS-FE-001.raw.md`
>
> **FROZEN.** Criteria are authored before implementation (brief §8) to prevent moving
> goalposts and self-serving acceptance. DeepSeek may not silently weaken or delete any
> criterion. If one proves unachievable or conflicts with architecture, an
> `AC_CHANGE_REQUEST` is raised and Gemini revises (brief §10).
>
> **Priority:** only **[P0]** criteria block task completion. [P1] should be met; [P2] goes
> to backlog (brief §99).

---

## Acceptance Criteria Review — DeepSeek (brief §101 Step 8)

Reviewed before implementation. Assessment: **accepted as-is, no AC_CHANGE_REQUEST.**

| Observation | Assessment |
|---|---|
| Scope split (shell only, PDF.js and Tauri explicitly forbidden by AC-22) | Matches the task file exactly |
| AC-04 default mode `bilingual` | Consistent with the brief's reader-mode design |
| AC-25 bundle budget (500 KB JS / 60 KB CSS uncompressed) | Achievable for a shell; React+ReactDOM alone is ~140 KB |
| AC-26 FCP/TTI < 300 ms | Achievable on localhost; will be verified via `npm run preview` measurement |
| AC-11/12/13 responsive at 1024/1440/1920 | Matches brief §75 exactly |
| AC-36 requires `.agent/screenshots/DS-FE-001.png` at 1440 px | Matches brief §22 |
| AC-23 no external CDNs | Correctly enforces the local-first/privacy-first principle |
| AC-09 zero-backend standalone | The correct default state; the backend genuinely does not exist yet |

**Implementation notes recorded at review time** (not AC changes — reminders to self):

1. AC-09 and AC-17 mean the shell must **not** fire an unhandled fetch on mount. Any health
   probe must be optional and failure-tolerant, or absent entirely in this task.
2. R9 / F-04 require mode switching to change **DOM panel count** (1 panel vs 2), which is
   exactly what AC-32 asserts. A label-only switch is an explicit failure.
3. AC-21 and AC-22 are dependency-boundary checks against `package.json`, verified at Step 9.

---

# Acceptance Criteria: DS-FE-001 Application Shell + Main Reader Workspace

**Task ID:** `DS-FE-001`  
**Role:** Independent Acceptance Criteria Agent  
**Status:** Defined (Pre-Implementation Baseline)  
**Scope:** Scaffold frontend project, configure Tailwind CSS + shadcn/ui baseline, construct the 4-region dense academic workspace layout, and wire real Zustand state for reader modes and sidebar collapse. Real PDF rendering (PDF.js) and backend communication are strictly out of scope.

---

## 1. Functional Acceptance Criteria

- **AC-01 [P0] Project Scaffolding & Toolchain Configuration**
  - Project is scaffolded directly under `frontend/` using React 18+, TypeScript, and Vite.
  - `tsconfig.json` enforces `"strict": true`, `"noImplicitAny": true`, and forbids unbounded `any`.
  - Tailwind CSS is configured with shadcn/ui (Radix UI primitives). No secondary UI component library (MUI, AntD, Chakra, Mantine) is installed.
  - *Verification:* Running `npm run typecheck` (`tsc --noEmit`) and `npm run build` inside `frontend/` exits with code `0`.

- **AC-02 [P0] Four-Region Workspace Layout Structure**
  - The application shell renders exactly four persistent semantic layout regions:
    1. **Top Navigation Bar** (`<header>`)
    2. **AI Assistant Sidebar** (`<aside>`, left)
    3. **PDF Reader Workspace** (`<main>`, center/right)
    4. **Status / Progress Bar** (`<footer>`, bottom)
  - Root layout container occupies exactly `100vw` and `100vh` (`h-screen w-screen overflow-hidden`) with flex/grid geometry.
  - *Verification:* Inspect DOM structure; all 4 semantic elements are mounted with correct parent-child hierarchy.

- **AC-03 [P0] Top Navigation Bar Contents & Controls**
  - Displays product brand / logo mark (`Academic PDF Copilot` or emblem + title).
  - Displays current document filename placeholder (`paper.pdf` or equivalent).
  - Renders a 3-way reader mode segmented control with labels: `原文` (Original), `双语` (Bilingual), and `译文` (Translation).
  - Contains an `AI翻译` (AI Translate) action button.
  - Contains a document search input or search trigger button.
  - Contains a settings trigger button with a gear icon (`⚙`).
  - *Verification:* Assert all 6 elements exist and are visible in the top bar header at standard viewport widths.

- **AC-04 [P0] Reader Mode Zustand State & Layout Reconfiguration**
  - Reader mode is driven by a Zustand store with state enum: `'original' | 'bilingual' | 'translation'`.
  - Default mode on initial load is `'bilingual'`.
  - Selecting `原文`: The PDF workspace switches to a **single viewer surface** displaying the Original PDF placeholder (occupies 100% of workspace width).
  - Selecting `译文`: The PDF workspace switches to a **single viewer surface** displaying the Translated PDF placeholder (occupies 100% of workspace width).
  - Selecting `双语`: The PDF workspace switches to **two side-by-side viewer surfaces** (Original on the left, Translated on the right, each occupying 50% split width).
  - *Verification:* Clicking each segment visibly reconfigures the DOM between 1 panel and 2 panels; active tab styling updates simultaneously.

- **AC-05 [P0] Collapsible AI Sidebar Geometry & State**
  - AI Sidebar collapse state (`isOpen: boolean`) is managed via Zustand (default: `true`).
  - In expanded state, the sidebar width is constrained within `320px` to `380px` (e.g. `w-[340px]`).
  - Clicking the collapse toggle collapses the sidebar (width collapses to `0px` or a minimal rail `≤ 48px`).
  - When collapsed, a persistent expand trigger button remains accessible in the UI.
  - Toggling sidebar collapse causes the PDF workspace to immediately reflow and absorb 100% of the reclaimed horizontal space.
  - *Verification:* Measure computed width of the sidebar element in expanded and collapsed states; assert PDF workspace width expands by the exact reclaimed delta.

- **AC-06 [P0] AI Sidebar Internal Component Structure**
  - Sidebar contains the following stacked sections:
    1. **Document Scope Selector:** Displays active scope indicator/dropdown (e.g., `当前论文` / `Current Paper`).
    2. **Quick Action List:** Renders all 6 required academic action buttons:
       - `总结本页` (Summarize Page)
       - `解释选中内容` (Explain Selection)
       - `解释公式` (Explain Formula)
       - `总结方法` (Summarize Methodology)
       - `提取创新点` (Extract Novelty/Contributions)
       - `总结实验结果` (Summarize Experimental Results)
    3. **Conversation Area:** Dedicated scrollable container for dialog history with mock greeting message.
    4. **Pinned Bottom Composer:** Pinned to the bottom of the sidebar, containing an input/textarea with placeholder `Ask paper...` and a submit action icon (`➤` / Send).
  - *Verification:* Assert all 6 quick action buttons and the pinned bottom composer are rendered inside the sidebar.

- **AC-07 [P0] PDF Workspace Placeholder Surfaces**
  - Workspace displays styled placeholder viewer panels (neutral slate/gray background, subtle 1px border, document header, mock page surface canvas).
  - Each viewer displays a clear title label (`Original PDF` / `Translated PDF`).
  - Does NOT load or parse real PDF binary files or initialize PDF.js workers in this task.
  - *Verification:* Verify placeholder panels render cleanly without network calls or PDF parsing errors.

- **AC-08 [P0] Bottom Status & Progress Bar Contents**
  - Height is fixed between `28px` and `36px`, spanning the full width of the viewport bottom.
  - Displays placeholder translation status text (e.g., `Translating... Page 5 / 18`).
  - Displays translation progress indicator (e.g., progress bar and `72%` label).
  - Displays engine status indicator (e.g., `Engine: Ready` / `Offline`).
  - *Verification:* Verify all three status elements are rendered and visible in the footer bar.

- **AC-09 [P0] Zero-Backend Standalone Execution (Default State)**
  - Shell starts up and renders fully without any backend server running on `localhost:8000`.
  - Zero unhandled network promise rejections or red console errors on startup.
  - No blocking modal or infinite loading spinner is shown due to backend absence.
  - *Verification:* Launch frontend via `npm run dev` with backend disconnected; page renders completely with zero console errors.

- **AC-10 [P1] Backend URL Config Isolation**
  - API base URL is isolated in an environment configuration file (e.g., `src/config/api.ts` referencing `import.meta.env.VITE_API_BASE_URL ?? "http://127.0.0.1:8000"`).
  - No hardcoded `http://localhost:8000` URLs scattered across UI components.
  - *Verification:* Code inspection confirms centralized API configuration.

---

## 2. Edge Cases

- **AC-11 [P0] Responsive Behavior at 1024px Viewport Width**
  - At `1024px × 768px`:
    - Top bar controls do not wrap into a second row or collide. Document name truncates if necessary.
    - With sidebar expanded (`340px`), the remaining `~684px` accommodates the dual bilingual viewer panels (`~342px` each) without clipping or horizontal page overflow.
  - *Verification:* Set browser viewport to `1024px × 768px`; verify no horizontal scrollbar on `window` and no element overlapping.

- **AC-12 [P0] Proportional Scaling at 1440px Viewport Width**
  - At `1440px × 900px`:
    - Sidebar maintains configured fixed width (`320px - 380px`).
    - PDF workspace expands to `~1080px`, giving each split viewer `~540px`.
  - *Verification:* Set viewport to `1440px × 900px`; check proportional layout balance.

- **AC-13 [P0] Full-Width Expansion at 1920px (Full HD) Viewport Width**
  - At `1920px × 1080px`:
    - Shell absorbs full viewport width without arbitrary maximum container constraints (`max-w-screen-xl` on root shell is prohibited).
    - Dual viewers expand to absorb all available space (`~770px` each).
  - *Verification:* Set viewport to `1920px × 1080px`; verify layout spans edge-to-edge.

- **AC-14 [P1] Rapid State Toggling**
  - Rapidly alternating between `原文`, `双语`, and `译文` (e.g., 10 clicks in 2 seconds) produces no DOM desynchronization, flickering, or orphaned viewer elements.
  - Rapidly toggling sidebar collapse/expand preserves state integrity without animation glitches.
  - *Verification:* Automated or manual rapid click test across all toggle controls.

- **AC-15 [P1] Long Document Name Handling**
  - Document filenames exceeding 60 characters (e.g., `2403.12345v2_Deep_Residual_Learning_for_Multimodal_Robotics_Paper_Final.pdf`) truncate with an ellipsis (`text-ellipsis overflow-hidden whitespace-nowrap`).
  - Does not push mode switch buttons or settings gear off-screen.
  - *Verification:* Inject an 80-character string into document name state; verify top bar layout remains intact.

---

## 3. Error Handling Criteria

- **AC-16 [P0] Root Error Boundary Protection**
  - Application shell is wrapped in a React Error Boundary (`ErrorBoundary`).
  - In the event of an unhandled runtime error in any child component, a graceful fallback view is displayed instead of an empty white screen.
  - *Verification:* Intentionally throw an error inside a child component; confirm error boundary catches and displays fallback message.

- **AC-17 [P0] Graceful Network Isolation**
  - Any health-check or status polling mechanism implemented must catch fetch errors (`catch (e) => { ... }`) and report engine as `Offline` / `Standalone` without throwing uncaught exceptions.
  - *Verification:* Check DevTools console; zero `Uncaught (in promise)` errors.

- **AC-18 [P1] Composer Input Validation**
  - In the AI sidebar composer, sending an empty message or whitespace-only message is disabled (button disabled or submit handler returns early).
  - *Verification:* Press Enter or click send button on empty composer; no empty message card is added.

---

## 4. Regression Protection

- **AC-19 [P0] Strict TypeScript Typecheck**
  - `npm run typecheck` (`tsc --noEmit`) passes with 0 errors.
  - No `@ts-ignore`, `@ts-expect-error`, or `any` bypasses in state management or component props.
  - *Verification:* Execute `npm run typecheck` in terminal; exit code must be `0`.

- **AC-20 [P0] Clean Production Build**
  - `npm run build` generates a valid static bundle in `frontend/dist/` without warnings treated as errors.
  - *Verification:* Execute `npm run build` in terminal; exit code must be `0`.

- **AC-21 [P0] Single UI Framework Dependency Isolation**
  - `package.json` contains only Tailwind CSS, Lucide icons, and shadcn/ui (Radix) primitives.
  - No legacy or alternative UI libraries (`@mui/*`, `antd`, `@chakra-ui/*`, `bootstrap`).
  - *Verification:* Inspect `frontend/package.json` dependencies.

- **AC-22 [P0] Dependency Boundary Enforcement (No Premature PDF.js or Tauri Packages)**
  - Neither `pdfjs-dist` nor `@tauri-apps/api` are added in `package.json` for this task.
  - *Verification:* Inspect `frontend/package.json`; confirm absence of `pdfjs-dist` and `@tauri-apps/*`.

---

## 5. Security Criteria

- **AC-23 [P0] Zero External Font / Script CDNs (Offline-First Privacy)**
  - `frontend/index.html` loads all assets, styles, and fonts locally.
  - No external CDN links (e.g. `fonts.googleapis.com`, `cdnjs.cloudflare.com`, or external analytics scripts).
  - *Verification:* Inspect `index.html` and network panel on reload; zero external outbound requests.

- **AC-24 [P1] XSS Prevention in Conversation Mock**
  - Mock conversation area renders user/assistant inputs using standard JSX escaping.
  - No usage of `dangerouslySetInnerHTML` for chat messages.
  - *Verification:* Search codebase for `dangerouslySetInnerHTML`; assert 0 occurrences.

---

## 6. Performance Expectations

- **AC-25 [P0] Bundle Size Budget**
  - Total production JS bundle size (`dist/assets/*.js`) must remain under `500 KB` uncompressed (vendor + app chunks combined, excluding sourcemaps).
  - Total production CSS bundle size must remain under `60 KB`.
  - *Verification:* Run `npm run build` and inspect output file sizes in `dist/assets/`.

- **AC-26 [P0] Initial Render Performance**
  - Time to Interactive (TTI) and First Contentful Paint (FCP) must be `< 300 ms` when served via `npm run preview` on localhost.
  - *Verification:* Chrome DevTools Lighthouse audit or Performance tab measure.

- **AC-27 [P1] Cumulative Layout Shift (CLS)**
  - CLS on initial page load must be `0.00`.
  - Four layout regions initialize with fixed/flex bounds, eliminating layout jumps.
  - *Verification:* Measure CLS via Performance Observer or Lighthouse.

---

## 7. UI/UX Criteria

- **AC-28 [P0] Academic Productivity Tool Styling Register**
  - Strict compliance with IDE/desktop productivity aesthetic:
    - Neutral color palette (slate/zinc/neutral grays, `bg-slate-50` / `bg-white`, subtle `1px` borders).
    - Compact typography (`text-xs` / `text-sm` for controls, labels, and status bar).
    - No consumer SaaS marketing cards, no hero banners, no decorative gradients, no heavy shadows (`shadow-xl`/`shadow-2xl`), and no glassmorphism blur cards.
  - *Verification:* Visual inspection against academic desktop design specifications.

- **AC-29 [P0] Strict Viewport Scroll Containment**
  - The outer viewport (`window` / `body`) has zero scrollbars (`overflow: hidden`).
  - Scrolling is strictly localized:
    - AI sidebar conversation area scrolls independently when message count exceeds viewport height (`overflow-y: auto`).
    - PDF workspace viewer surfaces scroll independently (`overflow-y: auto`).
  - *Verification:* Trigger mousewheel over various regions; verify page-level scroll does not occur.

- **AC-30 [P1] Interactive States & Affordances**
  - All interactive elements (reader mode tabs, sidebar collapse toggle, quick action buttons, settings, translate) have visible `:hover`, `:active`, and `:focus-visible` styling conforming to shadcn/ui.
  - Active reader mode tab has distinct visual affordance (e.g. background fill, active indicator).
  - *Verification:* Keyboard Tab navigation and mouse hover test.

- **AC-31 [P1] Light Theme Semantic Tokens**
  - Theme is implemented using semantic CSS variables or Tailwind utility classes that do not hardcode absolute dark styles, keeping the DOM structure clean for future dark mode support.
  - Default view renders strictly as a crisp, high-contrast light theme suitable for paper reading.
  - *Verification:* Inspect theme styles in `tailwind.config.js` and root CSS files.

---

## 8. Suggested Automated Tests

- **AC-32 [P0] Vitest / RTL: Mode Switching Layout Test**
  - Render `<App />` in test environment.
  - Assert default mode renders both `Original PDF` and `Translated PDF` panels.
  - Click `原文` segment; assert only `Original PDF` panel exists in DOM.
  - Click `译文` segment; assert only `Translated PDF` panel exists in DOM.
  - Click `双语` segment; assert both panels exist again.
  - *Location:* `frontend/src/tests/reader-mode.test.tsx`.

- **AC-33 [P0] Vitest / RTL: Sidebar Collapse & Expand Test**
  - Render `<App />`.
  - Assert sidebar is visible and expanded.
  - Click collapse button; assert sidebar container reflects collapsed state/class.
  - Click expand button; assert sidebar returns to expanded state/class.
  - *Location:* `frontend/src/tests/sidebar-toggle.test.tsx`.

- **AC-34 [P0] Vitest / RTL: Standalone Startup (No Backend Mock Needed)**
  - Render `<App />` without setting up any mock HTTP interceptors (MSW) or backend mock servers.
  - Assert shell renders all 4 regions cleanly without errors or rejected promises.
  - *Location:* `frontend/src/tests/app-shell.test.tsx`.

- **AC-35 [P1] Vitest / RTL: Quick Actions Clickability Test**
  - Assert all 6 quick action buttons render with expected text.
  - Trigger click on each button; verify click handler triggers without runtime exceptions.
  - *Location:* `frontend/src/tests/quick-actions.test.tsx`.

---

## 9. Suggested Manual Tests

- **AC-36 [P0] Viewport Multi-Resolution Visual Verification & Evidence Capture**
  - Open Chrome DevTools Device Mode:
    1. Set viewport to `1024px × 768px`: Inspect top bar, sidebar, and dual viewers for overlap or overflow.
    2. Set viewport to `1440px × 900px`: Inspect desktop balance.
    3. Set viewport to `1920px × 1080px`: Inspect full-width scaling.
  - Capture screenshot at `1440px` and save to `.agent/screenshots/DS-FE-001.png`.
  - *Verification:* Review captured screenshot against design specifications.

- **AC-37 [P1] Independent Scroll Verification**
  - Add 20 mock chat messages to the conversation area.
  - Scroll inside the conversation area: verify the conversation container scrolls smoothly while top bar, composer, and PDF workspace remain anchored.
  - Add excessive content to PDF viewers: verify viewers scroll internally without triggering window scroll.

- **AC-38 [P1] Keyboard Focus Traversal Test**
  - Press `Tab` starting from document load:
  - Verify logical tab order: Top bar controls -> Mode switches -> AI Translate -> Search -> Settings -> Sidebar toggle -> Quick actions -> Composer input -> Send button.

---

## 10. Explicit Failure Conditions

Any of the following conditions constitutes an immediate **FAIL** for task `DS-FE-001`:

1. **F-01 (Type/Build Failure):** `npm run typecheck` or `npm run build` fails with non-zero exit code or TypeScript errors.
2. **F-02 (UI Framework Pollution):** Installation of secondary UI libraries (e.g. `@mui/material`, `antd`, `@chakra-ui/react`) or styling frameworks other than Tailwind CSS + shadcn/ui.
3. **F-03 (Premature PDF / Tauri Integration):** Inclusion of `pdfjs-dist` or `@tauri-apps/*` packages in `package.json`.
4. **F-04 (Hollow State Implementation):** Switching between `原文`, `双语`, and `译文` only changes text/labels without altering the actual DOM structure and workspace panel layout.
5. **F-05 (Broken Standalone State):** Shell displays an unhandled error screen, crashes, or stalls on an infinite loading spinner when the backend server is absent.
6. **F-06 (Window Scroll Leakage):** Appearance of outer window-level horizontal or vertical scrollbars (`html` or `body` scrollbars) at standard screen dimensions (`1024px`, `1440px`, `1920px`).
7. **F-07 (Aesthetic Drift):** Implementation adopts consumer landing-page styles, card-based dashboard widgets, decorative gradients, or heavy decorative animations explicitly forbidden by the academic productivity brief.
8. **F-08 (Missing Visual Evidence):** Failure to generate and verify `.agent/screenshots/DS-FE-001.png` across required resolutions.
