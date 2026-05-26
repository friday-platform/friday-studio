/**
 * Pure helpers backing the conversational model pill in chat-input.
 *
 * Resolution rules:
 *   - If the workspace has a localStorage override set, the pill displays
 *     the override's provider + model.
 *   - Otherwise it shows the daemon's resolved `conversational` model
 *     from `/api/config/models`.
 *
 * Catalog lookups translate registry-form provider names (`anthropic.messages`)
 * to their short catalog key (`anthropic`) the same way ProviderMark does,
 * so we can pick a display name + letter from the catalog regardless of
 * which form `/models` reports.
 *
 * @module
 */

/** Subset of `/api/config/models/catalog` response we consume. */
export interface CatalogEntry {
  provider: string;
  credentialConfigured: boolean;
  credentialEnvVar: string | null;
  meta: { name: string; letter: string; keyPrefix: string | null; helpUrl: string | null };
  models: Array<{ id: string; displayName: string }>;
  error?: string;
}

/** Subset of `/api/config/models` per-role entry we consume. */
export interface ModelInfo {
  role: "labels" | "classifier" | "planner" | "conversational";
  resolved: { provider: string; modelId: string };
  configured: string | string[] | null;
}

/** Everything the pill UI needs to render itself. */
export interface PillLabel {
  /** Short catalog provider key, e.g. `anthropic`. */
  provider: string;
  /** Human-readable provider name (e.g. `Anthropic`). */
  providerName: string;
  /** One-letter glyph used by ProviderMark fallback. */
  providerLetter: string;
  /** Raw model id, e.g. `claude-haiku-4-5`. */
  modelId: string;
  /** Display name from the catalog if known, otherwise falls back to modelId. */
  modelDisplayName: string;
}

/**
 * Parse a `<provider>:<modelId>` localStorage override into the picker's
 * `current` shape. Returns `null` for malformed or empty values.
 */
export function parseOverride(spec: string | null): { provider: string; modelId: string } | null {
  if (!spec) return null;
  const idx = spec.indexOf(":");
  if (idx <= 0 || idx === spec.length - 1) return null;
  return { provider: spec.slice(0, idx), modelId: spec.slice(idx + 1) };
}

/** The daemon reports providers in LiteLLM registry form (`groq.chat`); the
 * catalog speaks short form (`groq`). Strip anything after the first dot. */
function toShortProvider(provider: string): string {
  return provider.split(".")[0] ?? provider;
}

/**
 * Build the label for the pill. Override wins if set; otherwise falls back
 * to the daemon's resolved conversational model. Returns `null` only when
 * neither input has produced a usable model yet (e.g. queries still
 * loading and no override set).
 */
export function resolvePillLabel(
  override: string | null,
  models: ModelInfo[],
  catalog: CatalogEntry[],
): PillLabel | null {
  const parsed = parseOverride(override);
  if (parsed) {
    return buildLabel(parsed.provider, parsed.modelId, catalog);
  }

  const conversational = models.find((m) => m.role === "conversational");
  if (!conversational) return null;
  return buildLabel(
    toShortProvider(conversational.resolved.provider),
    conversational.resolved.modelId,
    catalog,
  );
}

function buildLabel(provider: string, modelId: string, catalog: CatalogEntry[]): PillLabel {
  const short = toShortProvider(provider);
  const entry = catalog.find((e) => e.provider === short);
  const meta = entry?.meta;
  const model = entry?.models.find((m) => m.id === modelId);
  return {
    provider: short,
    providerName: meta?.name ?? short,
    providerLetter: meta?.letter ?? short.charAt(0).toUpperCase(),
    modelId,
    modelDisplayName: model?.displayName ?? modelId,
  };
}
