# Acceptance Criteria — DS-DOC-009: Typographic Refinement & Formula Presentation in Reflowed Reading (重排版字体与公式排版精修)

- **Author:** independent acceptance criteria author
- **Reviewed and frozen by:** project maintainer (pending implementation)
- **Date:** 2026-09-26
- **Baseline:** Commit `00ec259` / Post-DS-DOC-008 (`SCHEMA_VERSION = 5`, `IR_PIPELINE_VERSION = "5"`, `BILINGUAL_SCHEMA_VERSION = "1"`, initial bundle chunk measured at `307.87 kB`, headroom `2.13 kB` under frozen `310.0 kB` ceiling)
- **Deliverable:** `docs/acceptance/DS-DOC-009.md` (authored before any production code)
- **Status:** **PROPOSED — 12 P0 · 4 P1 · 2 P2**

---

## 0. Independent Acceptance Author Statement & Review Framing

### 0.1 Process Discipline & Task Boundary
DS-DOC-008 delivered the functional reflow bilingual reader (`ReflowBilingualReader.tsx`), establishing content-addressed paragraph translation display, topological block streaming, semantic caption attachment, and zero-provider-call reloads.
The reader's direct aesthetic verdict on real papers:
> *"字体和公式排版不够好看"*

This document is the targeted typographic and formula presentation amendment to DS-DOC-008. It changes **only** type scale, font stacks, spatial rhythm, formula magnification, crop framing, and responsive table/figure presentation.
- **Strict Invariance:** Backend routes (`/api/documents/{id}/bilingual-text`), pipeline batching, disk cache layout (`_cache/bilingual/`), database schemas (`SCHEMA_VERSION = 5`), citation plaintext rendering (AC-P0-23), caption pairing logic (`caption_of`), and reading-order assembly (AC-P0-16) remain **100% frozen and untouched**.
- **Production Code Prohibition:** The author of this document writes zero production code. Production implementation belongs solely to the main agent once this contract is frozen.

### 0.2 The Core Problem: Why It Looked Unattractive
Two specific flaws generated the reader's complaint:
1. **The Formula Size Disconnect (The 9.3 pt vs. 15 px Gulf):**
   In the reader's paper (`2607.00784v1`), display formulas were printed at **9.3 pt** (and one at 6.5 pt). In DS-DOC-008, formula crops were rendered at standard $1.0\times$ view scale ($9.3\text{ pt} \times 1.333 \approx 12.4\text{ px}$ em), set directly beneath **15 px** prose. Lowercase formula glyphs ($x \approx 5.6\text{ px}$) were two-thirds the size of prose ($x \approx 8.0\text{ px}$). The formula appeared shrunken, weak, and visually disconnected.
   Because crops are rendered dynamically from the PDF.js vector engine, drawing them larger produces **razor-sharp vector ink**, not blurry raster interpolation.
2. **Mechanistic Rather than Designed Prose Typography:**
   DS-DOC-008 applied arbitrary values: `max-w-[680px]`, source `15px`/`1.65`, translation `14px`/`1.6`, and a left border accent (`border-l-2 border-primary/25 pl-3`) on every translation. In a 101-paragraph paper, 97 consecutive left border rules produced an exhausting "quote wall" texture, while the generic sans-serif text failed to distinguish the authoritative academic source from the auxiliary reading translation.

### 0.3 Zero-Dependency, Offline-First System Font Philosophy
In conformance with the application's offline-first architecture and rigid **310.0 kB** initial bundle ceiling (measured at 307.87 kB, leaving only 2.13 kB headroom):
- **Zero Webfonts & Zero CDN:** No Google Fonts, no `@font-face` downloads, no KaTeX / MathJax / MathML libraries.
- **Platform-Native Typographic Stacks:**
  - **Latin Academic Serif (Source Prose):** Native high-legibility book serifs available across Windows, macOS, and Linux (`Charter`, `Source Serif Pro`, `Iowan Old Style`, `Georgia`, `Cambria`, `Times New Roman`).
  - **CJK Sans-Serif (Translation Prose):** Clean, modern Hei-ti stacks optimized for on-screen legibility (`-apple-system`, `BlinkMacSystemFont`, `"PingFang SC"`, `"Hiragino Sans GB"`, `"Microsoft YaHei"`, `"WenQuanYi Micro Hei"`).
  - **Mathematics:** Native vector glyphs embedded in the PDF's own font descriptors, re-rendered via PDF.js vector paths inside canvas crops.

