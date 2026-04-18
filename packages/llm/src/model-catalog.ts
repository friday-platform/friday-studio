/**
 * Model catalog — lists the models available in each registered provider
 * so the Settings page can render a dropdown instead of a free-text input.
 *
 * Sources:
 * - **Vercel AI Gateway `/config`** (public, unauthenticated): one HTTP
 *   call returns a 265-entry cross-provider catalog with name / model-id /
 *   type. Covers anthropic, openai, google (via the gateway's `vertex`
 *   provider namespace), and a small Groq slice. Used for 4 of our 5
 *   providers; `claude-code` reuses the anthropic list since it wraps
 *   the same models.
 * - **Groq `/openai/v1/models`** (authenticated with `GROQ_API_KEY`):
 *   the gateway surfaces only 1 Groq model, so when the user has a
 *   Groq key we hit Groq directly for the full catalog.
 *
 * Everything is cached in memory for {@link CACHE_TTL_MS} (1h by
 * default) and prewarmed at daemon startup via {@link prewarmCatalog}
 * so the first Settings page load never waits on a cold fetch.
 *
 * @module
 */
import process from "node:process";
import { z } from "zod";
import { PROVIDER_ENV_VARS, type ValidProvider } from "./util.ts";

// ─── Types ─────────────────────────────────────────────────────────────────

/**
 * Every provider the catalog reports on. `ValidProvider` covers the four
 * external providers; `claude-code` is a local wrapper around Anthropic
 * that shares the Anthropic API key and catalog but is invoked via a
 * different runtime path (see `packages/llm/src/claude-code.ts`).
 */
export type CatalogProvider = ValidProvider | "claude-code";

const CATALOG_PROVIDERS: readonly CatalogProvider[] = [
  "anthropic",
  "openai",
  "google",
  "groq",
  "claude-code",
] as const;

export interface ModelInfo {
  /**
   * Raw model identifier (no provider prefix). Callers build the full
   * `provider:model` id by concatenating `entry.provider + ":" + model.id`
   * — doing that here would double-prefix when the caller already holds
   * the provider separately (as the Settings chain picker does).
   */
  id: string;
  /** Human-readable label for the dropdown. */
  displayName: string;
}

/**
 * UI-only metadata for rendering the model picker. Lives here so the
 * settings page + daemon agree on the same per-provider presentation.
 */
export interface ProviderMeta {
  /** Human-readable name ("Anthropic", "OpenAI", …). */
  name: string;
  /** Single letter glyph shown in the provider badge (A / O / G / Q / C). */
  letter: string;
  /** Expected prefix on the user's API key — becomes the placeholder in
   * the inline "Save & unlock" flow so typos surface visually. */
  keyPrefix: string | null;
  /** Where to get a key; rendered as prose in the locked banner. */
  helpUrl: string | null;
}

export interface CatalogEntry {
  provider: CatalogProvider;
  /** True when the user has the credential needed to invoke this provider. */
  credentialConfigured: boolean;
  /**
   * Env var name that would unlock this provider, or `null` when
   * `LITELLM_API_KEY` is set and covers all providers via the proxy.
   */
  credentialEnvVar: string | null;
  /** Presentation hints for the picker. */
  meta: ProviderMeta;
  /** Language models only — image / embedding / video / tts are filtered out. */
  models: ModelInfo[];
  /** Populated when a fetch failed so the UI can surface the reason. */
  error?: string;
}

export interface Catalog {
  fetchedAt: number;
  entries: CatalogEntry[];
}

// ─── Constants ─────────────────────────────────────────────────────────────

const GATEWAY_URL = "https://ai-gateway.vercel.sh/v4/ai/config";
const GATEWAY_HEADERS = { "ai-gateway-protocol-version": "0.0.1" };
const GROQ_URL = "https://api.groq.com/openai/v1/models";

const FETCH_TIMEOUT_MS = 3_000;
/** One hour — models don't change intra-session. Prewarm covers first paint. */
export const CACHE_TTL_MS = 60 * 60 * 1_000;

// `claude-code` shares `ANTHROPIC_API_KEY` because it's a wrapper around
// Anthropic's models; keep this explicit so `PROVIDER_ENV_VARS` can stay
// scoped to the four external providers it describes today.
const ENV_VAR_BY_CATALOG_PROVIDER: Record<CatalogProvider, string> = {
  anthropic: PROVIDER_ENV_VARS.anthropic,
  openai: PROVIDER_ENV_VARS.openai,
  google: PROVIDER_ENV_VARS.google,
  groq: PROVIDER_ENV_VARS.groq,
  "claude-code": PROVIDER_ENV_VARS.anthropic,
};

