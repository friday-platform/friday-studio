/**
 * Classifies agents via direct registry lookup.
 *
 * Each capability ID is looked up in the bundled agents registry and MCP
 * servers registry. No keyword extraction or fuzzy matching — IDs are
 * exact matches against registry keys.
 */

import type { BundledAgentConfigField } from "@atlas/bundled-agents/registry";
import { bundledAgentsRegistry } from "@atlas/bundled-agents/registry";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
import type { Agent } from "../types.ts";

// ---------------------------------------------------------------------------
// Clarification types
// ---------------------------------------------------------------------------

/** Classification issue for a single agent. */
export type AgentClarification = {
  agentId: string;
  agentName: string;
  capability: string;
  issue:
    | { type: "unknown-capability"; capabilityId: string }
    | { type: "mixed-bundled-mcp" }
    | { type: "multiple-bundled"; bundledIds: string[] };
};

/** A single required config field for an integration. */
export type ConfigRequirementField = {
  key: string;
  description: string;
  provider?: string;
  source: "env" | "link";
  /** Secret key to extract from the credential (e.g. 'access_token', 'key'). Only set for link sources. */
  secretKey?: string;
};

/** Config requirements for one agent's integration. */
export type ConfigRequirement = {
  agentId: string;
  agentName: string;
  integration: { type: "bundled"; bundledId: string } | { type: "mcp"; serverId: string };
  requiredConfig: ConfigRequirementField[];
};

/** Result of agent classification. */
export type ClassifyResult = {
  agents: Agent[];
  clarifications: AgentClarification[];
  configRequirements: ConfigRequirement[];
};

/** Options for classifyAgents. */
export type ClassifyOpts = {
  /** Runtime-registered MCP servers from KV (not in the static registry). */
  dynamicServers?: MCPServerMetadata[];
};

// ---------------------------------------------------------------------------
// Config requirement extraction
// ---------------------------------------------------------------------------

/**
 * Extracts config requirements for a bundled agent from the registry.
 */
function extractBundledConfigRequirements(
  agent: Agent,
  bundledId: string,
): ConfigRequirement | undefined {
  const entry = bundledAgentsRegistry[bundledId];
  if (!entry?.requiredConfig?.length) return undefined;

  const fields: ConfigRequirementField[] = entry.requiredConfig.map(
    (field: BundledAgentConfigField) => {
      if (field.from === "link") {
        return {
          key: field.envKey,
          description: field.description,
          provider: field.provider,
          source: "link" as const,
          secretKey: field.key,
        };
      }
      return { key: field.key, description: field.description, source: "env" as const };
    },
  );

  return {
    agentId: agent.id,
    agentName: agent.name,
    integration: { type: "bundled", bundledId },
    requiredConfig: fields,
  };
}

/**
 * Extracts config requirements for an MCP server.
 * Checks static registry first, falls back to provided metadata (for dynamic servers).
 * Cross-references `requiredConfig` keys with `configTemplate.env` to detect link-type credentials.
 */
