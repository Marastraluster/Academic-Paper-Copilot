import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

import { useWorkspaceStore } from "@/stores/workspace";

/**
 * jsdom implements neither observer the PDF viewer relies on.
 *
 * These stubs report everything as visible and non-resizing, which is the
 * behaviour a small document has anyway — so the viewer's real logic (windowing,
 * current-page tracking, fit-width) runs unchanged rather than being bypassed.
 */
class MockIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds: readonly number[] = [];

  constructor(private readonly callback: IntersectionObserverCallback) {}

  observe(target: Element): void {
    this.callback(
      [{ target, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry],
      this,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

class MockResizeObserver implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element): void {
    this.callback(
      [{ target, contentRect: (target as HTMLElement).getBoundingClientRect() } as ResizeObserverEntry],
      this,
    );
  }
  unobserve(): void {}
  disconnect(): void {}
}

vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
vi.stubGlobal("ResizeObserver", MockResizeObserver);

// jsdom has no layout engine, so every element measures zero — which makes
// fit-width divide by zero and a column clamp collapse to its floor. The boxes
// that are measured for real are given a width instead, so those paths are
// exercised rather than bypassed: the PDF viewer's scroll box, and the reflowed
// reading's.
const MEASURED_BOXES = new Set(["pdf-viewer", "reflow-scroll"]);
Object.defineProperty(HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get(this: HTMLElement) {
    return this.dataset.testid !== undefined && MEASURED_BOXES.has(this.dataset.testid) ? 800 : 0;
  },
});

// PDF.js reaches for canvas APIs jsdom lacks. The viewer already copes with a
// missing 2D context, but a noisy stub keeps the failure mode obvious.
if (!HTMLCanvasElement.prototype.getContext) {
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
}

/*
 * `Blob.arrayBuffer()` is standard and present in every browser this app
 * targets, but jsdom does not implement it. Polyfilled here rather than worked
 * around in the viewer: bending production code to suit the test environment
 * would mean shipping the workaround to users too.
 */
if (typeof Blob !== "undefined" && typeof Blob.prototype.arrayBuffer !== "function") {
  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob) {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(this);
    });
  };
}

/*
 * jsdom implements no scroll API on elements, so the viewer's page-jump — which
 * asks its container to scroll — throws a TypeError from inside a click handler.
 * The suite reported this as four uncaught exceptions while still printing
 * "48 passed", which made the exit code meaningless. The stub preserves the
 * behaviour actually under test: that jumping asks the container to scroll.
 */
if (typeof Element.prototype.scrollTo !== "function") {
  Element.prototype.scrollTo = () => {};
}

/*
 * jsdom implements neither object-URL method, and the object-URL lifecycle is
 * precisely what AC-P0-15 is about — a translated document is fetched as a blob
 * and must be revoked on switch, retranslation and teardown. Stubbing them (and
 * leaving `revokeObjectURL` spy-able) is what makes that observable in a test
 * rather than something that silently never happens.
 */
if (typeof URL.createObjectURL !== "function") {
  let objectUrlSeq = 0;
  URL.createObjectURL = () => `blob:jsdom-${++objectUrlSeq}`;
  URL.revokeObjectURL = () => {};
}

/**
 * The workspace store is a module singleton, so component state would otherwise
 * leak between tests. Snapshot the initial state and restore it after each test.
 */
const initialState = useWorkspaceStore.getState();

afterEach(() => {
  cleanup();
  useWorkspaceStore.setState(initialState, true);
});