/**
 * Provider presentation metadata. Hand-maintained — updates should be
 * rare (name / letter / key prefix / docs URL don't change often).
 * Consumed by the Settings page model picker.
 */
export const PROVIDER_META: Record<CatalogProvider, ProviderMeta> = {
  anthropic: {
    name: "Anthropic",
    letter: "A",
    keyPrefix: "sk-ant-",
    helpUrl: "console.anthropic.com/settings/keys",
  },
  openai: {
    name: "OpenAI",
    letter: "O",
    keyPrefix: "sk-",
    helpUrl: "platform.openai.com/api-keys",
  },
  google: { name: "Google", letter: "G", keyPrefix: "AIza", helpUrl: "aistudio.google.com/apikey" },
  groq: { name: "Groq", letter: "Q", keyPrefix: "gsk_", helpUrl: "console.groq.com/keys" },
  "claude-code": {
    name: "Claude Code",
    letter: "C",
    // claude-code wraps the Anthropic API under the hood, so it reuses
    // ANTHROPIC_API_KEY — but the user never types a key *for* claude-code
    // specifically, so no placeholder / help URL to show.
    keyPrefix: null,
    helpUrl: null,
  },
};

// ─── Schemas ───────────────────────────────────────────────────────────────

const gatewayModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  specification: z.object({ provider: z.string(), modelId: z.string() }),
  modelType: z.string().nullish(),
});

const gatewayResponseSchema = z.object({ models: z.array(gatewayModelSchema) });

const groqResponseSchema = z.object({ data: z.array(z.object({ id: z.string() })) });

// ─── Fetchers ──────────────────────────────────────────────────────────────

type GatewayModel = z.infer<typeof gatewayModelSchema>;

