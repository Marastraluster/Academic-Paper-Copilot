import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WindowControls } from "@/app/WindowControls";
import type { DesktopWindowBridge } from "@/desktop/bridge";

/**
 * The shell's title-bar buttons.
 *
 * These tests exist because the packaged window is frameless: if these buttons
 * do not render, or render without a listener, the window cannot be closed with
 * a mouse at all. Two states matter — inside the shell (a bridge exists) and in
 * a browser tab (none does, so nothing may be drawn).
 */

function installBridge(overrides: Partial<DesktopWindowBridge> = {}): {
  bridge: DesktopWindowBridge;
  unsubscribe: ReturnType<typeof vi.fn>;
} {
  const unsubscribe = vi.fn();
  const bridge: DesktopWindowBridge = {
    platform: "win32",
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    onMaximizedChange: vi.fn().mockReturnValue(unsubscribe),
    ...overrides,
  };
  window.appWindow = bridge;
  return { bridge, unsubscribe };
}

afterEach(() => {
  delete window.appWindow;
  vi.restoreAllMocks();
});

describe("desktop shell · window controls", () => {
  it("renders nothing in a browser tab, where the frame already has a title bar", () => {
    render(<WindowControls />);
    expect(screen.queryByTestId("window-controls")).not.toBeInTheDocument();
  });

  it("exposes the three controls with names a screen reader can use", () => {
    installBridge();
    render(<WindowControls />);

    expect(screen.getByTestId("window-controls")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "最小化" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "最大化" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭" })).toBeInTheDocument();
  });

  it("sends each press to the shell", async () => {
    const user = userEvent.setup();
    const { bridge } = installBridge();
    render(<WindowControls />);

    await user.click(screen.getByTestId("window-minimize"));
    await user.click(screen.getByTestId("window-maximize"));
    await user.click(screen.getByTestId("window-close"));

    expect(bridge.minimize).toHaveBeenCalledTimes(1);
    expect(bridge.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(bridge.close).toHaveBeenCalledTimes(1);
  });

  it("asks for the current state on mount and unsubscribes on unmount", async () => {
    const { bridge, unsubscribe } = installBridge();
    const { unmount } = render(<WindowControls />);

    expect(bridge.isMaximized).toHaveBeenCalledTimes(1);
    expect(bridge.onMaximizedChange).toHaveBeenCalledTimes(1);

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("shows Restore instead of Maximise when the window is already maximised", async () => {
    let notify: ((maximized: boolean) => void) | undefined;
    installBridge({
      isMaximized: vi.fn().mockResolvedValue(true),
      onMaximizedChange: vi.fn((listener) => {
        notify = listener;
        return () => {};
      }),
    });

    render(<WindowControls />);

    // Initial state arrives asynchronously (the bridge is a promise).
    expect(await screen.findByRole("button", { name: "还原" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // A shell-side maximise event flips it back without a re-mount.
    notify?.(false);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "最大化" })).toHaveAttribute(
        "aria-pressed",
        "false",
      ),
    );
  });
});
