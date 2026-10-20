import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Desktop builds are loaded from the backend's own origin (see
  // backend/app/webapp.py), so the API base must be the empty root rather than
  // http://127.0.0.1:8000: a relative path means the window never crosses an
  // origin, and no port has to be agreed on at build time.
  const desktop = mode === "desktop";

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    define: desktop
      ? { "import.meta.env.VITE_API_BASE_URL": JSON.stringify("/") }
      : {},
    server: {
      // Local-first: bind to loopback only, never 0.0.0.0.
      host: "127.0.0.1",
      port: 5173,
    },
    build: {
      // AC-25: keep the shell bundle honest. Warn if a chunk grows past 400 KB.
      chunkSizeWarningLimit: 400,
    },
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: ["./src/tests/setup.ts"],
      css: false,
      include: ["src/**/*.test.{ts,tsx}"],
    },
  };
});
