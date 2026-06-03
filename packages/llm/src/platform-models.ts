import process from "node:process";
import type { ImageModelV3, LanguageModelV3 } from "@ai-sdk/provider";
import { logger } from "@atlas/logger";
import { listImageEntries, lookupImageEntry } from "./image-capabilities.ts";
import { registry } from "./registry.ts";
import {
  buildRegistryModelId,
  isRegistryProvider,
  REGISTRY_PROVIDERS,
  type RegistryProvider,
} from "./registry-id.ts";
import { traceModel } from "./tracing.ts";
import { PROVIDER_ENV_VARS, type ValidProvider } from "./util.ts";

/**
 * A role's configured value. Accepts either a single model id
 * (back-compat, equivalent to a one-element chain) or an explicit
 * primary → fallback_1 → fallback_2 → … chain. When a chain is
 * supplied the resolver tries entries in order and picks the first
 * one whose credentials are present; if the whole user chain is
 * uncredentialed the default chain takes over.
 */
export type PlatformModelConfig = string | readonly string[];

/**
 * Minimal shape consumed by `createPlatformModels`. Structurally compatible
 * with `AtlasConfig` from `@atlas/config`, but declared locally to avoid a
 * dependency cycle (config → fsm-engine → llm).
 */
export interface PlatformModelsInput {
  models?: {
    labels?: PlatformModelConfig;
    classifier?: PlatformModelConfig;
    planner?: PlatformModelConfig;
    conversational?: PlatformModelConfig;
    image?: PlatformModelConfig;
  };
}

/**
 * Task archetype for a platform LLM call site. Each role has distinct
 * failure-mode and call-pattern characteristics — see the design doc.
 *
 * Note: `"image"` is a fifth role but is NOT served by `get(role)` —
 * `get` returns `LanguageModelV3` and image models are `ImageModelV3`.
 * Image resolution is on the sibling `getImage()` method. The literal
 * is included here so `DEFAULT_PLATFORM_MODELS` and config-shape
 * machinery can be keyed uniformly across all five roles.
 */
export type PlatformRole = "labels" | "classifier" | "planner" | "conversational" | "image";

/**
 * Roles whose model is a `LanguageModelV3` (resolved via `get(role)`).
 * Excludes `"image"`, which produces an `ImageModelV3` and routes
 * through the separate `getImage()` method.
 */
type LanguageRole = Exclude<PlatformRole, "image">;

/**
 * Injected dependency providing pre-traced model instances for each
 * platform task archetype. Constructed once per daemon at boot.
 *
 * `get(role)` covers the four language roles; `getImage()` is a sibling
 * for image generation. Two methods because the return types differ at
 * the SDK layer (`LanguageModelV3` vs `ImageModelV3`) — a single
 * polymorphic `get` would force callers to narrow, defeating its purpose.
 *
 * `getImageOverlayKey()` returns the resolved `provider:model` spec used
 * to build the image model (e.g. `"google:gemini-2.5-flash-image"`). The
 * SDK `ImageModelV3` exposes only a bare `modelId` and a transport-shaped
 * `provider` string (e.g. `"google.generative-ai"`) — neither match the
 * capability overlay's `provider:model` keying. Callers that need to look
 * up overlay metadata must use this method, not `model.modelId`.
 *
 * `reload(input)` swaps the internal config in place after re-running the
 * same boot-time validation. The daemon and every long-lived consumer
 * (workspace runtimes, MCP servers, route handlers) hold a stable
 * reference to one `PlatformModels` instance — `reload` lets the
 * Settings UI's PUT /api/config/models take effect on the next
 * `get`/`getImage` call without restarting the daemon. Throws
 * `PlatformModelsConfigError` on bad input WITHOUT mutating state.
 */
export interface PlatformModels {
  get(role: LanguageRole): LanguageModelV3;
  getImage(): ImageModelV3;
  getImageOverlayKey(): string;
  reload(input: PlatformModelsInput | null): void;
}

/**
 * Per-role ordered default chains. The factory walks each chain and picks
 * the first entry whose credentials are present. Zero-config behavior is
 * Anthropic across every role; users who want Groq (or any other provider)
 * for a role must opt in via `models.<role>` in friday.yml / settings.
 */
