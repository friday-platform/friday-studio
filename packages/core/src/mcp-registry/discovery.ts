import process from "node:process";
import type { LinkCredentialRef } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import type { MCPServerConfig, WorkspaceConfig } from "@atlas/config";
import { mcpServersRegistry } from "./registry-consolidated.ts";
import type { MCPServerMetadata } from "./schemas.ts";
import { getMCPRegistryAdapter } from "./storage/index.ts";

/** Minimal Link summary shape needed for credential checks */
export interface LinkSummary {
  providers: Array<{ id: string }>;
  credentials: Array<{ provider: string }>;
}

/** Enriched MCP server candidate for discovery consumers */
export interface MCPServerCandidate {
  metadata: MCPServerMetadata;
  mergedConfig: MCPServerConfig;
  configured: boolean;
}

/**
 * Discover all MCP servers available to a workspace.
 *
 * Enumerates static blessed servers, registry-imported servers, and
 * workspace-configured servers. Merges workspace overrides onto matching
 * metadata configTemplate. Checks credentials via Link summary or process.env.
 * Returns at most 50 candidates.
 *
 * @throws When workspace config is needed (not passed) and the daemon fetch fails.
 */
export async function discoverMCPServers(
  workspaceId: string,
  workspaceConfig?: WorkspaceConfig,
  // Kept for back-compat with existing callers that pass a LinkSummary —
  // the field is no longer read. `configured` is now a workspace-config
  // completeness check; runtime credential health is surfaced separately
  // via `/internal/v1/credentials/:id` and tool I/O error envelopes.
  _linkSummary?: LinkSummary,
): Promise<MCPServerCandidate[]> {
  const config = workspaceConfig ?? (await fetchWorkspaceConfig(workspaceId));

  const staticServers = mcpServersRegistry.servers;
  const adapter = await getMCPRegistryAdapter();
  const registryServers = await adapter.list();
  const workspaceServers = config.tools?.mcp?.servers ?? {};

  const candidates = new Map<string, MCPServerCandidate>();

  // Static blessed servers
  for (const [id, metadata] of Object.entries(staticServers)) {
    const workspaceOverride = workspaceServers[id];
    const mergedConfig = applyPlatformEnv(
      workspaceOverride
        ? mergeServerConfig(metadata.configTemplate, workspaceOverride)
        : metadata.configTemplate,
      metadata.platformEnv,
    );

    candidates.set(id, { metadata, mergedConfig, configured: isConfigured(mergedConfig) });
  }

  // Registry-imported servers
  for (const metadata of registryServers) {
    // In-progress installs (doctor still running, or awaiting the user's
    // review) are not user-visible products yet — keep them out of the catalog.
    if (metadata.status === "setting_up" || metadata.status === "awaiting_confirm") {
      continue;
    }

    const workspaceOverride = workspaceServers[metadata.id];
    const mergedConfig = applyPlatformEnv(
      workspaceOverride
        ? mergeServerConfig(metadata.configTemplate, workspaceOverride)
        : metadata.configTemplate,
      metadata.platformEnv,
    );

    candidates.set(metadata.id, { metadata, mergedConfig, configured: isConfigured(mergedConfig) });
  }

  // Workspace-only servers
  for (const [id, workspaceServerConfig] of Object.entries(workspaceServers)) {
    if (candidates.has(id)) continue;

    const metadata: MCPServerMetadata = {
      id,
      name: id,
      source: "workspace",
      securityRating: "unverified",
      configTemplate: workspaceServerConfig,
      description: workspaceServerConfig.description,
    };

    candidates.set(id, {
      metadata,
      mergedConfig: workspaceServerConfig,
      configured: isConfigured(workspaceServerConfig),
    });
  }

  return Array.from(candidates.values()).slice(0, 50);
}

async function fetchWorkspaceConfig(workspaceId: string): Promise<WorkspaceConfig> {
  const response = await parseResult(
    client.workspace[":workspaceId"].config.$get({ param: { workspaceId } }),
  );
  if (!response.ok) {
    throw new Error(`Failed to fetch workspace config: ${String(response.error)}`);
  }
  return response.data.config as WorkspaceConfig;
}

function mergeServerConfig(base: MCPServerConfig, override: MCPServerConfig): MCPServerConfig {
  return { ...base, ...override, env: mergeEnv(base.env, override.env) };
}

/**
 * Merge registry-owned `platformEnv` into the runtime server config.
 * `platformEnv` forms the base; workspace `startup.env` takes precedence.
 * These vars are NOT serialized into workspace.yml — they live only in
 * registry metadata and are injected at runtime via this function.
 */
export function applyPlatformEnv(
  config: MCPServerConfig,
  platformEnv?: Record<string, string | LinkCredentialRef>,
): MCPServerConfig {
  if (!platformEnv || Object.keys(platformEnv).length === 0) return config;
  if (!config.startup) return config;
  return {
    ...config,
    startup: { ...config.startup, env: { ...platformEnv, ...config.startup.env } },
  };
}

function mergeEnv(
  base?: Record<string, string | LinkCredentialRef>,
  override?: Record<string, string | LinkCredentialRef>,
): Record<string, string | LinkCredentialRef> | undefined {
  if (!base && !override) return undefined;
  return { ...(base ?? {}), ...(override ?? {}) };
}

function isConfigured(config: MCPServerConfig): boolean {
  if (config.env) {
    for (const value of Object.values(config.env)) {
      if (!isEnvValueResolved(value)) {
        return false;
      }
    }
  }

  // Fallback for auth.token_env not declared in env
  if (config.auth?.token_env && !config.env?.[config.auth.token_env]) {
    const tokenValue = process.env[config.auth.token_env];
    if (!tokenValue || isPlaceholderValue(tokenValue)) {
      return false;
    }
  }

  return true;
}

function isEnvValueResolved(value: string | LinkCredentialRef): boolean {
  if (typeof value === "string") {
    return isResolvedStringEnvValue(value);
  }
  if (value.from === "link") {
    // `configured` is a workspace-config completeness check — does the env
    // wiring declare where to find a credential? — not a runtime health
    // check. A `from: link` ref is always "configured" at the wiring level
    // because it explicitly declares the credential source. Whether the
    // actual credential is currently usable (present, refreshable, not
    // expired) is a *runtime* concern surfaced via `/internal/v1/credentials/:id`
    // and the verbatim Link error string on tool I/O — not via this boolean.
    //
    // Earlier behavior conflated the two: it called `hasLinkCredential` on
    // a Link summary fetch and returned false when no credential existed,
    // which then misled the LLM ("configured: false" → "user needs to
    // connect") even when the credential was just transiently failing to
    // refresh.
    return true;
  }
  return false;
}

function isResolvedStringEnvValue(value: string): boolean {
  // `auto` / `from_environment` explicitly declare the value's source — the
  // process environment or the workspace `.env` overlay — the same way a
  // `from: link` ref declares Link. That makes the *wiring* complete, which
  // is all `configured` is meant to report. Whether the value is actually
  // present is a runtime concern: enforced overlay-aware by
  // `validateMCPEnvironmentForWorkspace` at spawn, and surfaced via tool I/O
  // errors. Resolving it here against `process.env` alone produced false
  // negatives — a server whose `from_environment` value lived in the
  // workspace `.env` (not `process.env`) showed `configured: false` and was
  // wrongly rejected by `delegate`, even though it ran fine at runtime.
  if (value === "auto" || value === "from_environment") {
    return true;
  }
  return !isPlaceholderValue(value);
}

function isPlaceholderValue(value: string): boolean {
  return value.startsWith("your-") || value.includes("<placeholder>") || value.includes("xxxx");
}
