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
import { apiFetch, apiJson } from "@/api/client";

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

/**
 * The settings screen's writes.
 *
 * Every function below is reachable only from the lazily-loaded settings dialog,
 * which is what keeps them out of the initial chunk — `listProfiles` above is
 * the only one the rest of the application needs, and it is the only one that
 * may be imported eagerly. `api_key` follows the backend's three intents and the
 * type here enforces them: omit it to leave a stored key alone, send `""` to
 * clear it, send a value to replace it. `null` is not in the type, because the
 * backend rejects it — "leave it" and "clear it" are equally plausible readings
 * of a null, and guessing wrong destroys a key.
 */
export interface ProfileDraft {
  name: string;
  base_url: string;
  model: string;
  protocol?: string;
  timeout_s?: number;
  api_key?: string;
}

export interface ProfileTestResult {
  ok: boolean;
  protocol: string;
  model: string | null;
  latency_ms: number | null;
}

function profileBody(draft: ProfileDraft | Partial<ProfileDraft>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(draft)) {
    if (value !== undefined) body[key] = value;
  }
  return body;
}

export async function createProfile(
  draft: ProfileDraft,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ProviderProfile> {
  // A keyless profile is a first-class configuration (a local
  // OpenAI-compatible server), so an absent key is sent as an explicit `null`
  // on create — the one place the backend accepts it.
  const body = profileBody(draft);
  if (!("api_key" in body)) body.api_key = null;
  return apiJson<ProviderProfile>("/api/profiles", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

export async function updateProfile(
  profileId: string,
  draft: Partial<ProfileDraft>,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ProviderProfile> {
  return apiJson<ProviderProfile>(`/api/profiles/${encodeURIComponent(profileId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profileBody(draft)),
    signal,
  });
}

export async function deleteProfile(
  profileId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<void> {
  // `apiFetch`, not `apiJson`: the route answers 204 with no body.
  await apiFetch(`/api/profiles/${encodeURIComponent(profileId)}`, {
    method: "DELETE",
    signal,
  });
}

/** One probe. Spends a provider request, so only a reader's click may call it. */
export async function testProfile(
  profileId: string,
  { signal }: { signal?: AbortSignal } = {},
): Promise<ProfileTestResult> {
  return apiJson<ProfileTestResult>(
    `/api/profiles/${encodeURIComponent(profileId)}/test`,
    { method: "POST", signal },
  );
}

export async function listProfiles(signal?: AbortSignal): Promise<ProviderProfile[]> {
  return apiJson<ProviderProfile[]>("/api/profiles", { signal });
}