---

## 1. Executive Judgment: Is this task worth doing?

**Yes. It resolves the primary visual barrier to daily academic use without introducing any runtime dependencies, bundle bloat, or pipeline instability.**

Reflowing a two-column paper into a single reading column succeeds only when the reader feels they are reading an elegantly typeset monograph rather than an unstyled developer dump. By scaling vector formula crops into optical balance with body prose and replacing heavy border stripes with subtle typographic contrast, the reflow column achieves publication-grade presentation while remaining 100% offline and cost-free.

---

## 2. Typographic Specifications & Design Decisions

### 2.1 Design Decisions D1–D8

| # | Topic | Verdict | Architectural & Aesthetic Rationale |
|---|---|---|---|
| **D1** | **Source vs. Translation Role** | **Academic Serif for Source; Modern Sans for Translation.** | The English source is the authoritative artifact; set it in a classical academic serif (`Georgia`, `Charter`). The CJK translation is the cognitive aid; set it in a clean, legible system sans-serif (`PingFang SC`, `Microsoft YaHei`). Visual texture immediately differentiates the two without cognitive friction. |
| **D2** | **Abolition of the Left Accent Stripe** | **Remove `border-l-2 pl-3` from all standard translation paragraphs.** | 97 consecutive vertical stripes clattered the left reading margin into visual noise. Visual subordination is achieved via font size (14px vs. 16px), script contrast (Sans vs. Serif), and tonal weight (`text-foreground/80`). |
| **D3** | **Prose Scale & Line Measure** | **Source: 16px / 1.7 line-height. Measure: 680px.** | Optimal measure for 16px serif is 65–75 characters per line ($680\text{ px}$). Line height at $1.7$ ($27.2\text{ px}$) accommodates Latin descenders and ascenders. Translation is set at 14px / $1.65$ line-height ($23.1\text{ px}$). |
| **D4** | **Display Formula Optical Boost** | **Scale `isolate_formula` crops by $1.28\times$ ($M_{\text{formula}} = 1.28$).** | Elevates native 9.3 pt formula glyphs ($12.4\text{ px}$) to $15.9\text{ px}$ optical size, matching the 16px prose. Sharp vector re-rendering via PDF.js; bounded at $100\%$ column width. |
| **D5** | **Formula Alignment & Numbering** | **Formula centered; equation number right-aligned.** | Emulates traditional journal typography (e.g. Nature/IEEE). Uses a three-slot flex/grid layout so the formula is truly centered relative to the reading column, with equation number anchored to the right margin. |
| **D6** | **Spatial Rhythm & Gestalt Grouping** | **Intra-pair gap: 8px. Inter-pair gap: 28px (3.5:1 ratio).** | The 3.5:1 gap ratio binds each source paragraph and its translation into a single perceived object (Gestalt proximity) before transitioning to the next paragraph pair. |
| **D7** | **Wide Table Presentation** | **Scrollable crop wrapper (`overflow-x-auto`); column never scrolls.** | Reading column preserves strict `overflow-x-hidden`. Tables wider than 680px sit in an inner horizontal-scroll container with smooth touch/drag panning, preventing unreadable micro-scaling. |
| **D8** | **Dark Theme Integrity** | **Semantic token swap; 0 color inversion on scientific crops.** | Background and prose colors resolve through semantic CSS variables keeping contrast $\ge 4.5:1$. Vector crops retain true PDF colors (no `filter: invert()` that breaks scientific figures or plots); subtle dark-mode card backing prevents glare. |

---

### 2.2 Typographic Hierarchy & Scale Matrix

All typography is rendered in relative units with exact pixel fallbacks:

