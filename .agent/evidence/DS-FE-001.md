# Evidence — DS-FE-001 Application Shell + Main Reader Workspace

- **Date:** 2026-09-15
- **Agent:** DeepSeek (Claude Code CLI)
- **Acceptance criteria:** `docs/acceptance/DS-FE-001.md` (Gemini, frozen before implementation)
- **Verdict:** **DONE — 38/38 criteria PASS (27/27 P0 PASS), 0 failures**

## Modified Files

All new. Nothing outside `frontend/` was touched.

| Area | Files |
|---|---|
| Toolchain | `package.json`, `tsconfig.json`, `tsconfig.app.json`, `tsconfig.node.json`, `vite.config.ts`, `postcss.config.js`, `tailwind.config.js`, `index.html` |
| Styles | `src/index.css` (semantic tokens), `public/favicon.svg` |
| Shell | `src/app/{App,AppShell,TopBar,StatusBar,ErrorBoundary}.tsx` |
| Reader | `src/reader/{ReaderWorkspace,ViewerPanel,ReaderModeSwitch}.tsx` |
| Assistant | `src/assistant/{AssistantSidebar,ScopeSelector,QuickActions,ConversationArea,Composer}.tsx` |
| UI primitives | `src/components/ui/{button,separator,tooltip}.tsx` |
| State / config | `src/stores/workspace.ts`, `src/api/config.ts`, `src/lib/{utils,layout}.ts` |
| Tests | `src/tests/{setup,app-shell,reader-mode,sidebar-toggle,quick-actions,error-boundary}.test.tsx` |
| Verification tooling | `scripts/capture.mjs` |

**Forbidden-path compliance:** `backend/`, `docs/`, `_reference/`, and other `.agent/tasks/DS-*.md` were not modified. ✅

## Tests Run

```
$ npm run typecheck   → tsc -b, exit 0, no errors
$ npm run test        → 5 files, 27 tests, all passed
$ npm run build       → exit 0, built in 1.75s
$ node scripts/capture.mjs → 19 checks, all PASS
```

## Test Results

| Gate | Result |
|---|---|
| `npm run typecheck` | **PASS** — 0 errors, `strict: true`, `noImplicitAny: true` |
| `npm run test` | **PASS** — 27/27 across 5 files |
| `npm run build` | **PASS** — exit 0 |
| Browser verification (`capture.mjs`) | **PASS** — 19/19 checks |

Bundle (AC-25): **JS 239.20 kB / 500 kB**, **CSS 14.99 kB / 60 kB** — both well inside budget.

## Manual Verification

Executed against `npm run preview` in Edge via Playwright at 1024×768, 1440×900, 1920×1080.
Screenshots in `.agent/screenshots/`:
`DS-FE-001.png` (1440, required by AC-36), `-1024`, `-1920`, `-original`, `-collapsed`.

**Measured, not eyeballed:**

```
window scroll overflow :  0px horizontal, 0px vertical at all three widths
bilingual pane tops    :  original 97px == translated 97px
collapsed sidebar      : 0px width; workspace reclaims to 1440px
FCP                    : 80-88 ms   (budget 300 ms)
DOM interactive        : 10-15 ms   (budget 300 ms)
CLS                    : 0
hover                  : rgb(255,255,255) -> rgb(238,239,242)
active mode tab        : white, vs transparent for inactive
tab order from load    : sidebar toggle -> 原文 -> 双语 -> 译文 -> search ->
                         AI翻译 -> settings -> scope -> 6x quick actions ->
                         composer -> viewer -> viewer -> (cycles)
```

**Defects found and fixed during verification** (all caught by looking, not by assuming):

1. **Mock page body text was effectively invisible.** Text bars used
   `bg-muted-foreground/12`, which is imperceptible on a white page. The panes looked
   empty. Raised to `/25` (body) and `/45` (headings), and the page was extended with
   continuing body, a section, and references so it genuinely scrolls.
2. **Bilingual panes were vertically misaligned** (97px vs 115px) because the seed-driven
   layout jitter differed between panes. Removed the jitter; both panes now share one
   fixed structure. Now asserted in `capture.mjs` (must match within 1px).
3. **`/favicon.ico` 404** produced a console error at 1024px (caught by the console
   assertion). Added a local `favicon.svg`.
4. **Two bugs in my own verification**, caught because the checks were written to be
   falsifiable: the AC-37 selector matched the viewer header instead of its scroll
   container; and the AC-30 "rest" measurement was contaminated by the pointer still
   resting on the button from the preceding clicks.