async function fetchGateway(): Promise<GatewayModel[]> {
  const res = await fetch(GATEWAY_URL, {
    headers: GATEWAY_HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`gateway returned HTTP ${res.status}`);
  const parsed = gatewayResponseSchema.parse(await res.json());
  return parsed.models;
}

async function fetchGroq(apiKey: string): Promise<string[]> {
  const res = await fetch(GROQ_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`groq returned HTTP ${res.status}`);
  const parsed = groqResponseSchema.parse(await res.json());
  return parsed.data.map((m) => m.id);
}

// ─── Filters / normalization ───────────────────────────────────────────────

/**
 * Gateway IDs look like `anthropic/claude-sonnet-4.6`. We store just the
 * model portion (`claude-sonnet-4.6`) since callers already know which
 * Friday provider bucket they're pulling from — stripping the first
 * path segment is all we need here.
 */
function stripGatewayProviderPrefix(gatewayModelId: string): string {
  return gatewayModelId.replace(/^[^/]+\//, "");
}

/**
 * Partition gateway models into Friday's provider buckets. Returns one
 * `ModelInfo[]` per `CatalogProvider`; `groq` is left empty here because
 * the gateway's Groq coverage is intentionally skipped — we prefer the
 * direct-Groq fetch which has a meaningfully larger catalog.
 */
function groupGatewayModels(models: GatewayModel[]): Record<CatalogProvider, ModelInfo[]> {
  const out: Record<CatalogProvider, ModelInfo[]> = {
    anthropic: [],
    openai: [],
    google: [],
    groq: [],
    "claude-code": [],
  };
  for (const m of models) {
    // Gateway uses `modelType: null` for most language models; explicit
    // other types cover image / embedding / video / tts / reranker.
    if (m.modelType != null && m.modelType !== "language") continue;
    const { provider, modelId } = m.specification;
    const rawId = stripGatewayProviderPrefix(modelId);
    if (provider === "anthropic") {
      out.anthropic.push({ id: rawId, displayName: m.name });
      // claude-code wraps Anthropic's models; the ids are the same — both
      // buckets share the raw id and the caller composes the full
      // `provider:model` string with the correct Friday provider.
      out["claude-code"].push({ id: rawId, displayName: m.name });
    } else if (provider === "openai") {
      out.openai.push({ id: rawId, displayName: m.name });
    } else if (provider === "vertex" && modelId.startsWith("google/gemini-")) {
      // Google's Gemini models live under the gateway's `vertex` provider,
      // prefixed `google/`. We only want Gemini (not Imagen / Veo /
      // embeddings), and only language variants (not `-image` preview).
      if (/-image(-|$)/.test(modelId)) continue;
      out.google.push({ id: rawId, displayName: m.name });
    }
  }
  return out;
}

/**
 * Groq returns everything on the account — including audio models
 * (whisper, playai-tts, …) that aren't valid chat completions. Filter
 * to language models by dropping known audio prefixes.
 */
function filterGroqLanguageModels(ids: string[]): ModelInfo[] {
  return ids
    .filter((id) => !/^whisper-|^playai-tts-|^distil-whisper-/.test(id))
    .map((id) => ({ id, displayName: id }));
}

// ─── Catalog assembly ──────────────────────────────────────────────────────

/**
 * Resolve whether a provider has a usable credential configured.
 * `LITELLM_API_KEY` unlocks everything via the LiteLLM proxy (see
 * `packages/llm/src/registry.ts`), which is why we report `null` for
 * `credentialEnvVar` in that mode — there's nothing actionable to add.
 */
function resolveCredential(provider: CatalogProvider): {
  configured: boolean;
  envVar: string | null;
} {
  if (process.env.LITELLM_API_KEY) return { configured: true, envVar: null };
  const envVar = ENV_VAR_BY_CATALOG_PROVIDER[provider];
  return { configured: Boolean(process.env[envVar]), envVar };
}

/**
 * Do the actual work of fetching + filtering + assembling the catalog.
 * Called by {@link getCatalog} on cache miss.
 */
async function fetchCatalog(): Promise<Catalog> {
  const groqKey = process.env.GROQ_API_KEY;

  // Fire gateway and (optionally) groq in parallel. allSettled so one
  // provider timing out doesn't take the whole catalog with it.
  const [gatewayResult, groqResult] = await Promise.allSettled([
    fetchGateway(),
    groqKey ? fetchGroq(groqKey) : Promise.reject(new Error("no GROQ_API_KEY")),
  ]);

  const gatewayBuckets =
    gatewayResult.status === "fulfilled" ? groupGatewayModels(gatewayResult.value) : null;
  const gatewayError =
    gatewayResult.status === "rejected"
      ? String(
          gatewayResult.reason instanceof Error
            ? gatewayResult.reason.message
            : gatewayResult.reason,
        )
      : null;

  const groqModels =
    groqResult.status === "fulfilled" ? filterGroqLanguageModels(groqResult.value) : null;
  // Only surface a groq error when the user actually has a key; absence
  // of a key is a separate ui state (`credentialConfigured: false`).
  const groqError =
    groqKey && groqResult.status === "rejected"
      ? String(groqResult.reason instanceof Error ? groqResult.reason.message : groqResult.reason)
      : null;

  const entries: CatalogEntry[] = CATALOG_PROVIDERS.map((provider) => {
    const cred = resolveCredential(provider);
    let models: ModelInfo[] = [];
    let error: string | undefined;

    if (provider === "groq") {
      if (groqModels) {
        models = groqModels;
      } else if (groqError) {
        error = groqError;
      }
      // else: no key, no models, no error — UI shows the `envVar` hint.
    } else if (gatewayBuckets) {
      models = gatewayBuckets[provider];
    } else if (gatewayError) {
      error = gatewayError;
    }

    return {
      provider,
      credentialConfigured: cred.configured,
      credentialEnvVar: cred.envVar,
      meta: PROVIDER_META[provider],
      models,
      ...(error ? { error } : {}),
    };
  });

  return { fetchedAt: Date.now(), entries };
}

// ─── Cache + public API ────────────────────────────────────────────────────

let cache: Catalog | null = null;
let inflight: Promise<Catalog> | null = null;

/**
 * Returns the cached catalog, or fetches fresh when the cache is missing
 * or older than {@link CACHE_TTL_MS}. Concurrent callers share the
 * in-flight fetch so we never thunder-herd the gateway.
 */
export function getCatalog(): Promise<Catalog> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return Promise.resolve(cache);
  if (inflight) return inflight;
  inflight = fetchCatalog()
    .then((fresh) => {
      cache = fresh;
      return fresh;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Kick off a background fetch so the first `GET /api/config/models/catalog`
 * request hits a warm cache. Swallows errors — a failing prewarm shouldn't
 * block daemon startup; the next on-demand fetch will try again.
 */
export async function prewarmCatalog(): Promise<void> {
  try {
    await getCatalog();
  } catch {
    // Intentional: logged upstream if the caller cares; daemon continues.
  }
}

/** Clear the cache. Intended for tests. */
export function resetCatalogCacheForTests(): void {
  cache = null;
  inflight = null;
}
