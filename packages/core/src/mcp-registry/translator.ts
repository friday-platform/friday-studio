/**
 * Pure translator from upstream registry format to MCPServerMetadata.
 *
 * Follows the transport precedence rules from design doc § Module Boundaries / Translator:
 * 1. npm+stdio wins → npx -y <identifier>@<version>
 * 2. streamable-http with no unresolved URL vars → http transport
 * 3. Everything else rejects
 *
 * @module
 */

import { createLogger } from "@atlas/logger";
import { getAnnotation } from "./annotations.ts";
import { buildBearerAuthConfig } from "./auth-config.ts";
import { type RoutableEnvVar, routeEnvVars } from "./env-routing.ts";
import type { MCPServerMetadata } from "./schemas.ts";
import type { UpstreamServerEntry } from "./upstream-client.ts";

/**
 * Per-field metadata for a Link provider's `secretSchema`. Replaces the older
 * `"string"` shorthand: carries `isRequired` / `isSecret` so the credential
 * form can render required-vs-optional and secret-vs-plaintext correctly, plus
 * an optional `description` for label text.
 */
export type SecretFieldDescriptor = {
  type: "string";
  isRequired?: boolean;
  isSecret?: boolean;
  description?: string;
};

/** Wire-safe input for dynamic API key providers (Link auto-creation). */
export type DynamicApiKeyProviderInput = {
  type: "apikey";
  id: string;
  displayName: string;
  description: string;
  secretSchema: Record<string, SecretFieldDescriptor>;
  setupInstructions?: string;
};

/** Wire-safe input for dynamic OAuth providers (Link auto-creation, discovery mode only). */
export type DynamicOAuthProviderInput = {
  type: "oauth";
  id: string;
  displayName: string;
  description: string;
  oauthConfig: { mode: "discovery"; serverUrl: string; scopes?: string[] };
};

/** Union of dynamic provider inputs for Link auto-creation. */
export type DynamicProviderInput = DynamicApiKeyProviderInput | DynamicOAuthProviderInput;

const logger = createLogger({ name: "mcp-registry-translator" });

/**
 * Result of translation - discriminated union.
 */
export type TranslateResult =
  | { success: true; entry: MCPServerMetadata; linkProvider?: DynamicProviderInput }
  | { success: false; reason: string };

/** Options for {@link translate}. */
export interface TranslateOptions {
  /**
   * Env vars from outside the registry entry — the doctor's extracted list, or
   * the user's manual-config / commit input. Used only when the registry
   * declares no env vars of its own; registry-declared always wins.
   */
  extraEnvVars?: RoutableEnvVar[];
}

/**
 * Derive kebab-case ID from canonical name.
 * Rules: dots/slashes → dashes, lowercase, truncate at 64 chars.
 */
export function deriveId(canonicalName: string): string {
  return canonicalName.toLowerCase().replace(/[./]/g, "-").slice(0, 64);
}

/**
 * Substitute URL template variables.
 * Variables with `default` are substituted; required-without-default → returns null (rejected).
 */
function substituteUrlVariables(
  url: string,
  variables:
    | Record<string, { description?: string; isRequired?: boolean; default?: string }>
    | undefined,
): { url: string; rejected: false } | { rejected: true; missingVar: string } {
  if (!variables) {
    return { url, rejected: false };
  }

  let result = url;
  for (const [varName, varDef] of Object.entries(variables)) {
    const placeholder = `{${varName}}`;
    if (!result.includes(placeholder)) continue;

    if (varDef.default !== undefined) {
      result = result.replaceAll(placeholder, varDef.default);
    } else if (varDef.isRequired) {
      return { rejected: true, missingVar: varName };
    }
    // Optional without default: leave as-is (will be stripped if still present at end)
  }

  // Check for any remaining unresolved template variables
  const remainingVars = result.match(/\{[a-zA-Z0-9_]+\}/g);
  if (remainingVars) {
    // If any remaining, they must be optional without defaults - we can leave them
    // but for v1 we reject as per design doc
    return { rejected: true, missingVar: remainingVars[0].slice(1, -1) };
  }

  return { url: result, rejected: false };
}

/**
 * Build a `DynamicApiKeyProviderInput` from the routed credential env vars.
 * Each var becomes one entry in `secretSchema` with `isRequired` / `isSecret`
 * defaulted to concrete booleans (never undefined) so the wire JSON is
 * unambiguous, plus `description` only when the upstream var provided one.
 */