| Element | Font Stack | Font Size | Line Height | Weight | Color / Opacity | Vertical Spacing |
|---|---|---|---|---|---|---|
| **Section H1** | System Sans / Serif | `1.375rem` (22px) | `1.35` (29.7px) | 700 Bold | `text-foreground` | `mt-10 mb-3` (40px / 12px) |
| **H1 Translation** | System CJK Sans | `0.9375rem` (15px) | `1.4` (21px) | 400 Regular | `text-muted-foreground` | `mt-1` (4px) |
| **Section H2** | System Sans / Serif | `1.1875rem` (19px) | `1.4` (26.6px) | 600 SemiBold | `text-foreground` | `mt-8 mb-2` (32px / 8px) |
| **H2 Translation** | System CJK Sans | `0.875rem` (14px) | `1.4` (19.6px) | 400 Regular | `text-muted-foreground` | `mt-1` (4px) |
| **Section H3** | System Sans / Serif | `1.0625rem` (17px) | `1.45` (24.7px) | 600 SemiBold | `text-foreground` | `mt-6 mb-2` (24px / 8px) |
| **H3 Translation** | System CJK Sans | `0.8125rem` (13px) | `1.4` (18.2px) | 400 Regular | `text-muted-foreground` | `mt-0.5` (2px) |
| **Source Prose** | Academic Serif Stack | `1.0rem` (16px) | `1.7` (27.2px) | 400 Regular | `text-foreground` | — |
| **Translation Prose**| System CJK Sans Stack| `0.875rem` (14px) | `1.65` (23.1px)| 400 Regular | `text-foreground/80` | `mt-2` (8px) |
| **Caption** | System UI / Sans | `0.8125rem` (13px) | `1.5` (19.5px) | 400 Regular | `text-muted-foreground`| Above table: `mb-2`; Below fig: `mt-2` |
| **Table Footnote** | System UI / Sans | `0.75rem` (12px) | `1.4` (16.8px) | 400 Regular | `text-muted-foreground/85`| `mt-1.5` (6px) |

---

### 2.3 System Font Stacks Specification

```css
/* Academic Latin Serif: Bookish, open apertures, sturdy x-height */
.reflow-font-serif {
  font-family:
    "Charter",
    "Source Serif Pro",
    "Iowan Old Style",
    "Georgia",
    "Cambria",
    "Times New Roman",
    serif;
  font-feature-settings: "kern" 1, "liga" 1, "calt" 1;
}

/* System CJK Sans-Serif: Crisp on-screen Hei-ti */
.reflow-font-sans {
  font-family:
    -apple-system,
    BlinkMacSystemFont,
    "PingFang SC",
    "Hiragino Sans GB",
    "Microsoft YaHei",
    "WenQuanYi Micro Hei",
    ui-sans-serif,
    system-ui,
    sans-serif;
}
```

---

### 2.4 Formula Magnification & Geometric Alignment Model

#### Formula Crop Sizing Calculation
Let:
- $W_{\text{col}}$ be the active reading column width (nominal 680px, responsive on narrow screens).
- $B_{\text{fx}} = [x_0, y_0, x_1, y_1]$ be the formula bounding box in PDF points ($72\text{ pt} = 1\text{ in}$).
- $S_{\text{view}}$ be the user/workspace zoom factor (e.g. $1.0$).
- $R_{\text{dpr}}$ be `window.devicePixelRatio` (e.g. $1.0$, $1.5$, $2.0$).
- $M_{\text{formula}} = 1.28$ be the formula optical magnification factor.
- $W_{\text{num}}$ be the width reserved for formula number caption (typically 48–64px).

The formula canvas raster render width and CSS layout width are computed as:
$$W_{\text{natural\_px}} = (x_1 - x_0) \times \frac{96}{72} \times S_{\text{view}}$$
$$W_{\text{boosted\_px}} = W_{\text{natural\_px}} \times M_{\text{formula}}$$
$$W_{\text{target\_css}} = \min(W_{\text{boosted\_px}}, W_{\text{col}} - W_{\text{num}} - 16\text{px})$$
$$S_{\text{effective}} = \frac{W_{\text{target\_css}}}{x_1 - x_0}$$

The offscreen canvas backing-store pixels are allocated at exact vector sharpness:
$$\text{canvas.width} = \mathrm{round}(W_{\text{target\_css}} \times R_{\text{dpr}})$$
$$\text{canvas.height} = \mathrm{round}((y_1 - y_0) \times S_{\text{effective}} \times R_{\text{dpr}})$$

#### Formula Layout Grid
```html
<div class="reflow-formula-row grid grid-cols-[1fr_auto_1fr] items-center my-7 w-full">
  <!-- Slot 1: Left balancing spacer -->
  <div aria-hidden="true"></div>
  
  <!-- Slot 2: True Centered Boosted Formula Canvas -->
  <div class="flex justify-center max-w-full overflow-hidden">
    <CropCanvas ... />
  </div>
  
  <!-- Slot 3: Right-aligned Formula Number Caption -->
  <div class="flex justify-end pr-1 text-xs text-muted-foreground select-none">
    <span>(1)</span>
  </div>
</div>
```

