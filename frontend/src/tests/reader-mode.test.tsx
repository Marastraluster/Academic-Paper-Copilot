import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "@/app/App";

const original = () => screen.queryByTestId("viewer-original");
const translated = () => screen.queryByTestId("viewer-translated");

/**
 * AC-32 — reader mode switching must restructure the workspace DOM,
 * not merely relabel it (failure F-04).
 */
describe("DS-FE-001 · AC-32 reader mode switching", () => {
  it("defaults to bilingual with both viewer panels present (AC-04)", () => {
    render(<App />);

    expect(original()).toBeInTheDocument();
    expect(translated()).toBeInTheDocument();
    expect(screen.getByTestId("reader-workspace")).toHaveAttribute(
      "data-reader-mode",
      "bilingual",
    );
  });

  it("renders only the original panel in 原文 mode", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByTestId("reader-mode-original"));

    expect(original()).toBeInTheDocument();
    expect(translated()).not.toBeInTheDocument();
    expect(screen.getByTestId("reader-workspace")).toHaveAttribute(
      "data-reader-mode",
      "original",
    );
  });

  it("renders only the translated panel in 译文 mode", async () => {
    const user = userEvent.setup();
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
    render(<App />);

    await user.click(screen.getByTestId("reader-mode-original"));
    expect(translated()).not.toBeInTheDocument();

    await user.click(screen.getByTestId("reader-mode-bilingual"));
    expect(original()).toBeInTheDocument();
    expect(translated()).toBeInTheDocument();
  });

  it("marks exactly one mode as selected at a time (AC-30)", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByTestId("reader-mode-original"));

    const selected = screen
      .getAllByRole("tab")
      .filter((tab) => tab.getAttribute("aria-selected") === "true");

    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent("原文");
  });

  it("survives rapid toggling without losing state integrity (AC-14)", async () => {
    const user = userEvent.setup();
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
