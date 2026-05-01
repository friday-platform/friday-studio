/**
 * Derives integration data (credentials + MCP servers) from workspace configuration.
 *
 * Pure function — no side effects. Extracts credential references grouped by provider
 * and MCP server configurations with agent assignments.
 */

import type { WorkspaceConfig } from "../workspace.ts";

// ==============================================================================
// TYPES
// ==============================================================================

/** A credential reference grouped by provider and env key across agents. */
export interface IntegrationCredential {
  /** Provider name (e.g., "anthropic", "github") or credential ID fallback */
  provider: string;
  /** Environment variable name (e.g., "ANTHROPIC_API_KEY") */
  envKey: string;
  /** Agent IDs that reference this credential */
  agentIds: string[];
  /** Credential status — v1 always "declared" (no live checking) */
  status: "declared";
}

/** An MCP server extracted from workspace tools config. */
export interface IntegrationMCPServer {
  /** Server name from config */
  name: string;
  /** Transport type ("stdio" | "http") */
  transport: string;
  /** Number of tools exposed (from allow list length, or 0 if unknown) */
  toolCount: number;
  /** Agent IDs with access to this server */
  agentIds: string[];
}

/** Result of deriving integrations from workspace config. */
export interface IntegrationsData {
  credentials: IntegrationCredential[];
  mcpServers: IntegrationMCPServer[];
}

// ==============================================================================
// HELPERS
// ==============================================================================

interface LinkRef {
  from: "link";
  provider?: string;
  id?: string;
  key: string;
}

/**
 * Type guard for LinkCredentialRef-shaped env values.
 */
function isLinkCredentialRef(value: unknown): value is LinkRef {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return obj.from === "link" && typeof obj.key === "string";
}

// ==============================================================================
// DERIVATION
// ==============================================================================

/**
 * Derives integration data from workspace configuration.
 *
 * Walks agent env vars for credential references (grouped by provider + env key),
 * and extracts MCP server configurations with agent assignments.
 *
 * @param config - Workspace configuration
 * @returns Credentials grouped by provider and MCP server configurations
 */
export function deriveIntegrations(config: WorkspaceConfig): IntegrationsData {
  const credentials = deriveCredentials(config);
  const mcpServers = deriveMCPServers(config);
  return { credentials, mcpServers };
}

/**
 * Extract and group credential references from atlas agent env vars.
 */
function deriveCredentials(config: WorkspaceConfig): IntegrationCredential[] {
  if (!config.agents) return [];

  // Group by "provider::envKey" composite key
  const groups = new Map<string, { provider: string; envKey: string; agentIds: string[] }>();

  for (const [agentId, agentConfig] of Object.entries(config.agents)) {
    if (agentConfig.type !== "atlas") continue;

    const env = agentConfig.env;
    if (!env) continue;

    for (const [envKey, envValue] of Object.entries(env)) {
      if (!isLinkCredentialRef(envValue)) continue;

      const provider = envValue.provider ?? envValue.id ?? envKey;
      const groupKey = `${provider}::${envKey}`;

      const existing = groups.get(groupKey);
      if (existing) {
        existing.agentIds.push(agentId);
      } else {
        groups.set(groupKey, { provider, envKey, agentIds: [agentId] });
      }
    }
  }

  return Array.from(groups.values()).map((group) => ({ ...group, status: "declared" as const }));
}

/**
 * Extract MCP server configurations and resolve agent assignments.
 */
function deriveMCPServers(config: WorkspaceConfig): IntegrationMCPServer[] {
  const servers = config.tools?.mcp?.servers;
  if (!servers) return [];

  // Build a map of server name → agent IDs from LLM agent tool references
  const serverAgentMap = buildServerAgentMap(config);

  return Object.entries(servers).map(([name, serverConfig]) => {
    const toolCount = serverConfig.tools?.allow?.length ?? 0;

    return {
      name,
      transport: serverConfig.transport.type,
      toolCount,
      agentIds: serverAgentMap.get(name) ?? [],
    };
  });
}

/**
 * Build a map from MCP server name to agent IDs that reference it.
 * LLM agents reference servers via their config.tools array.
 */
function buildServerAgentMap(config: WorkspaceConfig): Map<string, string[]> {
  const map = new Map<string, string[]>();

  if (!config.agents) return map;

  for (const [agentId, agentConfig] of Object.entries(config.agents)) {
    if (agentConfig.type !== "llm") continue;

    const tools = agentConfig.config.tools;
    if (!tools) continue;

    for (const toolName of tools) {
      const existing = map.get(toolName);
      if (existing) {
        existing.push(agentId);
      } else {
        map.set(toolName, [agentId]);
      }
    }
  }

  return map;
}
