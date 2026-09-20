import { render, screen, waitFor } from "@testing-library/react";

import { App } from "@/app/App";

/**
 * Render the whole application, and wait for the sidebar's panel to arrive.
 *
 * The sidebar's panels are lazily loaded (DS-QA-015), so a test that renders and
 * then queries the panel synchronously is racing a dynamic import. This waits for
 * the fallback to be replaced, which means every synchronous query afterwards
 * sees exactly the DOM it saw before the split.
 *
 * It waits for *absence of the fallback* rather than for a specific element on
 * purpose: the suites are about different panels, and one that named the QA
 * composer would fail in a suite that never opens the QA tab.
 */
export async function renderApp() {
  const result = render(<App />);
  await waitFor(() =>
    expect(screen.queryByTestId("assistant-panel-loading")).toBeNull(),
  );
  return result;
}
