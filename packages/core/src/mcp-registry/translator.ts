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

import type { LinkCredentialRef } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import { getOfficialOverride } from "./official-servers.ts";
import type { MCPServerMetadata, RequiredConfigField } from "./schemas.ts";
import type { UpstreamServer, UpstreamServerEntry } from "./upstream-client.ts";

/** Wire-safe input for dynamic API key providers (Link auto-creation). */
export type DynamicApiKeyProviderInput = {
  type: "apikey";
  id: string;
  displayName: string;
  description: string;
  secretSchema: Record<string, "string">;
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
 * Map upstream environment variables to RequiredConfigField and configTemplate.env.
 */
function mapEnvironmentVariables(
  packages: UpstreamServer["packages"],
  serverId: string,
  providerId?: string,
): { requiredConfig: RequiredConfigField[]; env: Record<string, string | LinkCredentialRef> } {
  const requiredConfig: RequiredConfigField[] = [];
  const env: Record<string, string | LinkCredentialRef> = {};

  for (const pkg of packages ?? []) {
    for (const ev of pkg.environmentVariables ?? []) {
      // Build description with placeholder in parens if present
      let description = ev.description ?? ev.name;
      if (ev.placeholder) {
        description = `${description} (e.g. ${ev.placeholder})`;
      }

      // Link credential reference in configTemplate.env
      env[ev.name] = { from: "link", provider: providerId ?? serverId, key: ev.name };

      // Required fields go into requiredConfig
      if (ev.isRequired) {
        const field: RequiredConfigField = { key: ev.name, description, type: "string" };
        if (ev.default !== undefined) {
          field.examples = [ev.default];
        }
        requiredConfig.push(field);
      }
    }
  }

  return { requiredConfig, env };
}

function buildApiKeyProvider(
  id: string,
  name: string,
  description: string | undefined,
  env: Record<string, string | LinkCredentialRef>,
): DynamicApiKeyProviderInput {
  const secretSchema: Record<string, "string"> = {};
  for (const key of Object.keys(env)) {
    secretSchema[key] = "string";
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
export function translate(upstreamEntry: UpstreamServerEntry): TranslateResult {
  const { server, _meta } = upstreamEntry;

  // Validate required fields
  if (!server.version) {
    return { success: false, reason: "Upstream entry missing required field: version" };
  }

  const id = deriveId(server.name);

  // Check for official override
  const official = getOfficialOverride(server.name);
  const displayName = official?.displayName ?? server.name;
  const effectiveProviderId = official?.providerId ?? id;

  // Determine transport per precedence rules
  // Rule 1: npm + stdio wins
  const npmStdioPackage = server.packages?.find(
    (p) => p.registryType === "npm" && p.transport.type === "stdio",
  );

  if (npmStdioPackage) {
    // Build npx command
    const command = "npx";
    const args = ["-y", `${npmStdioPackage.identifier}@${server.version}`];

    const { requiredConfig, env } = mapEnvironmentVariables(
      server.packages,
      id,
      effectiveProviderId,
    );

    const linkProvider =
      !official?.providerId && Object.keys(env).length > 0
        ? buildApiKeyProvider(id, server.name, server.description, env)
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

    const { requiredConfig, env } = mapEnvironmentVariables(
      server.packages,
      id,
      effectiveProviderId,
    );

    if (Object.keys(env).length > 0) {
      // http remote with env vars → DynamicApiKeyProviderInput
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
        linkProvider: official?.providerId
          ? undefined
          : buildApiKeyProvider(id, server.name, server.description, env),
      };
    }

    // http remote without env vars → OAuth via Link provider
    const tokenEnvKey = `${id.toUpperCase()}_ACCESS_TOKEN`;
    const oauthEnv: Record<string, string | LinkCredentialRef> = {
      [tokenEnvKey]: { from: "link", provider: effectiveProviderId, key: "access_token" },
    };

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
        env: oauthEnv,
        auth: { type: "bearer", token_env: tokenEnvKey },
      },
      requiredConfig: [
        {
          key: tokenEnvKey,
          description: `OAuth access token for ${displayName} from Link`,
          type: "string",
        },
      ],
    };

    return {
      success: true,
      entry,
      linkProvider: official?.providerId
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

  const hasPypi = server.packages?.some((p) => p.registryType === "pypi");
  if (hasPypi) {
    return {
      success: false,
      reason: `This server uses PyPI which is not yet supported. Install manually.`,
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
