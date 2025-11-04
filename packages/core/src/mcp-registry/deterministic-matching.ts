import type { BundledAgentConfigField } from "../bundled-agents/registry.ts";
import { bundledAgentsRegistry } from "../bundled-agents/registry.ts";
import { mcpServersRegistry } from "./registry-consolidated.ts";
import type { RequiredConfigField } from "./schemas.ts";

/**
 * Normalizes a need string for consistent matching.
 * Converts to lowercase, trims whitespace, and replaces underscores with hyphens.
 *
 * @param need - Raw need string from user input
 * @returns Normalized need string
 */
function normalizeNeed(need: string): string {
  return need.toLowerCase().trim().replace(/_/g, "-");
}

/**
 * Extracts known keywords from verbose need descriptions.
 * Used by workspace-creation to handle verbose needs from plans.
 *
 * Example: "Slack API access to post messages" → ["slack"]
 * Example: "github" → ["github"]
 *
 * @param need - Need string (can be keyword or verbose description)
 * @returns Array of known keywords found in the need
 */
export function extractKeywordsFromNeed(need: string): string[] {
  const normalized = normalizeNeed(need);
  const keywords: string[] = [];

  // Check bundled agent capabilities
  for (const agent of Object.values(bundledAgentsRegistry)) {
    for (const capability of agent.capabilities) {
      const capNormalized = normalizeNeed(capability);
      // Check if capability appears as a word in the need
      if (normalized === capNormalized || normalized.includes(capNormalized)) {
        keywords.push(capNormalized);
      }
    }
  }

  // Check MCP server domains
  for (const server of Object.values(mcpServersRegistry.servers)) {
    for (const domain of server.domains) {
      const domainNormalized = normalizeNeed(domain);
      if (normalized === domainNormalized || normalized.includes(domainNormalized)) {
        keywords.push(domainNormalized);
      }
    }
  }

  // If no keywords found, return the need itself (it might be a keyword)
  if (keywords.length === 0) {
    return [normalized];
  }

  // Remove duplicates
  return [...new Set(keywords)];
}

/**
 * Bundled agent match result
 */
export type BundledAgentMatch = {
  agentId: string;
  name: string;
  description: string;
  matchedCapabilities: string[];
  requiredConfig: BundledAgentConfigField[];
};

/**
 * MCP server match result
 */
export type MCPServerMatch = {
  serverId: string;
  name: string;
  matchedDomains: string[];
  requiredConfig: RequiredConfigField[];
};

/**
 * Matches agent needs to bundled agents using case-insensitive contains matching.
 * Returns all bundled agents that match ANY of the needs.
 *
 * Matching logic:
 * - Case-insensitive contains: need="slack" matches capability="Slack" or "slack-notifications"
 * - An agent matches if ANY of its capabilities contains ANY of the needs
 *
 * @param needs - Array of capability requirements from agent spec
 * @returns Array of matched bundled agents (0, 1, or multiple matches)
 */
export function matchBundledAgents(needs: string[]): BundledAgentMatch[] {
  if (needs.length === 0) {
    return [];
  }

  const needsLower = needs.map(normalizeNeed).filter((n) => n.length > 0);

  if (needsLower.length === 0) {
    return [];
  }

  const matches: BundledAgentMatch[] = [];

  for (const agent of Object.values(bundledAgentsRegistry)) {
    const matchedCapabilities: string[] = [];

    // Check each capability against all needs
    for (const capability of agent.capabilities) {
      const capabilityLower = capability.toLowerCase();

      // Check if any need exactly matches this capability
      for (const needLower of needsLower) {
        if (capabilityLower === needLower) {
          matchedCapabilities.push(capability);
          break; // Don't add same capability multiple times
        }
      }
    }

    // If any capabilities matched, include this agent
    if (matchedCapabilities.length > 0) {
      matches.push({
        agentId: agent.id,
        name: agent.name,
        description: agent.description,
        matchedCapabilities,
        requiredConfig: agent.requiredConfig,
      });
    }
  }

  return matches;
}

/**
 * Maps a single need to MCP servers using case-insensitive exact matching on domains.
 * Returns all MCP servers whose domains contain the need.
 *
 * Matching logic:
 * - Case-insensitive exact match: need="slack" matches domain="Slack" or "slack"
 * - Only checks domains (strict product matching)
 *
 * @param need - Single capability requirement
 * @returns Array of matched MCP servers (0, 1, or multiple matches)
 */
export function mapNeedToMCPServers(need: string): MCPServerMatch[] {
  if (!need || need.trim() === "") {
    return [];
  }

  const needLower = normalizeNeed(need);
  const matches: MCPServerMatch[] = [];

  for (const server of Object.values(mcpServersRegistry.servers)) {
    const matchedDomains: string[] = [];

    // Check domains (strict product matching)
    for (const domain of server.domains) {
      if (domain.toLowerCase() === needLower) {
        matchedDomains.push(domain);
      }
    }

    // If any domains matched, include this server
    if (matchedDomains.length > 0) {
      matches.push({
        serverId: server.id,
        name: server.name,
        matchedDomains,
        requiredConfig: server.requiredConfig || [],
      });
    }
  }

  return matches;
}

/**
 * Finds needs that have no matching bundled agent or MCP server.
 *
 * @param needs - Original needs from agent spec
 * @param bundledMatches - Matched bundled agents
 * @param mcpMatchesByNeed - Map of need → MCP server matches
 * @returns Array of unmatched needs
 */
export function findUnmatchedNeeds(
  needs: string[],
  bundledMatches: BundledAgentMatch[],
  mcpMatchesByNeed: Map<string, MCPServerMatch[]>,
): string[] {
  // If we have a bundled match, all needs are satisfied
  if (bundledMatches.length > 0) {
    return [];
  }

  // Check which needs have no MCP matches
  const unmatched: string[] = [];

  for (const need of needs) {
    const mcpMatches = mcpMatchesByNeed.get(need);
    if (!mcpMatches || mcpMatches.length === 0) {
      unmatched.push(need);
    }
  }

  return unmatched;
}
