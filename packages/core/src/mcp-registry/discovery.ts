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
  linkSummary?: LinkSummary,
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
    const mergedConfig = workspaceOverride
      ? mergeServerConfig(metadata.configTemplate, workspaceOverride)
      : metadata.configTemplate;

    candidates.set(id, {
      metadata,
      mergedConfig,
      configured: isConfigured(mergedConfig, linkSummary),
    });
  }

  // Registry-imported servers
  for (const metadata of registryServers) {
    const workspaceOverride = workspaceServers[metadata.id];
    const mergedConfig = workspaceOverride
      ? mergeServerConfig(metadata.configTemplate, workspaceOverride)
      : metadata.configTemplate;

    candidates.set(metadata.id, {
      metadata,
      mergedConfig,
      configured: isConfigured(mergedConfig, linkSummary),
    });
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
      configured: isConfigured(workspaceServerConfig, linkSummary),
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

function mergeEnv(
  base?: Record<string, string | LinkCredentialRef>,
  override?: Record<string, string | LinkCredentialRef>,
): Record<string, string | LinkCredentialRef> | undefined {
  if (!base && !override) return undefined;
  return { ...(base ?? {}), ...(override ?? {}) };
}

function isConfigured(config: MCPServerConfig, linkSummary?: LinkSummary): boolean {
  if (config.env) {
    for (const [key, value] of Object.entries(config.env)) {
      if (!isEnvValueResolved(key, value, linkSummary)) {
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

function isEnvValueResolved(
  key: string,
  value: string | LinkCredentialRef,
  linkSummary?: LinkSummary,
): boolean {
  if (typeof value === "string") {
    return isResolvedStringEnvValue(key, value);
  }
  if (value.from === "link") {
    return hasLinkCredential(linkSummary, value.provider);
  }
  return false;
}

function isResolvedStringEnvValue(key: string, value: string): boolean {
  if (value === "auto" || value === "from_environment") {
    const envValue = process.env[key];
    return envValue !== undefined && !isPlaceholderValue(envValue);
  }
  return !isPlaceholderValue(value);
}

function hasLinkCredential(
  linkSummary: LinkSummary | undefined,
  provider: string | undefined,
): boolean {
  if (!linkSummary || !provider) return false;
  return linkSummary.credentials.some((c) => c.provider === provider);
}

function isPlaceholderValue(value: string): boolean {
  return value.startsWith("your-") || value.includes("<placeholder>") || value.includes("xxxx");
}