function buildApiKeyProvider(
  id: string,
  name: string,
  description: string | undefined,
  linkVars: RoutableEnvVar[],
): DynamicApiKeyProviderInput {
  const secretSchema: Record<string, SecretFieldDescriptor> = {};
  for (const v of linkVars) {
    const field: SecretFieldDescriptor = {
      type: "string",
      isRequired: v.isRequired ?? false,
      isSecret: v.isSecret ?? false,
    };
    if (v.description) {
      field.description = v.description;
    }
    secretSchema[v.name] = field;
  }
  return {
    type: "apikey",
    id,
    displayName: name.slice(0, 100),
    description: (description || name).slice(0, 200),
    secretSchema,
  };
}

function buildOAuthProvider(
  id: string,
  name: string,
  description: string | undefined,
  serverUrl: string,
): DynamicOAuthProviderInput {
  return {
    type: "oauth",
    id,
    displayName: name.slice(0, 200),
    description: (description || name).slice(0, 200),
    oauthConfig: { mode: "discovery", serverUrl },
  };
}

/**
 * Check if a remote has Smithery-style auth headers (non-user-configurable).
 * These are headers where the value is pre-configured (not user input).
 */
function hasSmitheryOnlyHeaders(remote: {
  headers?: Array<{ name: string; value?: string }>;
}): boolean {
  if (!remote.headers || remote.headers.length === 0) return false;
  // If all headers have a pre-set value (Smithery-style), it's not user-configurable
  return remote.headers.every((h: { value?: string }) => h.value !== undefined && h.value !== "");
}

/**
 * Translate an upstream server entry to MCPServerMetadata.
 *
 * This is a pure function - no side effects, no external dependencies.
 */
