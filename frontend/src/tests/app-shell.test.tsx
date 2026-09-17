import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { App } from "@/app/App";
import { seedDocument } from "@/tests/fixtures";

/**
 * The shell test is about chrome, not rendering, so PDF.js is stubbed. Without
 * this, seeding a document would pull the real 483 kB library into jsdom, where
 * there is no rasteriser to render with anyway.
 */
vi.mock("@/pdf/pdfjs", () => {
  const document = {
    numPages: 3,
    getPage: async () => ({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
      streamTextContent: () => ({}),
    }),
  };
  const module = {
    getDocument: () => ({ promise: Promise.resolve(document), destroy: async () => {} }),
    TextLayer: class {
      render() {
        return Promise.resolve();
      }
      cancel() {}
    },
    setLayerDimensions: () => {},
    GlobalWorkerOptions: {},
  };
  return {
    loadPdfjs: () => Promise.resolve(module),
    ZOOM_STEPS: [0.5, 0.75, 1, 1.25, 1.5, 2, 3],
    MIN_ZOOM: 0.5,
    MAX_ZOOM: 3,
    FIT_WIDTH_PADDING_PX: 32,
    RENDER_BUFFER_MARGIN_PX: 300,
    clampZoom: (s: number) => Math.min(3, Math.max(0.5, s)),
    zoomIn: (s: number) => s + 0.25,
    zoomOut: (s: number) => s - 0.25,
  };
});

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
    // DS-FE-001 named a placeholder here ("paper.pdf"). Nothing is open now, so
    // the control says so instead of naming a file that does not exist.
    expect(screen.getByTestId("document-name")).toHaveTextContent("未打开文档");
    expect(screen.getByRole("tablist", { name: "阅读模式" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /AI翻译/ })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "搜索论文" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
  });

  it("renders the status bar contents required by AC-08", () => {
    render(<App />);

    const footer = screen.getByRole("contentinfo");
    expect(screen.getByTestId("status-label")).toBeInTheDocument();
    expect(screen.getByTestId("engine-status")).toHaveTextContent(/Engine:/);

    // AC-08: footer height sits between 28px and 36px.
    expect(footer).toHaveClass("h-7"); // 1.75rem = 28px
  });

  /**
   * DS-FE-003 AC-P0-07. DS-FE-001 asserted a fabricated "Page 5 / 18" and
   * "72%" here. No translation has run, so the bar must report nothing rather
   * than a number it did not measure.
   */
  it("reports no progress figures while nothing is being translated (AC-P0-07)", () => {
    render(<App />);

    expect(screen.getByTestId("status-label")).toHaveTextContent("未打开文档");
    expect(screen.getByTestId("status-page")).toHaveTextContent("Page — / —");
    expect(screen.queryByTestId("status-percent")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("progressbar", { name: "翻译进度" }),
    ).not.toBeInTheDocument();
    // The DS-FE-001 "example data" badge is gone along with the fake data.
    expect(screen.queryByText("示例")).not.toBeInTheDocument();
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
    seedDocument({ name: longName });

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
