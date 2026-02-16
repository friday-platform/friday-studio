import type { BundledAgentConfigField } from "@atlas/bundled-agents/registry";
import { bundledAgentsRegistry } from "@atlas/bundled-agents/registry";
import { createLogger } from "@atlas/logger";
import { mcpServersRegistry } from "./registry-consolidated.ts";
import type { MCPServerMetadata, RequiredConfigField } from "./schemas.ts";
import { getMCPRegistryAdapter } from "./storage/index.ts";

const logger = createLogger({ component: "mcp-registry:deterministic-matching" });

/**
 * Normalizes a need string for consistent matching.
 * Converts to lowercase, trims whitespace, and replaces spaces/underscores with hyphens.
 *
 * @param need - Raw need string from user input
 * @returns Normalized need string
 */
function normalizeNeed(need: string): string {
  return need
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-");
}

/**
 * Removes keywords that are substrings of other, more specific keywords.
 * Prevents "data" from surviving when "data-analysis" is also present,
 * since the longer match is strictly more specific.
 *
 * @param keywords - Deduplicated keyword list
 * @returns Filtered list with only the most specific keywords
 */
function removeSubsumedKeywords(keywords: string[]): string[] {
  return keywords.filter((kw) => !keywords.some((other) => other !== kw && other.includes(kw)));
}

/**
 * Extracts known keywords from verbose need descriptions.
 * Used by workspace-creation to handle verbose needs from plans.
 *
 * Example: "Slack API access to post messages" → ["slack"]
 * Example: "github" → ["github"]
 * Example: "data-analysis" → ["data-analysis"] (not ["data-analysis", "data"])
 *
 * When multiple keywords match, shorter keywords that are substrings of longer
 * matches are removed to avoid ambiguity (e.g., "data" is dropped when
 * "data-analysis" is present).
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

  // Remove duplicates, then drop less-specific keywords subsumed by longer ones
  return removeSubsumedKeywords([...new Set(keywords)]);
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
 * Minimum length for fuzzy substring matching.
 * Prevents false positives from very short strings (e.g., "a" matching everything).
 * Set to 3 to support short but valid domains like "rss".
 */
const MIN_FUZZY_MATCH_LENGTH = 3;

/**
 * Maps a single need to MCP servers using flexible matching on domains.
 * Returns all MCP servers whose domains match the need.
 * Includes both static servers from the registry and dynamic servers from storage.
 *
 * Matching logic (in order of priority):
 * 1. Exact match: need="slack" matches domain="slack"
 * 2. Domain contains need: need="sheet" matches domain="sheets" (if need >= 3 chars)
 * 3. Need contains domain: need="slack-notifications" matches domain="slack" (if domain >= 3 chars)
 *
 * @param need - Single capability requirement
 * @returns Array of matched MCP servers (0, 1, or multiple matches)
 */
export async function mapNeedToMCPServers(need: string): Promise<MCPServerMatch[]> {
  if (!need || need.trim() === "") {
    return [];
  }

  const needNormalized = normalizeNeed(need);
  const matches: MCPServerMatch[] = [];

  // Fetch dynamic servers from storage (gracefully fallback to static-only if unavailable)
  let dynamicServers: MCPServerMetadata[] = [];
  try {
    const adapter = await getMCPRegistryAdapter();
    dynamicServers = await adapter.list();
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    logger.warn("Failed to load dynamic MCP servers, using static registry only", {
      error: errorMessage,
      stack: errorStack,
      need: needNormalized,
    });
  }

  // Merge static and dynamic servers (static takes precedence if same ID)
  const staticServers = Object.values(mcpServersRegistry.servers);
  const staticIds = new Set(staticServers.map((s) => s.id));
  const uniqueDynamicServers = dynamicServers.filter((d) => !staticIds.has(d.id));
  const allServers: MCPServerMetadata[] = [...staticServers, ...uniqueDynamicServers];

  for (const server of allServers) {
    const matchedDomains: string[] = [];

    for (const domain of server.domains) {
      const domainNormalized = normalizeNeed(domain);

      // Exact match
      if (domainNormalized === needNormalized) {
        matchedDomains.push(domain);
        continue;
      }

      // Domain contains need (e.g., "sheets" contains "sheet")
      if (
        domainNormalized.includes(needNormalized) &&
        needNormalized.length >= MIN_FUZZY_MATCH_LENGTH
      ) {
        matchedDomains.push(domain);
        continue;
      }

      // Need contains domain (e.g., "slack-notifications" contains "slack")
      if (
        needNormalized.includes(domainNormalized) &&
        domainNormalized.length >= MIN_FUZZY_MATCH_LENGTH
      ) {
        matchedDomains.push(domain);
      }
    }

    // If any domains matched, include this server
    if (matchedDomains.length > 0) {
      matches.push({
        serverId: server.id,
        name: server.name,
        matchedDomains: [...new Set(matchedDomains)], // deduplicate
        requiredConfig: server.requiredConfig || [],
      });
    }
  }

  logger.debug("MCP server matching complete", {
    need: needNormalized,
    staticCount: staticServers.length,
    dynamicCount: uniqueDynamicServers.length,
    totalServers: allServers.length,
    matchCount: matches.length,
    matchedServerIds: matches.map((m) => m.serverId),
  });

  return matches;
}

/**
 * Built-in capabilities that don't require MCP servers or bundled agents.
 * These are provided by the base agent toolkit.
 */
const BUILT_IN_CAPABILITIES = [
  "files",
  "file",
  "bash",
  "shell",
  "csv",
  "artifacts",
  "artifact",
  "coding",
  "code",
  "web",
  "research",
  "analysis",
  "text",
];

/**
 * Checks if a need is a built-in capability that doesn't require external integration.
 * Uses exact matching only to avoid false positives (e.g., "webflow" matching "web").
 */
function isBuiltInCapability(need: string): boolean {
  const normalized = normalizeNeed(need);
  return BUILT_IN_CAPABILITIES.includes(normalized);
}

/**
 * Finds needs that have no matching bundled agent or MCP server.
 * Built-in capabilities (files, bash, csv, etc.) are filtered out as they
 * don't require external integrations.
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
    // Skip built-in capabilities - they don't require external integration
    if (isBuiltInCapability(need)) {
      continue;
    }

    const mcpMatches = mcpMatchesByNeed.get(need);
    if (!mcpMatches || mcpMatches.length === 0) {
      unmatched.push(need);
    }
  }

  return unmatched;
}