export function translate(
  upstreamEntry: UpstreamServerEntry,
  opts?: TranslateOptions,
): TranslateResult {
  const { server, _meta } = upstreamEntry;

  // Validate required fields
  if (!server.version) {
    return { success: false, reason: "Upstream entry missing required field: version" };
  }

  const id = deriveId(server.name);

  // Apply the curated annotation overlay, if any.
  const annotation = getAnnotation(server.name);
  const displayName = annotation?.displayName ?? server.name;
  const effectiveProviderId = annotation?.providerId ?? id;

  // Env vars to route: registry-declared wins; doctor-extracted fills in only
  // when the registry declared none of its own.
  const declaredEnvVars = (server.packages ?? []).flatMap((p) => p.environmentVariables ?? []);
  const envVars = declaredEnvVars.length > 0 ? declaredEnvVars : (opts?.extraEnvVars ?? []);

  // Determine transport per precedence rules
  // Rule 1: a locally-runnable stdio package wins — npm via npx, PyPI via uvx.
  // npm is preferred when an entry offers both.
  const npmStdioPackage = server.packages?.find(
    (p) => p.registryType === "npm" && p.transport.type === "stdio",
  );
  const pypiStdioPackage = server.packages?.find(
    (p) => p.registryType === "pypi" && p.transport.type === "stdio",
  );
  const stdioPackage = npmStdioPackage ?? pypiStdioPackage;

  if (stdioPackage) {
    // npm → `npx -y pkg@version`; PyPI → `uvx pkg==version`.
    const command = npmStdioPackage ? "npx" : "uvx";
    const args = npmStdioPackage
      ? ["-y", `${stdioPackage.identifier}@${server.version}`]
      : [`${stdioPackage.identifier}==${server.version}`];

    const { requiredConfig, env, linkVars } = routeEnvVars(envVars, effectiveProviderId);

    const linkProvider =
      !annotation?.providerId && linkVars.length > 0
        ? buildApiKeyProvider(id, server.name, server.description, linkVars)
        : undefined;

    const entry: MCPServerMetadata = {
      id,
      name: displayName,
      description: server.description,
      securityRating: "unverified",
      source: "registry",
      upstream: {
        canonicalName: server.name,
        version: server.version,
        updatedAt: _meta["io.modelcontextprotocol.registry/official"].updatedAt,
      },
      configTemplate: {
        transport: { type: "stdio", command, args },
        env: Object.keys(env).length > 0 ? env : undefined,
      },
      requiredConfig: requiredConfig.length > 0 ? requiredConfig : undefined,
    };

    return { success: true, entry, linkProvider };
  }

  // Rule 2: streamable-http with no unresolved URL variables
  const httpRemote = server.remotes?.find((r) => r.type === "streamable-http");

  if (httpRemote) {
    // Check for Smithery-only headers (non-user-configurable auth)
    if (hasSmitheryOnlyHeaders(httpRemote)) {
      return {
        success: false,
        reason:
          "This server uses Smithery authentication which requires manual configuration. Install from the repo.",
      };
    }

    // Substitute URL variables
    const urlResult = substituteUrlVariables(httpRemote.url, httpRemote.variables);
    if (urlResult.rejected) {
      return {
        success: false,
        reason: `This server requires configuration that can't be auto-filled (e.g., ${urlResult.missingVar}). Configure it manually or install from the repo.`,
      };
    }

    const { requiredConfig, env, linkVars } = routeEnvVars(envVars, effectiveProviderId);

    if (linkVars.length > 0) {
      // http remote with credential env vars → DynamicApiKeyProviderInput
      const entry: MCPServerMetadata = {
        id,
        name: displayName,
        description: server.description,
        securityRating: "unverified",
        source: "registry",
        upstream: {
          canonicalName: server.name,
          version: server.version,
          updatedAt: _meta["io.modelcontextprotocol.registry/official"].updatedAt,
        },
        configTemplate: { transport: { type: "http", url: urlResult.url }, env },
        requiredConfig: requiredConfig.length > 0 ? requiredConfig : undefined,
      };

      return {
        success: true,
        entry,
        linkProvider: annotation?.providerId
          ? undefined
          : buildApiKeyProvider(id, server.name, server.description, linkVars),
      };
    }

    // http remote without credential env vars → OAuth via Link provider.
    // Any optional non-secret plain strings still route alongside the
    // bearer-token ref so registry-declared settings aren't dropped.
    const {
      auth,
      env: oauthEnv,
      requiredConfig: oauthRequiredConfig,
    } = buildBearerAuthConfig(id, effectiveProviderId);

    const entry: MCPServerMetadata = {
      id,
      name: displayName,
      description: server.description,
      securityRating: "unverified",
      source: "registry",
      upstream: {
        canonicalName: server.name,
        version: server.version,
        updatedAt: _meta["io.modelcontextprotocol.registry/official"].updatedAt,
      },
      configTemplate: {
        transport: { type: "http", url: urlResult.url },
        env: { ...env, ...oauthEnv },
        auth,
      },
      requiredConfig: oauthRequiredConfig,
    };

    return {
      success: true,
      entry,
      linkProvider: annotation?.providerId
        ? undefined
        : buildOAuthProvider(id, server.name, server.description, urlResult.url),
    };
  }

  // Rule 3: Check for unsupported transports and provide specific rejection reasons
  const hasNpmNonStdio = server.packages?.some(
    (p) => p.registryType === "npm" && p.transport.type !== "stdio",
  );
  if (hasNpmNonStdio) {
    return {
      success: false,
      reason: `This server uses npm with unsupported transport (only stdio is supported). Install manually.`,
    };
  }

  const hasPypiNonStdio = server.packages?.some(
    (p) => p.registryType === "pypi" && p.transport.type !== "stdio",
  );
  if (hasPypiNonStdio) {
    return {
      success: false,
      reason: `This server uses PyPI with an unsupported transport (only stdio is supported). Install manually.`,
    };
  }

  const hasOci = server.packages?.some((p) => p.registryType === "oci");
  if (hasOci) {
    return {
      success: false,
      reason: `This server uses Docker/OCI which is not yet supported. Install manually.`,
    };
  }

  const hasSseRemote = server.remotes?.some((r) => r.type === "sse");
  if (hasSseRemote) {
    return {
      success: false,
      reason: `This server uses SSE transport which is not yet supported. Install manually.`,
    };
  }

  // No packages and no remotes
  if (
    (!server.packages || server.packages.length === 0) &&
    (!server.remotes || server.remotes.length === 0)
  ) {
    return {
      success: false,
      reason: `This server has no installable packages or remote endpoints. Install manually.`,
    };
  }

  // Fallthrough: transport not supported
  logger.warn("upstream entry has unsupported transport configuration", {
    name: server.name,
    packages: server.packages?.map((p) => `${p.registryType}/${p.transport.type}`),
    remotes: server.remotes?.map((r) => r.type),
  });

  return { success: false, reason: `This server's transport is not supported. Install manually.` };
}
