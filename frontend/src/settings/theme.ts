/**
 * Light, dark, or whatever the system is.
 *
 * Every colour in the shell resolves through a token in `index.css`, so a theme
 * is one class on `<html>` and a second set of token values — nothing in the
 * component tree knows which one is on. The choice is this browser's, kept in
 * `localStorage`; "system" follows `prefers-color-scheme` live, so a machine
 * that goes dark at sunset takes the reader's papers with it.
 *
 * The paper itself is not themed: a PDF page is drawn as the paper printed it,
 * white, in either theme.
 */
export type ThemeChoice = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "copilot:theme_v1";

export const THEME_CHOICES: ReadonlyArray<{ value: ThemeChoice; label: string }> = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function readTheme(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function systemIsDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

/** Whether a choice means dark right now. */
export function resolvesDark(choice: ThemeChoice): boolean {
  return choice === "dark" || (choice === "system" && systemIsDark());
}

/** Put the choice on the document. Idempotent. */
export function applyTheme(choice: ThemeChoice): void {
  const dark = resolvesDark(choice);
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  // Native controls, scrollbars and form autofill follow this, not our tokens.
  root.style.colorScheme = dark ? "dark" : "light";
}

export function setTheme(choice: ThemeChoice): void {
  try {
    if (choice === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // No storage: the choice lasts for this window.
  }
  applyTheme(choice);
}

let watching = false;

/**
 * Apply the stored choice and keep "system" in step with the system.
 *
 * Called once, before the first render, so the page never paints light and then
 * turns dark.
 */
export function initTheme(): void {
  applyTheme(readTheme());
  if (watching || typeof window.matchMedia !== "function") return;
  watching = true;
  window.matchMedia(DARK_QUERY).addEventListener?.("change", () => {
    if (readTheme() === "system") applyTheme("system");
  });
}
