/**
 * Classifies Phase 1 agents as bundled or LLM-based.
 *
 * Three-tier resolution: direct MCP server ID match, bundled agent keyword
 * matching, then MCP server fallback. Collects clarifications for ambiguous
 * or unmatched needs and config requirements for resolved integrations.
 */

import type { BundledAgentConfigField } from "@atlas/bundled-agents/registry";
import { bundledAgentsRegistry } from "@atlas/bundled-agents/registry";
import type { MCPServerMatch } from "@atlas/core/mcp-registry/deterministic-matching";
import {
  extractKeywordsFromNeed,
  findUnmatchedNeeds,
  mapNeedToMCPServers,
  matchBundledAgents,
} from "@atlas/core/mcp-registry/deterministic-matching";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import type { Agent } from "../types.ts";

// ---------------------------------------------------------------------------
// Clarification types
// ---------------------------------------------------------------------------

/** Classification issue for a single agent need. */
export type AgentClarification = {
  agentId: string;
  agentName: string;
  need: string;
  issue:
    | { type: "ambiguous-bundled"; candidates: Array<{ id: string; name: string }> }
    | { type: "ambiguous-mcp"; candidates: Array<{ serverId: string; name: string }> }
    | { type: "no-match" };
};

/** A single required config field for an integration. */
export type ConfigRequirementField = {
  key: string;
  description: string;
  provider?: string;
  source: "env" | "link";
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

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const mcpServerIds = new Set(Object.keys(mcpServersRegistry.servers).map((id) => id.toLowerCase()));

/**
 * Returns true when any of the agent's raw needs exactly reference an MCP
 * server ID. In that case the agent should stay as an LLM agent wired to
 * that MCP server rather than being classified as a bundled agent.
 *
 * @param needs - Original needs from the agent spec
 */
function needsReferenceMCPServer(needs: string[]): boolean {
  return needs.some((n) =>
    mcpServerIds.has(
      n
        .toLowerCase()
        .trim()
        .replace(/[\s_]+/g, "-"),
    ),
  );
}

/**
 * Resolves MCP servers for an agent's needs and collects clarifications.
 * For each need, calls `mapNeedToMCPServers`:
 * - 1 match: collect the server
 * - 2+ matches: emit ambiguous-mcp clarification
 * - 0 matches: tracked by caller via findUnmatchedNeeds
 */
async function resolveMCPServersWithClarifications(
  agent: Agent,
  needs: string[],
): Promise<{
  servers: Array<{ serverId: string; name: string }>;
  clarifications: AgentClarification[];
}> {
  const seen = new Set<string>();
  const servers: Array<{ serverId: string; name: string }> = [];
  const clarifications: AgentClarification[] = [];

  for (const need of needs) {
    const matches = await mapNeedToMCPServers(need);
    if (matches.length === 1 && matches[0]) {
      const { serverId, name } = matches[0];
      if (!seen.has(serverId)) {
        seen.add(serverId);
        servers.push({ serverId, name });
      }
    } else if (matches.length > 1) {
      clarifications.push({
        agentId: agent.id,
        agentName: agent.name,
        need,
        issue: {
          type: "ambiguous-mcp",
          candidates: matches.map((m) => ({ serverId: m.serverId, name: m.name })),
        },
      });
    }
  }

  return { servers, clarifications };
}

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
 * Extracts config requirements for an MCP server from the registry.
 * Cross-references `requiredConfig` keys with `configTemplate.env` to detect link-type credentials.
 */
function extractMCPConfigRequirements(
  agent: Agent,
  serverId: string,
): ConfigRequirement | undefined {
  const serverMeta = mcpServersRegistry.servers[serverId];
  if (!serverMeta?.requiredConfig?.length) return undefined;

  const envEntries = serverMeta.configTemplate.env ?? {};

  const fields: ConfigRequirementField[] = serverMeta.requiredConfig.map((field) => {
    const envDef = envEntries[field.key];
    // Check if the env entry is a link credential ref (has `from: "link"`)
    if (envDef && typeof envDef === "object" && "from" in envDef && envDef.from === "link") {
      const linkRef = envDef as { from: "link"; provider: string; key: string };
      return {
        key: field.key,
        description: field.description,
        provider: linkRef.provider,
        source: "link" as const,
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
 * Classifies agents as bundled or MCP-backed using a three-tier approach:
 *
 * 1. **MCP server ID guard** — if any need references an MCP server ID directly
 *    (e.g. "google-gmail"), resolve MCP servers and skip bundled matching.
 * 2. **Bundled matching** — extract keywords, match against bundled agent registry.
 *    If exactly one bundled match, set `bundledId`.
 * 3. **MCP fallback** — if still unclassified, try MCP server matching as last resort.
 *
 * Collects clarifications for ambiguous or unmatched needs.
 *
 * @param agents - Phase 1 agents array
 * @returns Classified agents and any clarification issues found
 */
export async function classifyAgents(agents: Agent[]): Promise<ClassifyResult> {
  const clarifications: AgentClarification[] = [];
  const configRequirements: ConfigRequirement[] = [];

  for (const agent of agents) {
    // Tier 1: Needs reference an MCP server ID directly → resolve MCP servers, skip bundled
    if (needsReferenceMCPServer(agent.needs)) {
      const result = await resolveMCPServersWithClarifications(agent, agent.needs);
      clarifications.push(...result.clarifications);
      if (result.servers.length > 0) {
        agent.mcpServers = result.servers;
        for (const server of result.servers) {
          const req = extractMCPConfigRequirements(agent, server.serverId);
          if (req) configRequirements.push(req);
        }
      }

      // Check for unmatched needs (no bundled, so pass empty array)
      const mcpMatchesByNeed = new Map<string, MCPServerMatch[]>();
      for (const n of agent.needs) {
        mcpMatchesByNeed.set(n, await mapNeedToMCPServers(n));
      }
      const unmatched = findUnmatchedNeeds(agent.needs, [], mcpMatchesByNeed);
      for (const need of unmatched) {
        clarifications.push({
          agentId: agent.id,
          agentName: agent.name,
          need,
          issue: { type: "no-match" },
        });
      }
      continue;
    }

    // Tier 2: Keyword extraction → bundled agent matching
    const bundledMatches = matchBundledAgents(agent.needs.flatMap(extractKeywordsFromNeed));

    if (bundledMatches.length === 1 && bundledMatches[0]) {
      agent.bundledId = bundledMatches[0].agentId;
      const req = extractBundledConfigRequirements(agent, bundledMatches[0].agentId);
      if (req) configRequirements.push(req);
      continue;
    }

    if (bundledMatches.length > 1) {
      // Ambiguous bundled — report per-agent, not per-need
      clarifications.push({
        agentId: agent.id,
        agentName: agent.name,
        need: agent.needs.join(", "),
        issue: {
          type: "ambiguous-bundled",
          candidates: bundledMatches.map((m) => ({ id: m.agentId, name: m.name })),
        },
      });
      // Still fall through to MCP fallback — might resolve some needs
    }

    // Tier 3: No bundled match → try MCP server matching as fallback
    const result = await resolveMCPServersWithClarifications(agent, agent.needs);
    clarifications.push(...result.clarifications);
    if (result.servers.length > 0) {
      agent.mcpServers = result.servers;
      for (const server of result.servers) {
        const req = extractMCPConfigRequirements(agent, server.serverId);
        if (req) configRequirements.push(req);
      }
    }

    // Check for fully unmatched needs
    const mcpMatchesByNeed = new Map<string, Awaited<ReturnType<typeof mapNeedToMCPServers>>>();
    for (const n of agent.needs) {
      mcpMatchesByNeed.set(n, await mapNeedToMCPServers(n));
    }
    const unmatched = findUnmatchedNeeds(agent.needs, bundledMatches, mcpMatchesByNeed);
    for (const need of unmatched) {
      clarifications.push({
        agentId: agent.id,
        agentName: agent.name,
        need,
        issue: { type: "no-match" },
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
      if (issue.issue.type === "no-match") {
        lines.push(`    need "${issue.need}" — no matching integration found`);
      } else if (issue.issue.type === "ambiguous-bundled") {
        lines.push(`    needs "${issue.need}" — ambiguous, multiple bundled agents match:`);
        for (const c of issue.issue.candidates) {
          lines.push(`      - ${c.id}: ${c.name}`);
        }
      } else {
        lines.push(`    need "${issue.need}" — ambiguous, multiple MCP servers match:`);
        for (const c of issue.issue.candidates) {
          lines.push(`      - ${c.serverId}: ${c.name}`);
        }
      }
    }
  }

  return lines.join("\n");
}
