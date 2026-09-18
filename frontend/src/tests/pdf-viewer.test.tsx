import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getDocument = vi.fn();

/**
 * PDF.js is mocked rather than run: the unit suite is about the viewer's own
 * logic — states, windowing, navigation, zoom, teardown — and a real PDF.js
 * render in jsdom proves nothing (there is no rasteriser). The real library is
 * exercised by the browser capture harness instead.
 */
vi.mock("@/pdf/pdfjs", () => {
  const STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0];
  // PDF.js loads lazily now; the mock mirrors that shape so the viewer's real
  // code path — await the module, then use it — is what runs here.
  const module = {
    getDocument: (...args: unknown[]) => getDocument(...args),
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
    ZOOM_STEPS: STEPS,
    MIN_ZOOM: STEPS[0],
    MAX_ZOOM: STEPS[STEPS.length - 1],
    FIT_WIDTH_PADDING_PX: 32,
    RENDER_BUFFER_MARGIN_PX: 300,
    clampZoom: (s: number) => Math.min(3, Math.max(0.5, s)),
    zoomIn: (s: number) => STEPS.find((x) => x > s + 1e-6) ?? 3,
    zoomOut: (s: number) => [...STEPS].reverse().find((x) => x < s - 1e-6) ?? 0.5,
  };
});

import { PdfWorkspace } from "@/pdf/PdfWorkspace";

function fakeDocument(pageCount = 3) {
  return {
    numPages: pageCount,
    getPage: vi.fn(async () => ({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
        // Source bounding boxes are only drawn on an unrotated page, so the
        // mock reports what a real unrotated viewport reports.
        rotation: 0,
      }),
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
      streamTextContent: () => ({}),
    })),
  };
}

function fakeTask(pageCount = 3, destroy = vi.fn(async () => undefined)) {
  return { promise: Promise.resolve(fakeDocument(pageCount)), destroy };
}

let lastTask: ReturnType<typeof fakeTask>;

