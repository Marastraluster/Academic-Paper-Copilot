/**
 * Provider profile endpoints (docs/API_CONTRACT.md §3).
 *
 * A profile is the *entire* credential reference the frontend ever handles. The
 * response type below has no key-bearing field, and neither does the backend's:
 * a leak would require adding a field on both sides rather than forgetting to
 * remove one.
 *
 * `has_key` is what makes a keyless local provider usable. A local
 * OpenAI-compatible server is a supported configuration, and a client that
 * insists on a non-empty key breaks exactly the local-first case this product
 * exists for — a bug DS-BE-007 had to fix server-side. Nothing here may
 * re-introduce it as a frontend validation rule.
 */
import { apiJson } from "@/api/client";

export interface ProviderProfile {
  id: string;
  name: string;
  base_url: string;
  model: string;
  protocol: string;
  has_key: boolean;
  /** Already masked by the server, e.g. `sk-••••••••ab12`. Never the real key. */
  api_key_masked: string;
}

/** True when the profile can be used without an API key. */
export function isKeyless(profile: ProviderProfile): boolean {
  return !profile.has_key;
}

export async function listProfiles(signal?: AbortSignal): Promise<ProviderProfile[]> {
  return apiJson<ProviderProfile[]>("/api/profiles", { signal });
}