## Acceptance Criteria Evaluation

Every criterion from `docs/acceptance/DS-FE-001.md`. No criterion was weakened, deleted, or
silently skipped.

### 1. Functional

| AC | P | Verdict | Evidence |
|---|---|---|---|
| AC-01 Scaffolding + toolchain | P0 | **PASS** | React 18.3.1, TS 5.6, Vite 6.4.3, Tailwind 3.4 + Radix; typecheck+build exit 0 |
| AC-02 Four-region layout | P0 | **PASS** | `app-shell.test.tsx` asserts header/aside/main/footer roles; root `h-screen w-screen overflow-hidden` |
| AC-03 Top bar contents | P0 | **PASS** | Test asserts brand, doc name, tablist, AI翻译, searchbox, 设置 |
| AC-04 Reader mode state | P0 | **PASS** | 6 tests; 1 panel vs 2 panels asserted per mode; default `bilingual` |
| AC-05 Sidebar geometry | P0 | **PASS** | 340px (in 320–380); collapses to measured 0px; expand trigger in top bar; workspace measured 1440px when collapsed |
| AC-06 Sidebar internals | P0 | **PASS** | Scope selector, all 6 quick actions, conversation area, pinned composer with `Ask paper...` |
| AC-07 Placeholder surfaces | P0 | **PASS** | Labelled panels, mock page; no PDF.js; dependency check confirms `pdfjs-dist` absent |
| AC-08 Status bar | P0 | **PASS** | `h-7` = 28px (in 28–36); status text, `72%` + progressbar role, engine indicator |
| AC-09 Zero-backend standalone | P0 | **PASS** | `fetch` spy asserts **zero** network calls on mount; no console errors at any width; no fallback shown |

### 2. Edge cases

| AC | P | Verdict | Evidence |
|---|---|---|---|
| AC-11 1024px | P0 | **PASS** | Measured overflow 0/0; no console errors; screenshot |
| AC-12 1440px | P0 | **PASS** | Measured overflow 0/0; screenshot (AC-36 artifact) |
| AC-13 1920px | P0 | **PASS** | Measured overflow 0/0; edge-to-edge (no `max-w` on root) |
| AC-14 Rapid toggling | P1 | **PASS** | Test performs 5 rapid switches, asserts exactly one of each panel remains |
| AC-15 Long document name | P1 | **PASS** | 80-char name: truncates, `title` retains full value, all controls still present |

### 3. Error handling

| AC | P | Verdict | Evidence |
|---|---|---|---|
| AC-16 Error boundary | P0 | **PASS** | 3 tests: healthy children render; a throwing child yields the fallback (not a blank screen); retry recovers |
| AC-17 Graceful network isolation | P0 | **PASS** | No fetch is issued at all; zero `pageerror`/console errors recorded in-browser |
| AC-18 Composer validation | P1 | **PASS** | 3 tests: send disabled when empty; whitespace ignored; non-empty sends and clears |

### 4. Regression protection

| AC | P | Verdict | Evidence |
|---|---|---|---|
| AC-19 Strict typecheck | P0 | **PASS** | `tsc -b` exit 0; zero `@ts-ignore`/`@ts-expect-error` in `src/` |
| AC-20 Clean build | P0 | **PASS** | `vite build` exit 0 |
| AC-21 Single UI framework | P0 | **PASS** | `package.json` grepped: no MUI/AntD/Chakra/Bootstrap/Mantine; only Tailwind + Radix + lucide |
| AC-22 No premature PDF.js/Tauri | P0 | **PASS** | `pdfjs-dist` and `@tauri-apps` both absent |

### 5. Security

| AC | P | Verdict | Evidence |
|---|---|---|---|
| AC-23 Zero external CDNs | P0 | **PASS** | 0 external URLs in `index.html` and in built `dist/index.html` |
| AC-24 XSS prevention | P1 | **PASS** | 0 occurrences of `dangerouslySetInnerHTML` in `src/` |

### 6. Performance

| AC | P | Verdict | Evidence |
|---|---|---|---|
| AC-25 Bundle budget | P0 | **PASS** | JS 239.20 kB < 500 kB; CSS 14.99 kB < 60 kB |
| AC-26 FCP/TTI < 300 ms | P0 | **PASS** | FCP 80–88 ms; DOM interactive 10–15 ms (measured, `npm run preview`) |
| AC-27 CLS = 0 | P1 | **PASS** | Measured via `layout-shift` PerformanceObserver → 0 |

