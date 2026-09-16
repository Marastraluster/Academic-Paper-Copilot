import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
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
});