export const DEFAULT_PLATFORM_MODELS: Record<PlatformRole, readonly string[]> = {
  labels: ["anthropic:claude-haiku-4-5"],
  classifier: ["anthropic:claude-haiku-4-5"],
  planner: ["anthropic:claude-sonnet-4-6"],
  conversational: ["anthropic:claude-sonnet-4-6"],
  // Stable replacement for the now-deprecated `gemini-3.1-flash-image-preview`
  // hardcode in image-generation agent. See design doc § Schema.
  image: ["google:gemini-2.5-flash-image"],
};

/** Providers whose credentials are resolved via `PROVIDER_ENV_VARS`. */
function hasEnvVar(provider: RegistryProvider): provider is ValidProvider {
  return provider !== "claude-code";
}

/**
 * Providers whose credential resolution does not require an env var.
 * `claude-code` shells out to the Claude CLI and surfaces its own errors.
 */
const ALWAYS_CREDENTIALED: ReadonlySet<string> = new Set(["claude-code"]);

/** Parse `provider:model` into parts. Returns null on malformed input. */
function parseModelId(id: string): { provider: string; model: string } | null {
  const idx = id.indexOf(":");
  if (idx <= 0 || idx === id.length - 1) return null;
  return { provider: id.slice(0, idx), model: id.slice(idx + 1) };
}

/**
 * Check whether credentials for `provider` are available.
 * `LITELLM_API_KEY` universally satisfies any provider (matches smallLLM's
 * historical behavior and supports proxy-everything LiteLLM setups) —
 * except `local`, where the credential is a base URL pointing at the
 * user's own server and a remote LiteLLM proxy can't substitute.
 */
function hasCredential(provider: string): boolean {
  if (provider === "local") return !!process.env.LOCAL_BASE_URL;
  if (process.env.LITELLM_API_KEY) return true;
  if (ALWAYS_CREDENTIALED.has(provider)) return true;
  if (!isRegistryProvider(provider)) return false;
  if (!hasEnvVar(provider)) return true;
  const envVar = PROVIDER_ENV_VARS[provider];
  return !!process.env[envVar];
}

type ErrorKind = "format" | "unknown_provider" | "missing_credential" | "unknown_image_model";

interface ResolutionError {
  role: PlatformRole;
  kind: ErrorKind;
  value: string;
  detail: string;
}

/**
 * Thrown by `createPlatformModels` when the resolved configuration is invalid.
 * Aggregates errors across every role (four language + image) so operators
 * see every problem in one startup attempt.
 */
export class PlatformModelsConfigError extends Error {
  public readonly errors: readonly ResolutionError[];

  constructor(errors: readonly ResolutionError[]) {
    super(PlatformModelsConfigError.formatMessage(errors));
    this.name = "PlatformModelsConfigError";
    this.errors = errors;
  }

  private static formatMessage(errors: readonly ResolutionError[]): string {
    const lines = ["Platform model configuration failed validation:", ""];
    for (const err of errors) {
      lines.push(`friday.yml: models.${err.role}: ${err.detail}`);
      lines.push(`  configured value: "${err.value}"`);
      if (err.kind === "unknown_provider") {
        lines.push(`  known providers: ${REGISTRY_PROVIDERS.join(", ")}`);
      } else if (err.kind === "unknown_image_model") {
        const knownIds = listImageEntries().map((e) => e.id);
        lines.push(`  known image models: ${knownIds.join(", ")}`);
      } else if (err.kind === "missing_credential") {
        const parsed = parseModelId(err.value);
        if (parsed?.provider === "local") {
          lines.push(
            `  required env var: LOCAL_BASE_URL (e.g., http://localhost:1234/v1 for LM Studio)`,
          );
        } else if (parsed && isRegistryProvider(parsed.provider) && hasEnvVar(parsed.provider)) {
          const envVar = PROVIDER_ENV_VARS[parsed.provider];
          lines.push(`  required env var: ${envVar} (or LITELLM_API_KEY for proxied access)`);
        }
      }
      lines.push("");
    }
    return lines.join("\n");
  }
}

/**
 * Resolve a single role.
 *
 * Three shapes for `userValue`:
 * - `undefined`: no user config, walk the default chain for this role.
 * - `string`: back-compat single-model config. Strict — unknown provider,
 *   format errors, or missing credentials fail startup.
 * - `string[]`: explicit primary → fallback_n chain. Tries each entry in
 *   order and returns the first credentialed one. Format errors on ANY
 *   entry are strict (typo'd id is never silently skipped). Missing
 *   credentials are tolerated as long as at least one entry has them;
 *   if the whole user chain is uncredentialed, the default chain takes
 *   over, same as if no user config were provided.
 *
 * Returns the pre-traced model on success, or null (and pushes into
 * `errors`) on failure. Default-chain resolution also returns null + pushes
 * a missing_credential error when no entry in the chain is credentialed.
 */