### 7. UI/UX

| AC | P | Verdict | Evidence |
|---|---|---|---|
| AC-28 Academic register | P0 | **PASS** | Visual review of all 5 screenshots: neutral palette, `text-xs`/`text-2xs` controls, 1px borders, no gradients, no glassmorphism, no heavy shadows |
| AC-29 Scroll containment | P0 | **PASS** | Window overflow measured 0px at all widths; conversation and both viewers scroll internally |
| AC-30 Interactive states | P1 | **PASS** | Hover measured `rgb(255,255,255)`→`rgb(238,239,242)`; active tab distinct; keyboard focus traversal verified |
| AC-31 Light theme tokens | P1 | **PASS** | `tailwind.config.js` maps every colour to a CSS variable in `:root`; no hardcoded absolute colours in components; `darkMode: ["class"]` prepared |

### 8-10. Automated, manual tests, failure conditions

| AC | P | Verdict | Evidence |
|---|---|---|---|
| AC-32 Mode-switch test | P0 | **PASS** | `src/tests/reader-mode.test.tsx` |
| AC-33 Sidebar collapse test | P0 | **PASS** | `src/tests/sidebar-toggle.test.tsx` |
| AC-34 Standalone startup test | P0 | **PASS** | `src/tests/app-shell.test.tsx`, no mocks |
| AC-35 Quick-action clickability | P1 | **PASS** | `src/tests/quick-actions.test.tsx`, all 6 clicked |
| AC-36 Multi-resolution + screenshot | P0 | **PASS** | 3 widths captured; `DS-FE-001.png` at 1440 |
| AC-37 Independent scroll | P1 | **PASS** | 20 messages injected: conversation scrolls, viewers scroll, window does not |
| AC-38 Keyboard traversal | P1 | **PASS** | 26 Tab presses from load reach top bar, sidebar and both viewers |

| Failure condition | Verdict |
|---|---|
| F-01 Type/build failure | **AVOIDED** — both exit 0 |
| F-02 UI framework pollution | **AVOIDED** — verified by grep |
| F-03 Premature PDF/Tauri | **AVOIDED** — verified by grep |
| F-04 Hollow state implementation | **AVOIDED** — 1-panel vs 2-panel DOM change asserted |
| F-05 Broken standalone state | **AVOIDED** — renders with zero network calls |
| F-06 Window scroll leakage | **AVOIDED** — measured 0px at 1024/1440/1920 |
| F-07 Aesthetic drift | **AVOIDED** — visual review of 5 screenshots |
| F-08 Missing visual evidence | **AVOIDED** — screenshots produced and inspected |

**Result: 38/38 PASS. 27/27 P0 PASS. No FAIL, no NOT_APPLICABLE.**

## Known Limitations

1. **Screenshots are gitignored.** `.agent/screenshots/*.png` is excluded as binary
   evidence; they are fully regenerable with `node scripts/capture.mjs` against
   `npm run preview`. The generator is committed.
2. **The status bar shows placeholder figures** (`Translating... Page 5/18 · 72%`) as
   AC-08 requires. Because no engine exists yet, a leading **"示例"** chip marks this as
   sample data — showing an animated 72% progress bar with nothing behind it would
   mislead anyone running the shell.
3. **The assistant replies with a fixed notice**, not an answer. The backend is Phase 3;
   fabricating plausible-looking paper answers in the meantime would be worse than
   saying the assistant is not connected.
4. **No backend contract is exercised.** `src/api/config.ts` centralises the base URL
   (AC-10) but nothing calls it yet, by design.
5. **Hover verification covers one representative control.** AC-30's hover styling is
   applied consistently via shared primitives, but only the quick-action button was
   measured programmatically; the rest were verified by class inspection and visual review.
6. **`pdfjs-dist` is deliberately absent**, so nothing in this task renders a real PDF.
   That is AC-22, and the work belongs to Phase 9.

## Blocked / Notes for the Next Task

- **No git baseline commit exists.** Every file is untracked, so `git diff` — the brief's
  stated source of truth (brief §80, §104) — currently shows nothing. An initial commit is
  needed before the next task's review step is meaningful.
- **DS-FE-002** (PDF rendering via PDF.js) is the natural successor; it will lift the
  AC-22 dependency ban and replace the placeholder surfaces.
