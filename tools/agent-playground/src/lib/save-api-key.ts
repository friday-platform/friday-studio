/**
 * Inline API-key save shared by the settings model-picker and the per-chat
 * model pill. Reads the daemon's current .env, splices in the new key,
 * PUTs the full map, then refetches the catalog so callers can re-render
 * the newly-unlocked provider without a full reload.
 *
 * The .env endpoint is full-rewrite, so we always read latest before the
 * splice — otherwise a concurrent edit from another tab would be clobbered.
 *
 * @module
 */

/** Subset of `/api/config/models/catalog` response we re-expose. */
export interface CatalogEntry {
  provider: string;
  credentialConfigured: boolean;
  credentialEnvVar: string | null;
  meta: { name: string; letter: string; keyPrefix: string | null; helpUrl: string | null };
  models: Array<{ id: string; displayName: string }>;
  /** Image-generation models advertised by the gateway/provider; empty for
   * providers with no image surface. Carried through the catalog refresh
   * so the Settings image picker sees the post-unlock state. */
  images: Array<{ id: string; displayName: string }>;
  error?: string;
}

interface EnvResponse {
  envVars: Record<string, string>;
}

interface CatalogResponse {
  entries: CatalogEntry[];
}

function isEnvResponse(value: unknown): value is EnvResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "envVars" in value &&
    typeof (value as { envVars: unknown }).envVars === "object" &&
    (value as { envVars: unknown }).envVars !== null
  );
}

function isCatalogResponse(value: unknown): value is CatalogResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "entries" in value &&
    Array.isArray((value as { entries: unknown }).entries)
  );
}

/**
 * Persist a single API key into the daemon's .env and return the refreshed
 * model catalog. Throws on any non-2xx along the way; callers surface the
 * error message in their UI.
 */
export async function saveApiKeyForPlatform(
  envVar: string,
  value: string,
): Promise<CatalogEntry[]> {
  const envRes = await fetch("/api/daemon/api/config/env");
  if (!envRes.ok) {
    throw new Error(`Failed to load env (HTTP ${envRes.status})`);
  }
  const envBody: unknown = await envRes.json();
  const current = isEnvResponse(envBody) ? envBody.envVars : {};

  const next: Record<string, string> = { ...current, [envVar]: value };

  const putRes = await fetch("/api/daemon/api/config/env", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ envVars: next }),
  });
  if (!putRes.ok) {
    const text = await putRes.text();
    throw new Error(`Save failed (HTTP ${putRes.status}): ${text}`);
  }

  const catalogRes = await fetch("/api/daemon/api/config/models/catalog");
  if (!catalogRes.ok) {
    throw new Error(`Failed to reload catalog (HTTP ${catalogRes.status})`);
  }
  const catalogBody: unknown = await catalogRes.json();
  if (!isCatalogResponse(catalogBody)) {
    throw new Error("Catalog response missing 'entries' array");
  }
  return catalogBody.entries;
}