beforeEach(() => {
  getDocument.mockReset();
  lastTask = fakeTask();
  getDocument.mockReturnValue(lastTask);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Feed a file to the viewer.
 *
 * `fireEvent.change` rather than `user.upload`: the input is `display: none`
 * (the visible affordance is a styled button), and user-event declines to
 * interact with invisible elements.
 */
function openPdf(name = "paper.pdf") {
  const input = screen.getByTestId("pdf-file-input");
  const file = new File([new Uint8Array([1, 2, 3])], name, {
    type: "application/pdf",
  });
  fireEvent.change(input, { target: { files: [file] } });
  return file;
}

/** A loading task that rejects. The extra catch marks the rejection observed, so
 *  Node does not report it as unhandled before the viewer awaits it — the viewer
 *  still receives the rejection and must handle it. */
function rejectingTask(error: Error) {
  const promise = Promise.reject(error);
  promise.catch(() => undefined);
  return { promise, destroy: vi.fn(async () => undefined) };
}

// --- AC-026 / AC-027: empty and loading states -------------------------------


describe("DS-FE-002 · empty and loading states", () => {
  it("shows an empty state before any document is opened (AC-026)", () => {
    render(<PdfWorkspace />);

    expect(screen.getByTestId("pdf-empty-state")).toBeInTheDocument();
    expect(screen.getByTestId("open-pdf-button")).toBeInTheDocument();
    expect(screen.queryByTestId("pdf-viewer")).not.toBeInTheDocument();
  });

  it("shows a loading indicator while the document opens (AC-027)", async () => {
    let release: (value: unknown) => void = () => undefined;
    getDocument.mockReturnValue({
      promise: new Promise((resolve) => {
        release = resolve;
      }),
      destroy: vi.fn(async () => undefined),
    });

    render(<PdfWorkspace />);
    openPdf();

    expect(await screen.findByTestId("pdf-loading-spinner")).toBeInTheDocument();
    release(fakeDocument());
    await waitFor(() =>
      expect(screen.queryByTestId("pdf-loading-spinner")).not.toBeInTheDocument(),
    );
  });
});

// --- AC-007 / AC-011: rendering ----------------------------------------------


describe("DS-FE-002 · rendering", () => {
  it("renders one container per page once loaded (AC-007)", async () => {
    render(<PdfWorkspace />);
    openPdf();

    await waitFor(() => expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument());

    const viewer = screen.getByTestId("pdf-viewer");
    expect(within(viewer).getAllByTestId("pdf-page-container")).toHaveLength(3);
    // Page count is reported in the toolbar.
    expect(screen.getByText("/ 3")).toBeInTheDocument();
  });

  it("keeps the window from scrolling; the viewer scrolls instead (AC-011)", async () => {
    render(<PdfWorkspace />);
    openPdf();
    await waitFor(() => expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument());

    expect(screen.getByTestId("pdf-viewer")).toHaveClass("overflow-auto");
  });

  it("reserves page geometry before rendering, so scroll height is stable (AC-015)", async () => {
    render(<PdfWorkspace />);
    openPdf();
    await waitFor(() => expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument());

    const containers = within(screen.getByTestId("pdf-viewer")).getAllByTestId(
      "pdf-page-container",
    );
    for (const [index, container] of containers.entries()) {
      expect(container).toHaveAttribute("data-page-number", String(index + 1));
      // Fit-width from an 800px pane with 32px padding → 768/600 = 1.28.
      expect(container).toHaveStyle({ width: `${600 * 1.28}px` });
    }
  });
});

// --- AC-013 / AC-014 / AC-012: navigation ------------------------------------


describe("DS-FE-002 · navigation", () => {
  it("jumps to a typed page number (AC-013)", async () => {
    const user = userEvent.setup();
    render(<PdfWorkspace />);
    openPdf();
    await waitFor(() => expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument());

    const input = screen.getByTestId("page-number-input");
    await user.clear(input);
    await user.type(input, "3{Enter}");

    await waitFor(() => expect(input).toHaveValue("3"));
  });

  it("clamps an out-of-range page number (AC-013)", async () => {
    const user = userEvent.setup();
    render(<PdfWorkspace />);
    openPdf();
    await waitFor(() => expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument());

    const input = screen.getByTestId("page-number-input");
    await user.clear(input);
    await user.type(input, "99{Enter}");

    await waitFor(() => expect(input).toHaveValue("3"));
  });

  it("steps with the previous/next buttons (AC-014)", async () => {
    const user = userEvent.setup();
    render(<PdfWorkspace />);
    openPdf();
    await waitFor(() => expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument());

    const input = screen.getByTestId("page-number-input");
    expect(input).toHaveValue("1");
    expect(screen.getByRole("button", { name: "上一页" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(input).toHaveValue("2"));
  });
});

// --- AC-017 / AC-018: zoom ---------------------------------------------------


describe("DS-FE-002 · zoom", () => {
  it("starts at fit-width and reports the derived percentage (AC-018)", async () => {
    render(<PdfWorkspace />);
    openPdf();
    await waitFor(() => expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument());

    expect(screen.getByTestId("fit-width-btn")).toHaveAttribute("aria-pressed", "true");
    // 768 / 600 = 128%
    expect(screen.getByText("128%")).toBeInTheDocument();
  });

  it("zooms in and out along discrete steps (AC-017)", async () => {
    const user = userEvent.setup();
    render(<PdfWorkspace />);
    openPdf();
    await waitFor(() => expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "放大" }));
    // 1.28 → the next step above is 1.5 → 150%
    await waitFor(() => expect(screen.getByText("150%")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "缩小" }));
    // 1.5 → 1.25 → 125%
    await waitFor(() => expect(screen.getByText("125%")).toBeInTheDocument());
  });

  it("preserves the reading position across zoom (AC-019)", async () => {
    const user = userEvent.setup();
    render(<PdfWorkspace />);
    openPdf();
    await waitFor(() => expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument());

    const viewer = screen.getByTestId("pdf-viewer") as HTMLElement;
    // jsdom has no layout, so scrollTop is settable but not derived — set it
    // explicitly and assert the viewer scales it rather than resetting it.
    viewer.scrollTop = 400;

    await user.click(screen.getByRole("button", { name: "放大" })); // 1.28 → 1.5

    await waitFor(() => expect(screen.getByText("150%")).toBeInTheDocument());
    // 400 * (1.5 / 1.28) ≈ 468, not 0.
    expect(viewer.scrollTop).toBeGreaterThan(400);
  });

  it("toggles back to fit-width (AC-018)", async () => {
    const user = userEvent.setup();
    render(<PdfWorkspace />);
    openPdf();
    await waitFor(() => expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "放大" }));
    await waitFor(() => expect(screen.getByText("150%")).toBeInTheDocument());

    await user.click(screen.getByTestId("fit-width-btn"));
    await waitFor(() => expect(screen.getByText("128%")).toBeInTheDocument());
  });
});

// --- AC-028 / AC-029: failure states -----------------------------------------