---

### 2.5 Superseded Values Mapping Matrix (DS-DOC-008 $\to$ DS-DOC-009)

| Parameter | DS-DOC-008 Frozen Value | DS-DOC-009 Superseding Specification | Concrete Change |
|---|---|---|---|
| **Source Prose Size** | `0.9375rem` (15px) | `1.0rem` (16px) | Increased by +1px to standard body reading size. |
| **Source Prose Line Height** | `1.65` (24.75px) | `1.7` (27.2px) | Expanded by +2.45px for academic serif descenders. |
| **Source Prose Font** | Implicit system sans | Explicit `.reflow-font-serif` (`Charter`, `Georgia`) | Classical academic serif replaces generic sans. |
| **Translation Prose Size**| `0.875rem` (14px) | `0.875rem` (14px) | Preserved at 14px for clear visual subordination. |
| **Translation Line Height**| `1.6` (22.4px) | `1.65` (23.1px) | Adjusted to 1.65 for improved CJK line breathing. |
| **Translation Left Accent**| `border-l-2 border-primary/25 pl-3` | **DELETED** (0px border, 0px extra left padding) | Eliminates vertical stripe clutter across paper. |
| **Translation Tone** | `hsl(var(--foreground) / 0.85)` | `hsl(var(--foreground) / 0.80)` | Controlled secondary weight; contrast $\ge 7:1$. |
| **Intra-Pair Gap** | `0.5rem` (8px) | `0.5rem` (8px) | Preserved to keep semantic pair tightly coupled. |
| **Inter-Pair Gap** | `1.5rem` (24px) | `1.75rem` (28px) | Widened from 24px to 28px (3.5:1 ratio vs intra). |
| **Formula Render Scale**| $1.0\times$ view scale (9.3 pt / 12.4px)| $1.28\times$ view scale ($M_{\text{formula}} = 1.28$) | Formulas drawn +28% larger to match 16px prose. |
| **Formula Alignment** | Centered with inline flex beside caption | 3-slot grid: true centered crop, right margin number | True centering regardless of equation number length. |
| **Section Heading H1** | `1.25rem` (20px) / `1.4` | `1.375rem` (22px) / `1.35` / `mt-10 mb-3` | More authoritative title scale; generous top rhythm. |
| **Section Heading H2** | `1.125rem` (18px) / `1.45` | `1.1875rem` (19px) / `1.4` / `mt-8 mb-2` | Refined section step. |
| **Section Heading H3** | `1.0rem` (16px) / `1.5` | `1.0625rem` (17px) / `1.45` / `mt-6 mb-2` | Clear distinction from 16px body text. |
| **Caption Size** | `0.75rem` (12px) | `0.8125rem` (13px) / `line-height: 1.5` | Improved legibility for multi-line figure captions. |
| **Wide Table Behavior** | Pure `max-w-full h-auto` shrink | Inner `overflow-x-auto` wrapper; column no scroll | Prevents unreadable micro-text on 2-col tables. |

---

## 3. Acceptance Criteria

### 3.1 P0 MUST — Typography, Formula Magnification, Alignment, Spacing, Contrast, Bundle Limit

- **AC-P0-01 Academic Latin Serif Stack for Source Prose.**  
  Source prose (`[data-testid="reflow-source"]`) must be typeset in an academic serif font stack defined as:  
  `"Charter", "Source Serif Pro", "Iowan Old Style", "Georgia", "Cambria", "Times New Roman", serif`.  
  It must NOT inherit the global application sans-serif body font.  
  *Evidence:* Vitest computed style test asserting `getComputedStyle(sourceEl).fontFamily` contains `"Charter"` or `"Georgia"`.

- **AC-P0-02 System CJK Sans-Serif Stack for Translated Prose.**  
  Translated prose (`[data-testid="reflow-translation"]`) must be typeset in a clean system CJK sans-serif font stack containing:  
  `-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "WenQuanYi Micro Hei", sans-serif`.  
  *Evidence:* Vitest computed style test asserting `getComputedStyle(translationEl).fontFamily` contains `"PingFang SC"` or `"Microsoft YaHei"`.

