import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { App } from "@/app/App";
import { useWorkspaceStore } from "@/stores/workspace";

/**
 * AC-34 — the shell renders all four regions with no backend mock of any kind.
 * AC-09 / AC-17 — startup must not produce an unhandled rejection or console error.
 */
describe("DS-FE-001 · AC-34 application shell, standalone", () => {
  it("renders the four semantic regions with no backend present", () => {
    render(<App />);

    // header / aside / main / footer (AC-02)
    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.getByRole("complementary")).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("contentinfo")).toBeInTheDocument();
  });

  it("renders every top-bar control required by AC-03", () => {
    render(<App />);

    const header = screen.getByRole("banner");
    expect(header).toHaveTextContent("Academic PDF Copilot"); // product mark
    expect(screen.getByTestId("document-name")).toHaveTextContent("paper.pdf");
    expect(screen.getByRole("tablist", { name: "阅读模式" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /AI翻译/ })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "搜索论文" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
  });

  it("renders the status bar contents required by AC-08", () => {
    render(<App />);

    const footer = screen.getByRole("contentinfo");
    expect(screen.getByTestId("status-label")).toBeInTheDocument();
    expect(screen.getByTestId("status-page")).toHaveTextContent(/Page \d+ \/ \d+/);
    expect(screen.getByTestId("status-percent")).toHaveTextContent("72%");
    expect(screen.getByRole("progressbar", { name: "翻译进度" })).toBeInTheDocument();
    expect(screen.getByTestId("engine-status")).toHaveTextContent(/Engine:/);

    // AC-08: footer height sits between 28px and 36px.
    expect(footer).toHaveClass("h-7"); // 1.75rem = 28px
  });

  it("issues no network request on mount (AC-09)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    render(<App />);
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("does not crash or show a fallback when the backend is absent (AC-09)", () => {
    render(<App />);

    // The error boundary fallback must not be showing.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("界面出现错误")).not.toBeInTheDocument();
  });

  it("truncates an over-long document name without losing the controls (AC-15)", () => {
    const longName =
      "2403.12345v2_Deep_Residual_Learning_for_Multimodal_Robotics_Paper_Final.pdf";
    useWorkspaceStore.setState({ documentName: longName });

    render(<App />);

    const name = screen.getByTestId("document-name");
    // Truncation classes keep the row from growing, and the full value stays
    // available on hover rather than being lost.
    expect(name).toHaveClass("truncate");
    expect(name).toHaveAttribute("title", longName);
    expect(name).toHaveTextContent(longName);

    // Controls that must never be pushed off-screen.
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "阅读模式" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /AI翻译/ })).toBeInTheDocument();
  });
});