function resolveRole(
  role: LanguageRole,
  userValue: string | readonly string[] | undefined,
  errors: ResolutionError[],
): LanguageModelV3 | null {
  if (userValue !== undefined) {
    const chain: readonly string[] = typeof userValue === "string" ? [userValue] : userValue;

    // Pre-flight: every entry must at least parse and name a known
    // provider. A typo or unknown-provider in a chain is always an error;
    // silently skipping bad entries would mask user mistakes.
    for (const entry of chain) {
      const parsed = parseModelId(entry);
      if (!parsed) {
        errors.push({
          role,
          kind: "format",
          value: entry,
          detail: "must be in 'provider:model' format (e.g., 'anthropic:claude-haiku-4-5')",
        });
        return null;
      }
      if (!isRegistryProvider(parsed.provider)) {
        errors.push({
          role,
          kind: "unknown_provider",
          value: entry,
          detail: `provider '${parsed.provider}' is not registered`,
        });
        return null;
      }
    }

    // Walk the chain and pick the first credentialed entry. For a
    // single-element chain this collapses to the old strict behavior
    // (one entry, one credential check, error if missing).
    for (const entry of chain) {
      const parsed = parseModelId(entry);
      if (parsed && isRegistryProvider(parsed.provider) && hasCredential(parsed.provider)) {
        return traceModel(
          registry.languageModel(buildRegistryModelId(parsed.provider, parsed.model)),
        );
      }
    }

    // Chain exhausted with no credentials. For a 1-element chain we treat
    // this as a hard error on the single value (matches prior strict
    // behavior). For a multi-element chain we silently fall through to
    // the default chain — the user asked for fallbacks, so failing over
    // to the system default is the next-most-reasonable behavior.
    if (chain.length === 1) {
      const entry = chain[0];
      if (entry !== undefined) {
        errors.push({
          role,
          kind: "missing_credential",
          value: entry,
          detail: "missing credentials",
        });
        return null;
      }
    }
    // Multi-entry chain exhausted → continue to default chain below.
  }

  const chain = DEFAULT_PLATFORM_MODELS[role];
  for (const candidate of chain) {
    const parsed = parseModelId(candidate);
    if (parsed && isRegistryProvider(parsed.provider) && hasCredential(parsed.provider)) {
      return traceModel(
        registry.languageModel(buildRegistryModelId(parsed.provider, parsed.model)),
      );
    }
  }

  const fallback = chain[chain.length - 1] ?? "";
  errors.push({
    role,
    kind: "missing_credential",
    value: fallback,
    detail: "missing credentials (no default chain entry had credentials available)",
  });
  return null;
}

/**
 * Image-role sibling of `resolveRole`. Same chain-walk semantics — primary
 * → fallback_n, format/unknown-provider/overlay strict, credential-missing
 * tolerant across multi-entry chains, fall through to
 * `DEFAULT_PLATFORM_MODELS.image` when the user chain is fully uncredentialed
 * — but constructs the model via `registry.imageModel(id)` and returns
 * `ImageModelV3`.
 *
 * Forked from `resolveRole` rather than parameterized because the language
 * path threads through `traceModel(...)` (LanguageModelV3-specific) and the
 * image path doesn't. Generic abstraction at two callers buys less than it
 * costs.
 *
 * The overlay check (`unknown_image_model`) here is a defensive last line:
 * boot-time pre-flight (`preflightImageRoleAtBoot`) already proved every
 * chain entry is in `IMAGE_OVERLAY`, but hot-reload or test-injection paths
 * could feed a post-boot config that wasn't validated, and we'd rather error
 * cleanly than build a registry model for an unverified id.
 */
/**
 * Resolved image-role pair: the SDK model and the `provider:model` spec
 * string that produced it. The spec doubles as the capability overlay key —
 * callers needing overlay metadata use `key`, callers calling generateImage
 * use `model`. Both halves come from a single resolver pass so they can't
 * diverge if `process.env` flips between two separate lookups.
 */
type ResolvedImage = { key: string; model: ImageModelV3 };