- **AC-P0-03 Deletion of Translation Left Border Stripe (Quote Wall Abolition).**  
  The translated paragraph DOM element must NOT contain `border-l-2`, `border-l`, or any continuous vertical left border line. The left margin of the translated text must align cleanly with the source text (offset $\le 2\text{px}$).  
  *Evidence:* Vitest asserting `translationEl.className` does not contain `border-l` and `getComputedStyle(translationEl).borderLeftWidth === "0px"`.

- **AC-P0-04 Exact Typographic Scale & Measure Enforcement.**  
  The reflow reading column and prose elements must satisfy:
  1. Main reading measure container width is bounded to `max-w-[680px]` (42.5rem).
  2. Source prose font size is `1.0rem` (16px) with `line-height` $\ge 26.5\text{px}$ ($\sim 1.7$).
  3. Translated prose font size is `0.875rem` (14px) with `line-height` $\ge 22.5\text{px}$ ($\sim 1.65$).
  4. Caption font size is `0.8125rem` (13px) with `line-height` $\ge 18.5\text{px}$ ($\sim 1.5$).  
  *Evidence:* Browser measurement in `frontend/scripts/e2e-reflow-bilingual.mjs` verifying `font >= 15.5`, `lineHeight >= 26.0`, and `measure <= 680`.

- **AC-P0-05 Hierarchical Section Heading Scale.**  
  Section headings rendered from `ir.sections` must scale distinctly from 16px body prose:
  - Level 1 (`h1`): `font-size` $\ge 21.5\text{px}$ (`1.375rem`), `font-weight: 700`, `margin-top` $\ge 36\text{px}$.
  - Level 2 (`h2`): `font-size` $\ge 18.5\text{px}$ (`1.1875rem`), `font-weight: 600`, `margin-top` $\ge 28\text{px}$.
  - Level 3 (`h3`): `font-size` $\ge 16.5\text{px}$ (`1.0625rem`), `font-weight: 600`, `margin-top` $\ge 20\text{px}$.  
  *Evidence:* Vitest computed style assertions across `h1`, `h2`, `h3` heading elements.

- **AC-P0-06 Gestalt Paragraph Rhythm (3.5:1 Gap Ratio).**  
  Paragraph pairs must enforce a Gestalt proximity ratio $\ge 3.0:1$:
  1. Intra-pair gap (source to translation) must be `0.5rem` (8px).
  2. Inter-pair gap (between distinct paragraph pairs) must be `1.75rem` (28px).  
  *Evidence:* Vitest assertion verifying intra-pair `margin-top === 8px` and inter-pair container `gap` or `margin-bottom >= 24px`.

- **AC-P0-07 Display Formula Optical Magnification ($M_{\text{formula}} = 1.28$).**  
  All `isolate_formula` crops must be rendered at an effective scale of $1.28 \times S_{\text{view}}$ (nominal optical boost $\ge 1.25\times$ and $\le 1.33\times$). The formula crop canvas width and height must reflect this magnified dimension rather than raw page bounding box scale.  
  *Evidence:* Component test with known formula bounding box `[80, 770, 300, 800]` (width $220\text{ pt}$); verifying rendered canvas CSS width equals $\mathrm{round}(220 \times 1.333 \times 1.28) \pm 2\text{px} \approx 375\text{px}$.

- **AC-P0-08 Formula Container Containment (Zero Overflow).**  
  If a boosted formula's natural width exceeds the column width minus formula number allowance ($W_{\text{col}} - 64\text{px}$), the formula must smoothly clamp to `100%` of available slot width. Horizontal scrollbars on formula blocks are strictly forbidden.  
  *Evidence:* Property test passing an ultra-wide formula box ($W = 600\text{ pt}$); asserting rendered CSS width $\le W_{\text{col}}$.

- **AC-P0-09 True Centered Formula with Right-Aligned Equation Number.**  
  In `isolate_formula` items carrying an equation number caption (e.g. `(1)`):
  1. The formula canvas must be horizontally centered relative to the reading column (left and right margins to column edges equal within $\pm 4\text{px}$).
  2. The equation number must be aligned flush to the right margin of the column.  
  *Evidence:* Vitest bounding rect assertion verifying formula center $X \approx W_{\text{col}} / 2$, and equation number `right` coordinate matches column inner boundary.

