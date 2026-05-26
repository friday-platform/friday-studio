import process from "node:process";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { logger } from "@atlas/logger";
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
  };
}

/**
 * Task archetype for a platform LLM call site. Each role has distinct
 * failure-mode and call-pattern characteristics — see the design doc.
 */
export type PlatformRole = "labels" | "classifier" | "planner" | "conversational";

/**
 * Injected dependency providing pre-traced `LanguageModelV3` instances
 * for each platform task archetype. Constructed once per daemon at boot.
 */
export interface PlatformModels {
  get(role: PlatformRole): LanguageModelV3;
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
 * historical behavior and supports proxy-everything LiteLLM setups).
 */
function hasCredential(provider: string): boolean {
  if (process.env.LITELLM_API_KEY) return true;
  if (ALWAYS_CREDENTIALED.has(provider)) return true;
  if (!isRegistryProvider(provider)) return false;
  if (!hasEnvVar(provider)) return true;
  const envVar = PROVIDER_ENV_VARS[provider];
  return !!process.env[envVar];
}

type ErrorKind = "format" | "unknown_provider" | "missing_credential";

interface ResolutionError {
  role: PlatformRole;
  kind: ErrorKind;
  value: string;
  detail: string;
}

/**
 * Thrown by `createPlatformModels` when the resolved configuration is invalid.
 * Aggregates errors across all four roles so operators see every problem in
 * one startup attempt.
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
      } else if (err.kind === "missing_credential") {
        const parsed = parseModelId(err.value);
        if (parsed && isRegistryProvider(parsed.provider) && hasEnvVar(parsed.provider)) {
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
  role: PlatformRole,
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
 * Construct a `PlatformModels` resolver from optional friday.yml configuration.
 *
 * Boot validates every role eagerly and aggregates errors into a single
 * `PlatformModelsConfigError` so bad config fails fast. `get(role)` then
 * re-resolves on every call so a runtime `process.env` mutation reaches
 * the daemon's LLM call sites without a restart.
 */
export function createPlatformModels(config: PlatformModelsInput | null): PlatformModels {
  const userConfig = config?.models;
  const roles: PlatformRole[] = ["labels", "classifier", "planner", "conversational"];

  const bootErrors: ResolutionError[] = [];
  for (const role of roles) {
    const result = resolveRole(role, userConfig?.[role], bootErrors);
    if (result) {
      logger.info("Platform model resolved", {
        role,
        provider: result.provider,
        modelId: result.modelId,
      });
    }
  }
  if (bootErrors.length > 0) {
    throw new PlatformModelsConfigError(bootErrors);
  }

  return {
    get(role: PlatformRole): LanguageModelV3 {
      const errors: ResolutionError[] = [];
      const result = resolveRole(role, userConfig?.[role], errors);
      if (!result) {
        throw new PlatformModelsConfigError(errors);
      }
      return result;
    },
  };
}
