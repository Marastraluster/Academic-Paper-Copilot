import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "@/app/App";
import "@/index.css";
import { initTheme } from "@/settings/theme";

// Before the first render, so the page never paints light and then turns dark.
initTheme();

const container = document.getElementById("root");

if (!container) {
  throw new Error("Root container #root not found in index.html");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
