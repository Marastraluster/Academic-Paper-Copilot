import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { App } from "@/app/App";
import { QUICK_ACTIONS } from "@/stores/workspace";

/**
 * AC-35 — all six quick actions render and are clickable without a runtime error.
 * AC-06 — the sidebar contains scope selector, quick actions, conversation, composer.
 */
describe("DS-FE-001 · AC-35 quick actions", () => {
  it("renders all six required quick actions (AC-06)", () => {
    render(<App />);

    expect(QUICK_ACTIONS).toHaveLength(6);
    for (const action of QUICK_ACTIONS) {
      expect(screen.getByTestId(`quick-action-${action}`)).toBeInTheDocument();
    }
  });

  it("fires every quick-action handler without throwing", async () => {
    const user = userEvent.setup();
    render(<App />);

    for (const action of QUICK_ACTIONS) {
      await user.click(screen.getByTestId(`quick-action-${action}`));
    }

    // Each click appends a user turn plus a reply.
    const conversation = screen.getByTestId("conversation-area");
    expect(conversation).toHaveTextContent(QUICK_ACTIONS[0]);
    expect(conversation).toHaveTextContent(QUICK_ACTIONS[5]);
  });

  it("renders the scope selector, conversation area and composer (AC-06)", () => {
    render(<App />);

    expect(screen.getByTestId("scope-selector")).toBeInTheDocument();
    expect(screen.getByTestId("conversation-area")).toBeInTheDocument();
    expect(screen.getByLabelText("向论文提问")).toBeInTheDocument();
    expect(screen.getByTestId("composer-send")).toBeInTheDocument();
  });

  it("changes scope through the selector (AC-06)", async () => {
    const user = userEvent.setup();
    render(<App />);

    const select = screen.getByTestId("scope-selector");
    await user.selectOptions(select, "page");

    expect(select).toHaveValue("page");
  });
});

describe("DS-FE-001 · AC-18 composer validation", () => {
  it("disables send for an empty composer", () => {
    render(<App />);

    expect(screen.getByTestId("composer-send")).toBeDisabled();
  });

  it("ignores whitespace-only submissions", async () => {
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByLabelText("向论文提问");
    const before = screen.getByTestId("conversation-area").children.length;

    await user.type(input, "   ");
    expect(screen.getByTestId("composer-send")).toBeDisabled();

    await user.keyboard("{Enter}");

    expect(screen.getByTestId("conversation-area").children.length).toBe(before);
  });

  it("sends a non-empty message and clears the composer", async () => {
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByLabelText("向论文提问");
    await user.type(input, "什么是 diffusion policy？");
    await user.click(screen.getByTestId("composer-send"));

    expect(screen.getByTestId("conversation-area")).toHaveTextContent(
      "什么是 diffusion policy？",
    );
    expect(input).toHaveValue("");
  });
});
