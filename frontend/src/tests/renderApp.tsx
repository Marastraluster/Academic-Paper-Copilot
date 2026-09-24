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
  // A five-second budget, not the one-second default: the suites run in parallel
  // and a dynamic import that takes 40 ms alone can take longer than a second
  // when six files are compiling at once. The wait is for a chunk to arrive, and
  // a flaky timeout there reads as a product failure that is not one.
  await waitFor(
    () => expect(screen.queryByTestId("assistant-panel-loading")).toBeNull(),
    { timeout: 5_000 },
  );
  return result;
}
