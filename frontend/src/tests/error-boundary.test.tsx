import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorBoundary } from "@/app/ErrorBoundary";

function Bomb({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error("boom from child component");
  }
  return <div>child rendered fine</div>;
}

/**
 * AC-16 — an unhandled child error must produce a readable fallback
 * rather than an empty white screen.
 */
describe("DS-FE-001 · AC-16 error boundary", () => {
  beforeEach(() => {
    // React logs the caught error; keep the test output readable.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders children normally when nothing throws", () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow={false} />
      </ErrorBoundary>,
    );

    expect(screen.getByText("child rendered fine")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a graceful fallback instead of a blank screen when a child throws", () => {
    render(
      <ErrorBoundary>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );

    const fallback = screen.getByRole("alert");
    expect(fallback).toBeInTheDocument();
    expect(fallback).toHaveTextContent("界面出现错误");
    // The error message is surfaced, and the user is told the PDF is safe.
    expect(fallback).toHaveTextContent("boom from child component");
    expect(fallback).toHaveTextContent(/原始 PDF 未受影响/);
  });

  it("recovers when the retry control is used", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <ErrorBoundary>
        <Bomb shouldThrow />
      </ErrorBoundary>,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();

    // The underlying cause must be fixed BEFORE retrying — otherwise the child
    // simply throws again and the boundary re-catches, which is correct
    // behaviour but not what this test is checking.
    rerender(
      <ErrorBoundary>
        <Bomb shouldThrow={false} />
      </ErrorBoundary>,
    );
    // Resetting state is what makes the boundary re-attempt its children.
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("child rendered fine")).toBeInTheDocument();
  });
});