- **AC-P0-10 Strict Column Scroll Containment & Tablet Readability.**  
  The main reflow reading column must enforce `overflow-x: hidden`. No combination of long words, oversized formulas, or wide tables may trigger a horizontal scrollbar on the reader container on viewports from $768\text{px}$ (tablet) to $1920\text{px}$ (desktop).  
  *Evidence:* E2E Playwright test resizing viewport to $768\times 1024$; asserting `scrollWidth === clientWidth` on `[data-testid="reflow-scroll"]`.

- **AC-P0-11 WCAG AA Contrast Compliance ($\ge 4.5:1$) in Light and Dark Themes.**  
  1. Source prose must achieve contrast ratio $\ge 7.0:1$ against background in both themes.
  2. Translated prose must achieve contrast ratio $\ge 4.5:1$ against background in both themes.
  3. Captions and footnotes must achieve contrast ratio $\ge 4.5:1$ against background in both themes.  
  *Evidence:* Color contrast calculation test asserting luminance ratios against computed `--workspace` and `--background` tokens.

- **AC-P0-12 Zero New Dependencies & Bundle Ceiling ($\le 310.0\text{ kB}$).**  
  This typographic and formula refinement must add **0** new packages to `frontend/package.json` and 0 font files to the repository. The production build (`npm run build`) initial chunk (`dist/assets/index-*.js`) must remain $\le 310.0\text{ kB}$ (measured 307.87 kB, headroom $\ge 2.0\text{ kB}$).  
  *Evidence:* Production bundle size audit in `build` check script.

---

### 3.2 P1 SHOULD — Crop Framing, Wide Table Scroller, Pair Hover, Dark Backing

- **AC-P1-01 Wide Table Internal Scroller.**  
  When a table crop's natural width exceeds the column measure (680px), the table must be wrapped in an internal horizontally scrollable element (`overflow-x-auto touch-pan-x`) with styled slim scrollbars, allowing readers to pan wide multi-column tables at 100% scale without shrinking into illegibility.  
  *Evidence:* Component test rendering a wide table; asserting wrapper has `overflow-x-auto` while parent column remains unscrollable.

- **AC-P1-02 Gestalt Pair Subtle Hover Affordance.**  
  Hovering cursor over any paragraph pair should apply a subtle background tint (`bg-muted/40` or `bg-primary/[0.02]`) with rounded corners (`rounded-md transition-colors`) spanning both source and translation, reinforcing their semantic unity without visual clutter during regular reading.  
  *Evidence:* Vitest verifying `data-hovered` attribute or hover style class toggling on mouse enter/leave.

- **AC-P1-03 Dark Theme Vector Crop Protection.**  
  In dark theme (`.dark`), canvas crops must retain 100% radiometric fidelity (zero `filter: invert()`). If a crop has an opaque white background, it should be presented with a subtle border (`border border-border/50 rounded-md`) or soft inset padding to prevent harsh glare against dark surrounding surfaces.  
  *Evidence:* Vitest verifying absence of CSS invert filters on `<canvas>` elements in dark theme.

- **AC-P1-04 Unframed Formula Aesthetic.**  
  Display formulas must sit cleanly in the reading stream without card frames, background shadows, or bounding borders, preserving the clean look of traditional mathematical typesetting.  
  *Evidence:* Vitest asserting formula container has no `border`, `shadow`, or `bg-card` classes.

---

### 3.3 P2 OPTIONAL — Micro-Typographic Refinements

- **AC-P2-01 Typographic Ligatures and Kerning Activation.**  
  Enable advanced OpenType features on academic serif text (`font-feature-settings: "kern" 1, "liga" 1, "calt" 1; text-rendering: optimizeLegibility;`) where supported by the client OS.  
  *Evidence:* CSS inspection verifying presence of `font-feature-settings` on `.reflow-font-serif`.

- **AC-P2-02 Smooth Pinch-to-Zoom on Mobile/Tablet Crops.**  
  Allow touch pinch gestures directly on table and figure crops to temporarily expand them up to $2.0\times$ within their slot.  
  *Evidence:* Manual mobile touch verification.

---

## 4. Evidence & Verification Plan

