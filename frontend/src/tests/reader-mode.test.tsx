import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "@/app/App";
import { seedTranslatedDocument } from "@/tests/fixtures";

/**
 * PDF.js is stubbed: these tests are about which panes exist in the DOM, not
 * about rasterising pages.
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

const original = () => screen.queryByTestId("viewer-original");
const translated = () => screen.queryByTestId("viewer-translated");

/**
 * AC-32 — reader mode switching must restructure the workspace DOM,
 * not merely relabel it (failure F-04).
 *
 * DS-FE-001 ran these against placeholder panels, so all three modes were freely
 * switchable. The panels are real now and the translated ones require a
 * translation to exist, so the precondition is established first. The assertions
 * about DOM restructuring — which is what AC-32 actually requires — are
 * unchanged.
 */
describe("DS-FE-003 · AC-32 reader mode switching", () => {
  /**
   * DS-FE-001 asserted bilingual-by-default with both panels present. That was
   * only coherent while the panels were placeholders: with nothing translated,
   * a 译文 pane has nothing to show. AC-P0-09 governs now.
   */
  it("offers only 原文 before any translation exists (AC-P0-09)", () => {
    render(<App />);

    expect(original()).toBeInTheDocument();
    expect(translated()).not.toBeInTheDocument();
    expect(screen.getByTestId("reader-workspace")).toHaveAttribute(
      "data-reader-mode",
      "original",
    );
    expect(screen.getByTestId("reader-mode-bilingual")).toBeDisabled();
    expect(screen.getByTestId("reader-mode-translation")).toBeDisabled();
    expect(screen.getByTestId("reader-mode-original")).toBeEnabled();
  });

  it("unlocks both translated modes once a translation exists (AC-P0-09)", () => {
    seedTranslatedDocument();
    render(<App />);

    expect(screen.getByTestId("reader-mode-bilingual")).toBeEnabled();
    expect(screen.getByTestId("reader-mode-translation")).toBeEnabled();
  });

  it("renders both panels in 双语 mode (AC-P0-10)", async () => {
    const user = userEvent.setup();
    seedTranslatedDocument();
    render(<App />);

    await user.click(screen.getByTestId("reader-mode-bilingual"));

    expect(original()).toBeInTheDocument();
    expect(translated()).toBeInTheDocument();
    expect(screen.getByTestId("reader-workspace")).toHaveAttribute(
      "data-reader-mode",
      "bilingual",
    );
  });

  it("renders only the original panel in 原文 mode (AC-P0-10)", async () => {
    const user = userEvent.setup();
    seedTranslatedDocument();
    render(<App />);

    await user.click(screen.getByTestId("reader-mode-bilingual"));
    await user.click(screen.getByTestId("reader-mode-original"));

    expect(original()).toBeInTheDocument();
    expect(translated()).not.toBeInTheDocument();
    expect(screen.getByTestId("reader-workspace")).toHaveAttribute(
      "data-reader-mode",
      "original",
    );
  });

  it("renders only the translated panel in 译文 mode (AC-P0-10)", async () => {
    const user = userEvent.setup();
    seedTranslatedDocument();
    render(<App />);

    await user.click(screen.getByTestId("reader-mode-translation"));

    expect(translated()).toBeInTheDocument();
    expect(original()).not.toBeInTheDocument();
    expect(screen.getByTestId("reader-workspace")).toHaveAttribute(
      "data-reader-mode",
      "translation",
    );
  });

  it("restores both panels when switching back to 双语", async () => {
    const user = userEvent.setup();
    seedTranslatedDocument();
    render(<App />);

    await user.click(screen.getByTestId("reader-mode-translation"));
    expect(original()).not.toBeInTheDocument();

    await user.click(screen.getByTestId("reader-mode-bilingual"));
    expect(original()).toBeInTheDocument();
    expect(translated()).toBeInTheDocument();
  });

  it("marks exactly one mode as selected at a time (AC-30)", async () => {
    const user = userEvent.setup();
    seedTranslatedDocument();
    render(<App />);

    await user.click(screen.getByTestId("reader-mode-translation"));

    const selected = screen
      .getAllByRole("tab")
      .filter((tab) => tab.getAttribute("aria-selected") === "true");

    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent("译文");
  });

  it("survives rapid toggling without losing state integrity (AC-14)", async () => {
    const user = userEvent.setup();
    seedTranslatedDocument();
    render(<App />);

    const sequence = [
      "reader-mode-original",
      "reader-mode-translation",
      "reader-mode-bilingual",
      "reader-mode-original",
      "reader-mode-bilingual",
    ] as const;

    for (const id of sequence) {
      await user.click(screen.getByTestId(id));
    }

    // Ends on bilingual → both panels, exactly one each (no orphans).
    expect(screen.getAllByTestId("viewer-original")).toHaveLength(1);
    expect(screen.getAllByTestId("viewer-translated")).toHaveLength(1);
  });
});
