import { useEffect, useState } from "react";
import { Copy, Minus, Square, X } from "lucide-react";

import { desktopWindow } from "@/desktop/bridge";
import { cn } from "@/lib/utils";

/**
 * Minimise / maximise / close, drawn by the application.
 *
 * The packaged window is frameless (`desktop/electron/main.cjs`), so these are
 * the only way to close it with a mouse — they are not decoration. They are
 * styled from the same tokens as the rest of the top bar (glass, `--glass-strong`
 * on hover, the same 30px control height), because a native frame around a page
 * is exactly the "two different things stacked" look this replaces.
 *
 * In a browser `desktopWindow()` is undefined and this renders nothing: the tab
 * already has a title bar, and a second set of controls in it would be a lie.
 */
export function WindowControls() {
  const bridge = desktopWindow();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge.isMaximized().then((value) => {
      if (active) setMaximized(value);
    });
    const unsubscribe = bridge.onMaximizedChange(setMaximized);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [bridge]);

  if (!bridge) return null;

  const control =
    "app-no-drag grid h-[30px] w-[30px] shrink-0 place-items-center rounded-[10px] text-muted-foreground " +
    "transition-[background-color,color,transform,box-shadow] duration-150 ease-out " +
    "hover:bg-[var(--glass-strong)] hover:text-foreground " +
    "active:scale-[0.9] active:duration-75 " +
    "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-primary/30";

  return (
    <div
      className="app-no-drag ml-0.5 flex shrink-0 items-center gap-0.5 pl-1"
      data-testid="window-controls"
      role="group"
      aria-label="窗口控制"
    >
      <button
        type="button"
        className={control}
        aria-label="最小化"
        data-testid="window-minimize"
        onClick={() => bridge.minimize()}
      >
        <Minus className="h-4 w-4" />
      </button>

      <button
        type="button"
        className={control}
        aria-label={maximized ? "还原" : "最大化"}
        aria-pressed={maximized}
        data-testid="window-maximize"
        onClick={() => bridge.toggleMaximize()}
      >
        {maximized ? <Copy className="h-3.5 w-3.5 -scale-x-100" /> : <Square className="h-3.5 w-3.5" />}
      </button>

      <button
        type="button"
        className={cn(
          control,
          "hover:bg-destructive hover:text-destructive-foreground focus-visible:ring-destructive/40",
        )}
        data-testid="window-close"
        aria-label="关闭"
        onClick={() => bridge.close()}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