| Criterion | Target Property | Verification Mechanism | Concrete File & Assertion |
|---|---|---|---|
| **AC-P0-01** | Latin Serif Stack | Vitest (JSDOM) | `frontend/src/tests/reflow-bilingual-reader.test.tsx`: assert `reflow-source` font contains `Charter` or `Georgia`. |
| **AC-P0-02** | CJK Sans Stack | Vitest (JSDOM) | `frontend/src/tests/reflow-bilingual-reader.test.tsx`: assert `reflow-translation` font contains `PingFang SC` or `Microsoft YaHei`. |
| **AC-P0-03** | No Left Accent | Vitest (JSDOM) | `frontend/src/tests/reflow-bilingual-reader.test.tsx`: assert `border-l` class absent from translation element. |
| **AC-P0-04** | Scale & Measure | Real Browser E2E | `frontend/scripts/e2e-reflow-bilingual.mjs`: assert `font >= 15.5`, `lineHeight >= 26.0`, `measure <= 680`. |
| **AC-P0-05** | Headings Scale | Vitest (JSDOM) | `frontend/src/tests/reflow-bilingual-reader.test.tsx`: assert `h1` size $\ge 21.5\text{px}$, `h2` $\ge 18.5\text{px}$, `h3` $\ge 16.5\text{px}$. |
| **AC-P0-06** | 3.5:1 Rhythm | Vitest (JSDOM) | `frontend/src/tests/reflow-bilingual-reader.test.tsx`: verify intra gap is 8px and inter gap is 28px. |
| **AC-P0-07** | Formula $1.28\times$ Boost | Vitest / Canvas Mock | `frontend/src/tests/reflow-bilingual-reader.test.tsx`: assert formula canvas CSS width $\approx W_{\text{natural}} \times 1.28$. |
| **AC-P0-08** | Formula Containment | Vitest (JSDOM) | `frontend/src/tests/reflow-bilingual-reader.test.tsx`: assert boosted wide formula width does not exceed column. |
| **AC-P0-09** | Centered Formula | Vitest (JSDOM) | `frontend/src/tests/reflow-bilingual-reader.test.tsx`: assert 3-slot grid layout with right-aligned caption. |
| **AC-P0-10** | No Horiz Scroll | Real Browser E2E | `frontend/scripts/e2e-reflow-bilingual.mjs`: assert `scrollWidth === clientWidth` at 768px and 1280px widths. |
| **AC-P0-11** | WCAG AA Contrast | Node Contrast Script | Automated test computing color contrast $\ge 4.5:1$ on light/dark themes. |
| **AC-P0-12** | Bundle Ceiling | Vite Build Audit | `npm run build`: assert `dist/assets/index-*.js` size $\le 310.0\text{ kB}$ (317,440 bytes). |

---

## 5. Transition & Superseding Declaration

1. **Relation to DS-DOC-008:**
   This document **DS-DOC-009** formally supersedes Section 2.4 and criteria **AC-P0-12**, **AC-P0-13**, and **AC-P0-14** of **DS-DOC-008**.
2. **Preserved Contracts from DS-DOC-008:**
   All other criteria in DS-DOC-008 — specifically **AC-P0-01 to AC-P0-11** (backend routes, cache tuple, bounded batching, semantic heading sourcing, conventional caption placement, furniture elimination) and **AC-P0-15 to AC-P0-24** (vector zoom, completeness invariant, bibliography notice, gap marking, clipboard purity, pre-generation disclosure, zero provider calls) — remain active, binding, and unamended.
3. **Execution Ready:**
   Upon formal review and freezing of this document, the main implementation agent is authorized to modify `frontend/src/bilingual/ReflowBilingualReader.tsx`, `frontend/src/bilingual/reflow/crops.tsx`, `frontend/src/index.css`, and associated test suites to satisfy all AC-P0 and AC-P1 criteria defined herein.

---

## 6. Round 1 review and freezing — 3 AC_CHANGE_REQUESTs

Read against the repository. **D1–D8 are accepted**, and three of them settle
questions the implementation would otherwise have answered by taste: **D2** (the
left stripe goes — 97 of them down one margin is noise, not emphasis), **D5**
(a formula centred in the column with its number at the right margin, which is
what a journal does), and **D7** (a wide table scrolls inside its own wrapper
rather than shrinking into illegibility or dragging the column sideways).

Three points are recorded as changes, each from a measurement.

### AC_CHANGE_REQUEST 1 — the magnification is one factor, not a 96/72 conversion times 1.28

