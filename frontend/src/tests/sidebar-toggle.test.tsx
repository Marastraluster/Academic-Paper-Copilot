import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "@/app/App";
import { SIDEBAR_WIDTH_PX } from "@/lib/layout";
import { useWorkspaceStore } from "@/stores/workspace";

const sidebar = () => screen.getByTestId("assistant-sidebar");

/**
 * AC-33 / AC-05 — collapse and expand, with the workspace reclaiming width.
 */
describe("DS-FE-001 · AC-33 sidebar collapse", () => {
  it("starts expanded at a width within the 320–380px band (AC-05)", () => {
    render(<App />);

    expect(sidebar()).toHaveAttribute("data-state", "expanded");
    expect(sidebar()).toHaveStyle({ width: `${SIDEBAR_WIDTH_PX}px` });
    expect(SIDEBAR_WIDTH_PX).toBeGreaterThanOrEqual(320);
    expect(SIDEBAR_WIDTH_PX).toBeLessThanOrEqual(380);
  });

  it("collapses to zero width and unmounts its contents", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByTestId("sidebar-toggle"));

    expect(sidebar()).toHaveAttribute("data-state", "collapsed");
    expect(sidebar()).toHaveStyle({ width: "0px" });

    // Contents must be gone, so nothing invisible is focusable.
    expect(screen.queryByTestId("conversation-area")).not.toBeInTheDocument();
    expect(screen.queryByTestId("scope-selector")).not.toBeInTheDocument();
  });

  it("keeps the workspace mounted so it absorbs the reclaimed width", async () => {
    const user = userEvent.setup();
    render(<App />);

    const workspace = screen.getByTestId("reader-workspace");
    expect(workspace).toBeInTheDocument();

    await user.click(screen.getByTestId("sidebar-toggle"));

    // Workspace survives the collapse and remains flex-1 (AC-05).
    expect(screen.getByTestId("reader-workspace")).toBeInTheDocument();
    expect(screen.getByTestId("reader-workspace")).toHaveClass("flex-1");
  });

  it("exposes a reachable expand trigger while collapsed (AC-05)", async () => {
    const user = userEvent.setup();
    render(<App />);

    const toggle = screen.getByTestId("sidebar-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    await user.click(toggle);

    // AC-05: a persistent expand trigger remains accessible.
    const expandTrigger = screen.getByRole("button", { name: "展开侧边栏" });
    expect(expandTrigger).toBeInTheDocument();
    expect(expandTrigger).toHaveAttribute("aria-expanded", "false");
  });

  it("restores the expanded state on a second toggle", async () => {
    // The sidebar opens on 概览 now. This suite reaches for a QA element to prove
    // the contents come back, so it names the panel rather than assuming one.
    useWorkspaceStore.setState({ outlinePanel: "qa" });
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByTestId("sidebar-toggle"));
    expect(sidebar()).toHaveAttribute("data-state", "collapsed");

    await user.click(screen.getByRole("button", { name: "展开侧边栏" }));

    expect(sidebar()).toHaveAttribute("data-state", "expanded");
    expect(screen.getByTestId("conversation-area")).toBeInTheDocument();
  });
});