function resolveImageRole(
  userValue: string | readonly string[] | undefined,
  errors: ResolutionError[],
): ResolvedImage | null {
  if (userValue !== undefined) {
    const chain: readonly string[] = typeof userValue === "string" ? [userValue] : userValue;

    for (const entry of chain) {
      const parsed = parseModelId(entry);
      if (!parsed) {
        errors.push({
          role: "image",
          kind: "format",
          value: entry,
          detail: "must be in 'provider:model' format (e.g., 'google:gemini-2.5-flash-image')",
        });
        return null;
      }
      if (!isRegistryProvider(parsed.provider)) {
        errors.push({
          role: "image",
          kind: "unknown_provider",
          value: entry,
          detail: `provider '${parsed.provider}' is not registered`,
        });
        return null;
      }
      if (!lookupImageEntry(entry)) {
        errors.push({
          role: "image",
          kind: "unknown_image_model",
          value: entry,
          detail: `'${entry}' is not in Friday's verified image-model overlay`,
        });
        return null;
      }
    }

    for (const entry of chain) {
      const parsed = parseModelId(entry);
      if (parsed && isRegistryProvider(parsed.provider) && hasCredential(parsed.provider)) {
        return {
          key: entry,
          model: registry.imageModel(buildRegistryModelId(parsed.provider, parsed.model)),
        };
      }
    }

    if (chain.length === 1) {
      const entry = chain[0];
      if (entry !== undefined) {
        errors.push({
          role: "image",
          kind: "missing_credential",
          value: entry,
          detail: "missing credentials",
        });
        return null;
      }
    }
    // Multi-entry chain exhausted → continue to default chain below.
  }

  const chain = DEFAULT_PLATFORM_MODELS.image;
  for (const candidate of chain) {
    const parsed = parseModelId(candidate);
    if (parsed && isRegistryProvider(parsed.provider) && hasCredential(parsed.provider)) {
      return {
        key: candidate,
        model: registry.imageModel(buildRegistryModelId(parsed.provider, parsed.model)),
      };
    }
  }

  const fallback = chain[chain.length - 1] ?? "";
  errors.push({
    role: "image",
    kind: "missing_credential",
    value: fallback,
    detail: "missing credentials (no default chain entry had credentials available)",
  });
  return null;
}

/**
 * Resolve a single `"provider:modelId"` string into a traced `LanguageModelV3`,
 * using the same provider registry and credential machinery as
 * `createPlatformModels`. Designed for per-request overrides (e.g. a chat-send
 * model picker) where the caller already has a fully-qualified spec rather
 * than a role.
 *
 * Throws a plain `Error` with a descriptive message on:
 *   - format errors (missing/empty halves around the colon)
 *   - unknown provider (not in `REGISTRY_PROVIDERS`)
 *   - missing credentials for the named provider
 */
export function resolveModelFromString(spec: string): LanguageModelV3 {
  const parsed = parseModelId(spec);
  if (!parsed) {
    throw new Error(
      `Invalid model spec "${spec}": must be in 'provider:model' format (e.g., 'anthropic:claude-sonnet-4-6')`,
    );
  }
  if (!isRegistryProvider(parsed.provider)) {
    throw new Error(
      `Invalid model spec "${spec}": unknown provider '${parsed.provider}'. Known providers: ${REGISTRY_PROVIDERS.join(", ")}`,
    );
  }
  if (!hasCredential(parsed.provider)) {
    const envVar = hasEnvVar(parsed.provider) ? PROVIDER_ENV_VARS[parsed.provider] : null;
    const detail = envVar
      ? `set ${envVar} (or LITELLM_API_KEY for proxied access)`
      : `credentials unavailable`;
    throw new Error(`Invalid model spec "${spec}": missing credentials — ${detail}`);
  }
  return traceModel(registry.languageModel(buildRegistryModelId(parsed.provider, parsed.model)));
}

/**
 * Boot-time pre-flight for `models.image`. Validates that every chain entry
 * parses, names a known provider, and has an `IMAGE_OVERLAY` entry. Does NOT
 * resolve credentials — those are checked lazily by `getImage()` so a daemon
 * can boot without every overlay provider's key present and only fail when
 * image-gen is actually invoked.
 *
 * Pushes errors into the shared `bootErrors` array so image problems aggregate
 * with language-role problems into a single `PlatformModelsConfigError`.
 * Returns on the first bad entry in a chain (matches per-role behavior of
 * `resolveRole` — within a role, first error wins; across roles, all errors
 * surface).
 */