**Old wording, AC-P0-07 / §2.4:** `W_natural = (x₁ − x₀) × 96/72 × S_view`, then
`× 1.28` — "verifying rendered canvas CSS width equals `round(220 × 1.333 × 1.28)
± 2px ≈ 375px`".

**New wording:** the same target — **a formula's glyphs end up at about the size
of the prose beside them** — expressed as one factor applied to what this
renderer actually draws: `W_target = (x₁ − x₀) × S_view × M`, with
`M = 1.707` where the IR does not state the formula's own type size, and
`M = prose_px / ink_pt` (clamped to `[1.0, 2.5]`) where it does, always capped by
AC-P0-08. For the reader's paper's 9.3 pt formulas at scale 1 that is 1.72, which
draws them at ≈ 15.9 px against 16 px prose — the outcome §2.4 asks for, by the
arithmetic this view actually uses. `1.333 × 1.28 = 1.7067`, so the *number* is
unchanged; what changes is that it is stated as one factor, and that it can
follow the ink.

**Reason.** This view has no 96/72 step, and that is measurable: the browser
harness printed the reader's paper's first crop at **238 px** wide for a 190 pt
formula at scale 1.25 — `190 × 1.25 = 237.5`, i.e. the natural size is
`box × S_view` and nothing else. Applying a literal `96/72` on top would draw
every crop 33 % larger than the document that specifies it. And a fixed factor
only lands on the prose size for 9.3 pt formulas: this library also holds papers
whose display formulas are set at **6.5 pt** and **10.0 pt** (measured), where the
same factor gives 10.4 px and 16 px — one too small to read, one already right.
Deriving it from the ink is what makes the criterion true for papers other than
the one it was written from.

### AC_CHANGE_REQUEST 2 — footnotes at 85 % opacity miss the criterion's own 4.5:1

**Old wording, §2.2:** table footnotes are `text-muted-foreground/85`, while
AC-P0-11 requires captions *and footnotes* to reach ≥ 4.5:1 in both themes.

**New wording:** footnotes use the `--muted-foreground` token at full strength.

**Reason.** Computed on the shipped tokens: `--muted-foreground` (220 9 % 42 %) on
`--background` is **5.61:1**, and at 85 % opacity it is **4.03:1** — below the bar
the same document sets two sections later. Measured, not estimated: the contrast
is arithmetic over the token values in `src/index.css`. For reference the other
values pass comfortably — source prose 16.88:1, the translation's
`foreground/80` 8.87:1, captions 5.61:1.

### AC_CHANGE_REQUEST 3 — there is no dark theme to protect

**Old wording, AC-P0-11:** contrast "in light and dark themes"; **AC-P1-03:**
"in dark theme (`.dark`), canvas crops must retain 100 % radiometric fidelity".

**New wording:** the contrast requirement applies to the theme the application
ships. The dark-theme clauses are **not applicable today** and are recorded as
such rather than implemented against a theme that cannot be reached.

**Reason.** Measured: `tailwind.config.js` sets `darkMode: ["class"]`, and
nothing in the application ever puts a `.dark` class on any element —
`src/index.css` defines one token set, and its only reference to a dark theme is
a comment saying that introducing one "later is a token swap, not a rewrite".
Every `dark:` utility in the codebase is therefore inert. Requiring a crop to be
protected from a dark background is requiring protection from a surface that does
not exist; the criteria for it would have to be satisfied against a theme no
reader can select, and a test that asserts a `.dark` rule it must first invent is
a test of the test. When a dark token set lands, this clause comes back with the
theme — and the `filter: invert()` prohibition is the right rule for it.

### Accepted and recorded without change

- **AC-P0-04's thresholds**: `font ≥ 15.5 px` against a specified 16 px, and
  `line-height ≥ 26.0 px` against 27.2 px, are the specifications with a rounding
  allowance, which is how they will be asserted.
- **AC-P1-01 (the wide-table scroller) is implemented in this tranche**, although
  the author filed it under SHOULD: AC-P0-10 forbids the reading column from
  scrolling sideways at any width, and at 768 px a 464 pt table crop cannot obey
  both without the wrapper. It is the mechanism that makes the P0 true, not an
  optional extra.
- **Recorded, and fixed here rather than later:** at the boosted scale a single
  page raster costs **29.6 MB** (612 × 792 pt at scale 1.25, `devicePixelRatio`
  2, boost ≈ 1.71 — arithmetic over the render parameters), and DS-DOC-008's
  raster cache never evicted: scrolling the reader's 14-page paper would hold
  **≈ 414 MB**. The cache is capped and evicts here; the browser harness scrolls
  the whole paper and back to prove the crops still paint afterwards.
