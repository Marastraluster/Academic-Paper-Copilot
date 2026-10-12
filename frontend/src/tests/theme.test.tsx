/**
 * Light, dark, or the system's choice — and both themes legible.
 *
 * The contrast half reads the tokens out of `index.css` itself, so a value
 * changed there is checked here without anyone remembering to copy it.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppearanceSection } from "@/settings/AppearanceSection";
import { applyTheme, initTheme, readTheme, resolvesDark, setTheme, THEME_STORAGE_KEY } from "@/settings/theme";

function systemPrefers(dark: boolean) {
  const listeners: Array<() => void> = [];
  const query = {
    matches: dark,
    addEventListener: (_: string, listener: () => void) => listeners.push(listener),
    removeEventListener: () => undefined,
  };
  vi.stubGlobal("matchMedia", vi.fn(() => query));
  return {
    flip(next: boolean) {
      query.matches = next;
      listeners.forEach((listener) => listener());
    },
  };
}

describe("choosing a theme", () => {
  beforeEach(() => {
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    document.documentElement.classList.remove("dark");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("follows the system until the reader chooses, and follows it live", () => {
    const system = systemPrefers(false);
    expect(readTheme()).toBe("system");
    initTheme();
    expect(document.documentElement).not.toHaveClass("dark");

    system.flip(true);
    expect(document.documentElement).toHaveClass("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("keeps an explicit choice against the system, and across a reload", () => {
    const system = systemPrefers(true);
    setTheme("light");
    expect(document.documentElement).not.toHaveClass("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    // A reload reads it back; the system changing its mind does not move it.
    expect(readTheme()).toBe("light");
    system.flip(false);
    system.flip(true);
    expect(document.documentElement).not.toHaveClass("dark");

    setTheme("system");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement).toHaveClass("dark");
  });

  it("treats a damaged stored value as no choice", () => {
    systemPrefers(false);
    window.localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    expect(readTheme()).toBe("system");
    expect(resolvesDark("system")).toBe(false);
    applyTheme("dark");
    expect(document.documentElement).toHaveClass("dark");
  });

  it("switches from the settings, as a radio group", async () => {
    systemPrefers(false);
    const user = userEvent.setup();
    render(<AppearanceSection />);
    expect(screen.getByTestId("theme-system")).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByTestId("theme-dark"));
    expect(screen.getByTestId("theme-dark")).toHaveAttribute("aria-checked", "true");
    expect(document.documentElement).toHaveClass("dark");

    await user.click(screen.getByTestId("theme-light"));
    expect(document.documentElement).not.toHaveClass("dark");
  });
});

// --- contrast, from the shipped tokens -------------------------------------------

type Rgb = [number, number, number];

const css = readFileSync(resolve(__dirname, "../index.css"), "utf-8");

function block(selector: ":root" | ".dark"): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf("\n  }", start));
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[match[1]!] = match[2]!.trim();
  return out;
}

function hsl(value: string): Rgb {
  const [h, s, l] = value.split(/\s+/).map((part) => Number.parseFloat(part)) as [number, number, number];
  const saturation = s / 100;
  const lightness = l / 100;
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = lightness - c / 2;
  const table: Rgb[] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]];
  const [r, g, b] = table[Math.floor(h / 60) % 6]!;
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

function rgba(value: string): { rgb: Rgb; alpha: number } {
  const parts = value.match(/[\d.]+/g)!.map(Number);
  return { rgb: [parts[0]!, parts[1]!, parts[2]!], alpha: parts[3] ?? 1 };
}

const hex = (value: string): Rgb =>
  [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16)) as Rgb;

const over = (top: { rgb: Rgb; alpha: number }, bottom: Rgb): Rgb =>
  top.rgb.map((channel, i) => channel * top.alpha + bottom[i]! * (1 - top.alpha)) as Rgb;

function contrast(a: Rgb, b: Rgb): number {
  const luminance = (rgb: Rgb) => {
    const [r, g, b2] = rgb.map((value) => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    }) as Rgb;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe.each([":root", ".dark"] as const)("legibility of the %s theme", (selector) => {
  const light = block(":root");
  // The dark block overrides; anything it does not name keeps the light value.
  const token = selector === ":root" ? light : { ...light, ...block(".dark") };
  const field = hex(token.field!);
  // Text sits on: the page background, a card, the reflowed sheet, and glass
  // panels over the light field — and, at worst, over an orb drifting behind.
  const surfaces: Record<string, Rgb> = {
    background: hsl(token.background!),
    card: hsl(token.card!),
    sheet: hsl(token["page-surface"]!),
    glass: over(rgba(token.glass!), field),
    "glass-strong": over(rgba(token["glass-strong"]!), field),
    "glass-solid": over(rgba(token["glass-solid"]!), field),
    "glass over the brightest orb": over(
      rgba(token.glass!),
      over({ rgb: hex(token["orb-1"]!), alpha: Number(token["orb-opacity"]) }, field),
    ),
  };

  it.each(Object.keys(surfaces))("keeps body, secondary and status text at AA on %s", (name) => {
    const surface = surfaces[name]!;
    expect(contrast(hsl(token.foreground!), surface)).toBeGreaterThanOrEqual(7);
    expect(contrast(hsl(token["muted-foreground"]!), surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hsl(token["warning-text"]!), surface)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(hsl(token["success-text"]!), surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("keeps the accent readable as text and under its own label", () => {
    for (const name of ["background", "card", "sheet", "glass-strong"]) {
      expect(contrast(hsl(token.primary!), surfaces[name]!)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(hsl(token["primary-foreground"]!), hsl(token.primary!))).toBeGreaterThanOrEqual(4.5);
  });
});
