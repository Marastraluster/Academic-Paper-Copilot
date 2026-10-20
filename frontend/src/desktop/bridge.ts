/**
 * The desktop shell's window controls.
 *
 * The packaged window is frameless, so minimise / maximise / close are the
 * application's own buttons rather than the operating system's. This module is
 * the only place that knows the bridge exists; every component asks
 * `desktopWindow()` and gets `undefined` in a browser, which is how the same
 * build keeps working in a tab.
 *
 * The surface is deliberately tiny (three verbs and one state), and it is
 * declared here rather than imported from the shell: the renderer must not gain
 * a dependency on Electron just to draw a button.
 */

export interface DesktopWindowBridge {
  readonly platform: string;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  isMaximized(): Promise<boolean>;
  /** Returns an unsubscribe function; call it from the effect's cleanup. */
  onMaximizedChange(listener: (maximized: boolean) => void): () => void;
}

declare global {
  interface Window {
    appWindow?: DesktopWindowBridge;
  }
}

/** The bridge, when this page is running inside the desktop shell. */
export function desktopWindow(): DesktopWindowBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = window.appWindow;
  // A browser could in principle define this name; the shell is identified by
  // the shape it must have, not by the name alone.
  return bridge && typeof bridge.minimize === "function" ? bridge : undefined;
}

/** True inside the desktop shell. Used to hide browser-only affordances. */
export function isDesktop(): boolean {
  return desktopWindow() !== undefined;
}
