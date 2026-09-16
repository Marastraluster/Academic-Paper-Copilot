import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

import { useWorkspaceStore } from "@/stores/workspace";

/**
 * The workspace store is a module singleton, so component state would otherwise
 * leak between tests. Snapshot the initial state and restore it after each test.
 */
const initialState = useWorkspaceStore.getState();

afterEach(() => {
  cleanup();
  useWorkspaceStore.setState(initialState, true);
});
