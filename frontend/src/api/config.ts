/**
 * DS-FE-001 AC-10 — single source of truth for the backend location.
 *
 * No component may hardcode a backend URL. The backend does not exist yet
 * (Phase 3); this module exists so that when it does, wiring is a one-line change
 * and never a grep across the component tree.
 */

/** Loopback-only. This is a local-first application; the API is never remote. */
export const DEFAULT_API_BASE_URL = "http://127.0.0.1:8000";

export const API_BASE_URL: string =
  import.meta.env.VITE_API_BASE_URL ?? DEFAULT_API_BASE_URL;

/** Build an absolute URL for a backend path, e.g. apiUrl("/api/health"). */
export function apiUrl(path: string): string {
  const base = API_BASE_URL.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}
