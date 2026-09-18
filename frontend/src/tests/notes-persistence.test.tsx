import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/pdf/pdfjs", () => {
  const STEPS = [0.5, 1.0, 2.0];
  const page = (rotation: number) => ({
    getViewport: () => ({ width: 595, height: 842, rotation }),
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
  });
  return {
    loadPdfjs: () =>
      Promise.resolve({
        getDocument: () => ({
          // `destroy` is what the workspace calls on teardown; without it the
          // pane throws mid-mount and never reaches "ready".
          destroy: () => Promise.resolve(),
          promise: Promise.resolve({
            numPages: 2,
            destroy: () => Promise.resolve(),
            getPage: () => Promise.resolve(page(Number(globalThis.__rotation ?? 0))),
          }),
        }),
        TextLayer: class {
          render() {
            return Promise.resolve();
          }
          cancel() {}
        },
        setLayerDimensions: () => {},
        GlobalWorkerOptions: {},
      }),
    ZOOM_STEPS: STEPS, MIN_ZOOM: 0.5, MAX_ZOOM: 2,
    FIT_WIDTH_PADDING_PX: 32, RENDER_BUFFER_MARGIN_PX: 300,
    clampZoom: (s: number) => s, zoomIn: (s: number) => s, zoomOut: (s: number) => s,
  };
});

import type { AnnotationView } from "@/api/annotations";
import { App } from "@/app/App";
import { useWorkspaceStore } from "@/stores/workspace";
import { seedDocument, seedQaProvider, seedQaSections } from "@/tests/fixtures";

declare global {
  // eslint-disable-next-line no-var
  var __rotation: number | undefined;
}

const RECT: [number, number, number, number] = [50, 100, 300, 140];

function annotation(comment: string | null = null): AnnotationView {
  return {
    id: "ann_1", kind: comment ? "note" : "highlight", color: "yellow",
    quote: "A selected sentence.", comment,
    created_at: "2026-09-19T00:00:00+00:00", updated_at: "2026-09-19T00:00:00+00:00",
    targets: [{
      order: 0, page_number: 1, rects: [RECT], quote: "A selected sentence.",
      state: "EXACT", resolved_paragraph_id: "p_0001", detail: "",
      showable: true, amenable_to_jump: true,
    }],
  };
}

async function openWith(mode: "original" | "translation" | "bilingual", rotation = 0) {
  globalThis.__rotation = rotation;
  const document = seedDocument();
  seedQaSections();
  seedQaProvider();
  useWorkspaceStore.setState({
    readerMode: mode,
    annotations: [annotation("mine")],
    annotationsFor: document.documentId,
    translation: {
      documentId: document.documentId!, sessionToken: document.sessionToken,
      taskId: null, status: "success", progress: null, error: null,
      monoUrl: "blob:translated", monoPageCount: 2, degraded: false,
    },
  });
  render(<App />);
  // The panes mount after PDF.js resolves.
  await screen.findAllByTestId("pdf-page-container", {}, { timeout: 5000 });
}

beforeEach(() => {
  // jsdom has no canvas. The viewer draws into one; every suite that mounts the
  // reader stubs it, and a test of overlay geometry needs the pane to mount.
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  useWorkspaceStore.setState({
    annotations: null, annotationsFor: null, activeAnnotationId: null,
    readerMode: "original", translation: null,
  });
});

describe("DS-QA-010 · same-source idempotency (AC-P0-12)", () => {
  it("focuses an existing annotation over the same range instead of duplicating", async () => {
    /* Re-marking a phrase already marked is one annotation, not two highlights
       stacked until the text is unreadable. */
    const { findEquivalent } = await import("@/notes/session");
    const existing = [annotation("mine")];
    const same = findEquivalent(existing, [{
      sourceAnchorId: "a", anchorVersion: "1", pageNumber: 1,
      bbox: RECT, rects: [RECT], quote: "A selected sentence.",
      prefix: "", suffix: "",
    }]);
    expect(same?.id).toBe("ann_1");
  });

  it("treats a different paragraph as a different annotation", async () => {
    /* The paragraph is the unit a note attaches to, so two notes over different
       paragraphs stay two notes even if the drawing looks similar. */
    const { findEquivalent } = await import("@/notes/session");
    const other = findEquivalent([annotation("mine")], [{
      sourceAnchorId: "b", anchorVersion: "1", pageNumber: 2,
      bbox: RECT, rects: [RECT], quote: "A different sentence.",
      prefix: "", suffix: "",
    }]);
    expect(other).toBeNull();
  });
});

describe("DS-QA-010 · reader modes and annotation geometry", () => {
  it("draws a persistent highlight on the original pane (AC-P0-08)", async () => {
    await openWith("original");
    const boxes = await screen.findAllByTestId("pdf-persistent-highlight-box");
    expect(boxes.length).toBeGreaterThan(0);
  });

  it("never draws source rectangles on the translated pane (AC-P0-09)", async () => {
    /* Translated geometry is a different space. A source rectangle drawn on it
       points at whatever happens to be in that position, which is worse than no
       highlight — the reader is shown the wrong text with confidence. */
    await openWith("translation");
    const translated = screen.getByTestId("viewer-translated");
    expect(translated.querySelectorAll('[data-testid="pdf-persistent-highlight-box"]'))
      .toHaveLength(0);
  });

  it("draws on the original pane and not the translated one in bilingual (AC-P0-10)", async () => {
    await openWith("bilingual");
    const original = screen.getByTestId("viewer-original");
    const translated = screen.getByTestId("viewer-translated");
    // Both panes mount independently, and this one draws only after its page
    // does — asserting immediately is a race, not a test.
    await within(original).findAllByTestId("pdf-persistent-highlight-box");
    expect(original.querySelectorAll('[data-testid="pdf-persistent-highlight-box"]').length)
      .toBeGreaterThan(0);
    expect(translated.querySelectorAll('[data-testid="pdf-persistent-highlight-box"]'))
      .toHaveLength(0);
  });

  it("suppresses the boxes on a rotated page and keeps the note listed (AC-P0-11)", async () => {
    /* A rectangle is stored in the PDF's unrotated space. On a rotated page the
       viewport is a different space, so the box is dropped rather than guessed —
       and the note stays in the sidebar, because suppression is about geometry,
       not about hiding what the user wrote. */
    await openWith("original", 90);
    expect(
      document.querySelectorAll('[data-testid="pdf-persistent-highlight-box"]'),
    ).toHaveLength(0);
    const listed = useWorkspaceStore.getState().annotations ?? [];
    expect(listed).toHaveLength(1);
    expect(listed[0].comment).toBe("mine");
  });

  it("keeps annotations across a mode switch (AC-P0-10)", async () => {
    /* Mode is presentation. Switching it must not touch the stored records. */
    await openWith("original");
    const before = useWorkspaceStore.getState().annotations;
    useWorkspaceStore.getState().setReaderMode("translation");
    await screen.findAllByTestId("pdf-page-container");
    expect(useWorkspaceStore.getState().annotations).toBe(before);
  });
});