function preflightImageRoleAtBoot(
  userValue: string | readonly string[] | undefined,
  errors: ResolutionError[],
): void {
  if (userValue === undefined) return;
  const chain: readonly string[] = typeof userValue === "string" ? [userValue] : userValue;
  for (const entry of chain) {
    const parsed = parseModelId(entry);
    if (!parsed) {
      errors.push({
        role: "image",
        kind: "format",
        value: entry,
        detail: "must be in 'provider:model' format (e.g., 'google:gemini-2.5-flash-image')",
      });
      return;
    }
    if (!isRegistryProvider(parsed.provider)) {
      errors.push({
        role: "image",
        kind: "unknown_provider",
        value: entry,
        detail: `provider '${parsed.provider}' is not registered`,
      });
      return;
    }
    if (!lookupImageEntry(entry)) {
      errors.push({
        role: "image",
        kind: "unknown_image_model",
        value: entry,
        detail: `'${entry}' is not in Friday's verified image-model overlay`,
      });
      return;
    }
  }
}

/**
 * Construct a `PlatformModels` resolver from optional friday.yml configuration.
 *
 * Boot validates every role eagerly and aggregates errors into a single
 * `PlatformModelsConfigError` so bad config fails fast. `get(role)` then
 * re-resolves on every call so a runtime `process.env` mutation reaches
 * the daemon's LLM call sites without a restart.
 *
 * The image role uses a different boot-validation shape than the four
 * language roles: language roles eagerly resolve (including credentials)
 * because their defaults always require keys; the image role only pre-flights
 * format/provider/overlay membership and defers credential checks to
 * `getImage()`. This keeps daemons bootable when image providers are
 * intentionally unset, while still catching typos in `models.image`.
 */
export function createPlatformModels(config: PlatformModelsInput | null): PlatformModels {
  // Mutable so `reload()` can swap in a new config without invalidating
  // long-lived references held by workspace runtimes, MCP servers, and
  // route handlers. The closure-captured cell is the only path through
  // which `get`/`getImage`/`getImageOverlayKey` read user config.
  let userConfig = config?.models;

  /**
   * Eagerly validate every role and log each resolved language model.
   * Reused by boot and `reload()` so both paths share identical semantics:
   * any aggregated `PlatformModelsConfigError` aborts without mutating
   * state, success logs the per-role resolution.
   */
  const validateAndLog = (candidate: PlatformModelsInput["models"] | undefined): void => {
    const roles: LanguageRole[] = ["labels", "classifier", "planner", "conversational"];
    const errors: ResolutionError[] = [];
    for (const role of roles) {
      const result = resolveRole(role, candidate?.[role], errors);
      if (result) {
        logger.info("Platform model resolved", {
          role,
          provider: result.provider,
          modelId: result.modelId,
        });
      }
    }
    preflightImageRoleAtBoot(candidate?.image, errors);
    if (errors.length > 0) {
      throw new PlatformModelsConfigError(errors);
    }
  };

  validateAndLog(userConfig);

  return {
    get(role: LanguageRole): LanguageModelV3 {
      const errors: ResolutionError[] = [];
      const result = resolveRole(role, userConfig?.[role], errors);
      if (!result) {
        throw new PlatformModelsConfigError(errors);
      }
      return result;
    },
    getImage(): ImageModelV3 {
      const errors: ResolutionError[] = [];
      const result = resolveImageRole(userConfig?.image, errors);
      if (!result) {
        throw new PlatformModelsConfigError(errors);
      }
      logger.info("Image model resolved", {
        key: result.key,
        provider: result.model.provider,
        modelId: result.model.modelId,
      });
      return result.model;
    },
    getImageOverlayKey(): string {
      const errors: ResolutionError[] = [];
      const result = resolveImageRole(userConfig?.image, errors);
      if (!result) {
        throw new PlatformModelsConfigError(errors);
      }
      return result.key;
    },
    reload(input: PlatformModelsInput | null): void {
      // Re-validate against the candidate config BEFORE mutating the cell.
      // `validateAndLog` throws on any aggregated error, leaving `userConfig`
      // untouched — callers see the same `PlatformModelsConfigError` shape
      // they get at boot.
      validateAndLog(input?.models);
      userConfig = input?.models;
    },
  };
}