function extractMCPConfigRequirements(
  agent: Agent,
  serverId: string,
  dynamicById?: Map<string, MCPServerMetadata>,
): ConfigRequirement | undefined {
  const serverMeta = mcpServersRegistry.servers[serverId] ?? dynamicById?.get(serverId);
  if (!serverMeta?.requiredConfig?.length) return undefined;

  const envEntries = serverMeta.configTemplate.env ?? {};

  const fields: ConfigRequirementField[] = serverMeta.requiredConfig.map((field) => {
    const envDef = envEntries[field.key];
    // Check if the env entry is a link credential ref (has `from: "link"`)
    if (envDef && typeof envDef === "object" && "from" in envDef && envDef.from === "link") {
      const provider =
        "provider" in envDef && typeof envDef.provider === "string" ? envDef.provider : undefined;
      const secretKey = "key" in envDef && typeof envDef.key === "string" ? envDef.key : undefined;
      return {
        key: field.key,
        description: field.description,
        provider,
        source: "link" as const,
        secretKey,
      };
    }
    return { key: field.key, description: field.description, source: "env" as const };
  });

  return {
    agentId: agent.id,
    agentName: agent.name,
    integration: { type: "mcp", serverId },
    requiredConfig: fields,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classifies agents via direct registry lookup on each capability ID.
 *
 * For each capability in an agent's `capabilities` array:
 * - Bundled agents registry hit → mark as bundled
 * - Static MCP servers registry hit → add to mcpServers
 * - Dynamic MCP server hit (from opts.dynamicServers) → add to mcpServers
 * - No match → emit unknown-capability clarification
 *
 * If an agent has both bundled and MCP capabilities, emits a
 * mixed-bundled-mcp clarification (mutual exclusivity constraint).
 *
 * @param agents - Phase 1 agents array
 * @param opts - Optional dynamic servers from KV registry
 * @returns Classified agents and any clarification issues found
 */
export function classifyAgents(agents: Agent[], opts?: ClassifyOpts): ClassifyResult {
  const clarifications: AgentClarification[] = [];
  const configRequirements: ConfigRequirement[] = [];

  const dynamicById = new Map<string, MCPServerMetadata>();
  for (const server of opts?.dynamicServers ?? []) {
    dynamicById.set(server.id, server);
  }

  for (const agent of agents) {
    if (agent.capabilities.length === 0) continue;

    const bundledIds: string[] = [];
    const mcpServers: Array<{ serverId: string; name: string }> = [];
    const unknownIds: string[] = [];

    for (const capabilityId of agent.capabilities) {
      if (bundledAgentsRegistry[capabilityId]) {
        bundledIds.push(capabilityId);
        continue;
      }

      const mcpServer = mcpServersRegistry.servers[capabilityId];
      if (mcpServer) {
        mcpServers.push({ serverId: mcpServer.id, name: mcpServer.name });
        continue;
      }

      const dynamicServer = dynamicById.get(capabilityId);
      if (dynamicServer) {
        mcpServers.push({ serverId: dynamicServer.id, name: dynamicServer.name });
        continue;
      }

      unknownIds.push(capabilityId);
    }

    if (bundledIds.length > 0 && mcpServers.length > 0) {
      // Emit unknown-capability clarifications first so users see the full picture
      for (const capabilityId of unknownIds) {
        clarifications.push({
          agentId: agent.id,
          agentName: agent.name,
          capability: capabilityId,
          issue: { type: "unknown-capability", capabilityId },
        });
      }
      clarifications.push({
        agentId: agent.id,
        agentName: agent.name,
        capability: agent.capabilities.join(", "),
        issue: { type: "mixed-bundled-mcp" },
      });
      continue;
    }

    if (bundledIds.length > 1) {
      // Emit unknown-capability clarifications first so users see the full picture
      for (const capabilityId of unknownIds) {
        clarifications.push({
          agentId: agent.id,
          agentName: agent.name,
          capability: capabilityId,
          issue: { type: "unknown-capability", capabilityId },
        });
      }
      clarifications.push({
        agentId: agent.id,
        agentName: agent.name,
        capability: agent.capabilities.join(", "),
        issue: { type: "multiple-bundled", bundledIds },
      });
      continue;
    }

    const singleBundled = bundledIds.length === 1 ? bundledIds[0] : undefined;
    if (singleBundled) {
      agent.bundledId = singleBundled;
      const req = extractBundledConfigRequirements(agent, singleBundled);
      if (req) configRequirements.push(req);
    } else if (mcpServers.length > 0) {
      agent.mcpServers = mcpServers;
      for (const server of mcpServers) {
        const req = extractMCPConfigRequirements(agent, server.serverId, dynamicById);
        if (req) configRequirements.push(req);
      }
    }

    for (const capabilityId of unknownIds) {
      clarifications.push({
        agentId: agent.id,
        agentName: agent.name,
        capability: capabilityId,
        issue: { type: "unknown-capability", capabilityId },
      });
    }
  }

  return { agents, clarifications, configRequirements };
}

/**
 * Formats config requirements into a human-readable report string.
 *
 * @param requirements - Config requirements to format
 * @returns Multi-line string, empty string if no requirements
 */
export function formatConfigRequirements(requirements: ConfigRequirement[]): string {
  if (requirements.length === 0) return "";

  const lines = ["Required configuration for this workspace:\n"];

  for (const req of requirements) {
    const intLabel =
      req.integration.type === "bundled"
        ? `bundled: ${req.integration.bundledId}`
        : `mcp: ${req.integration.serverId}`;
    lines.push(`  ${req.agentId} (${intLabel})`);
    for (const field of req.requiredConfig) {
      const sourceLabel =
        field.source === "link" && field.provider ? `link: ${field.provider}` : field.source;
      lines.push(`    - ${field.key} — ${field.description} [${sourceLabel}]`);
    }
  }

  return lines.join("\n");
}

/**
 * Formats clarifications into a human-readable report string.
 *
 * @param clarifications - Classification issues to format
 * @returns Multi-line string, empty string if no issues
 */
export function formatClarifications(clarifications: AgentClarification[]): string {
  if (clarifications.length === 0) return "";

  const lines = [`Agent classification issues (${clarifications.length}):\n`];

  // Group by agent for readability
  const byAgent = new Map<string, AgentClarification[]>();
  for (const c of clarifications) {
    const existing = byAgent.get(c.agentId) ?? [];
    existing.push(c);
    byAgent.set(c.agentId, existing);
  }

  for (const [agentId, issues] of byAgent) {
    lines.push(`  ${agentId}:`);
    for (const issue of issues) {
      if (issue.issue.type === "unknown-capability") {
        lines.push(`    capability "${issue.issue.capabilityId}" — not found in any registry`);
      } else if (issue.issue.type === "mixed-bundled-mcp") {
        lines.push(
          `    capabilities "${issue.capability}" — mixes bundled agent and MCP server IDs`,
        );
      } else if (issue.issue.type === "multiple-bundled") {
        lines.push(
          `    capabilities "${issue.capability}" — uses multiple bundled agents (${issue.issue.bundledIds.join(", ")}), split into separate agents`,
        );
      }
    }
  }

  return lines.join("\n");
}