describe("DS-FE-002 · failure states", () => {
  it("reports a corrupt document without crashing (AC-028)", async () => {
    const error = Object.assign(new Error("bad pdf"), { name: "InvalidPDFException" });
    getDocument.mockReturnValue(rejectingTask(error));

    render(<PdfWorkspace />);
    openPdf("broken.pdf");

    const state = await screen.findByTestId("pdf-error-state");
    expect(state).toHaveTextContent("broken.pdf");
    // The shell is untouched: the rest of the workspace still renders.
    expect(screen.getByTestId("pdf-file-input")).toBeInTheDocument();
  });

  it("reports an encrypted document distinctly (AC-029)", async () => {
    const error = Object.assign(new Error("needs password"), { name: "PasswordException" });
    getDocument.mockReturnValue(rejectingTask(error));

    render(<PdfWorkspace />);
    openPdf("secret.pdf");

    expect(await screen.findByTestId("pdf-password-error")).toBeInTheDocument();
  });

  it("rejects a non-PDF file without calling PDF.js (AC-003)", async () => {
    render(<PdfWorkspace />);
    openPdf("notes.txt");

    expect(await screen.findByTestId("pdf-error-state")).toBeInTheDocument();
    expect(getDocument).not.toHaveBeenCalled();
  });

  it("recovers: a valid file opens after an error (AC-030)", async () => {
    getDocument.mockReturnValueOnce(
      rejectingTask(Object.assign(new Error("bad"), { name: "InvalidPDFException" })),
    );

    render(<PdfWorkspace />);
    openPdf("broken.pdf");
    await screen.findByTestId("pdf-error-state");

    const task = fakeTask();
    getDocument.mockReturnValue(task);
    openPdf("good.pdf");

    await waitFor(() => expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument());
    expect(screen.queryByTestId("pdf-error-state")).not.toBeInTheDocument();
  });
});

// --- AC-031 / AC-033: lifecycle ----------------------------------------------


describe("DS-FE-002 · lifecycle", () => {
  it("releases the previous document when a new one is opened (AC-031)", async () => {
    render(<PdfWorkspace />);
    openPdf("first.pdf");
    await waitFor(() => expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument());

    const second = fakeTask();
    getDocument.mockReturnValue(second);
    openPdf("second.pdf");
    await waitFor(() => expect(getDocument).toHaveBeenCalledTimes(2));

    // The first document's task was destroyed, so its worker copy is freed.
    expect(lastTask.destroy).toHaveBeenCalled();
  });

  it("releases the document on unmount (AC-031)", async () => {
    const { unmount } = render(<PdfWorkspace />);
    openPdf();
    await waitFor(() => expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument());

    const task = getDocument.mock.results[0]?.value;
    unmount();

    expect(task.destroy).toHaveBeenCalled();
  });

  it("resets to page 1 and fit-width when the document changes (AC-031)", async () => {
    const user = userEvent.setup();
    render(<PdfWorkspace />);
    openPdf("first.pdf");
    await waitFor(() => expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "下一页" }));
    await user.click(screen.getByRole("button", { name: "放大" }));
    await waitFor(() => expect(screen.getByText("150%")).toBeInTheDocument());

    getDocument.mockReturnValue(fakeTask(5));
    openPdf("second.pdf");

    await waitFor(() => expect(screen.getByText("/ 5")).toBeInTheDocument());
    expect(screen.getByTestId("page-number-input")).toHaveValue("1");
    expect(screen.getByText("128%")).toBeInTheDocument();
  });
});

// --- AC-004 / R8: local-first and reusability --------------------------------


describe("DS-FE-002 · local-first and reusability", () => {
  it("makes no network request to open a document (AC-004)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    render(<PdfWorkspace />);
    openPdf();
    await waitFor(() => expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument());

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("supports two independent instances (R8, the bilingual requirement)", async () => {
    render(
      <>
        <PdfWorkspace testId="viewer-original" label="Original" />
        <PdfWorkspace testId="viewer-translated" label="Translated" />
      </>,
    );

    const originals = screen.getAllByTestId("pdf-file-input");
    expect(originals).toHaveLength(2);

    const user = userEvent.setup();
    await user.upload(
      originals[0]!,
      new File([new Uint8Array([1])], "a.pdf", { type: "application/pdf" }),
    );

    // Only the first instance loads a document; the second stays empty.
    await waitFor(() =>
      expect(within(screen.getByTestId("viewer-original")).getByTestId("pdf-viewer")).toBeInTheDocument(),
    );
    expect(
      within(screen.getByTestId("viewer-translated")).getByTestId("pdf-empty-state"),
    ).toBeInTheDocument();
  });
});
