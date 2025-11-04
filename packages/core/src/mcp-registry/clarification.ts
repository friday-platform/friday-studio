import type { BundledAgentMatch, MCPServerMatch } from "./deterministic-matching.ts";
import type { MissingField } from "./requirement-validator.ts";

/**
 * Clarification for bundled agent with missing fields
 */
export type BundledClarification = {
  type: "bundled-missing-fields";
  agentName: string;
  needs: string[];
  matchedAgent: { id: string; name: string; description: string };
  missingFields: MissingField[];
};

/**
 * Clarification for MCP server with missing fields
 */
export type MCPClarification = {
  type: "mcp-missing-fields";
  agentName: string;
  needs: string[];
  matchedServer: { id: string; name: string };
  missingFields: MissingField[];
};

/**
 * Clarification for ambiguous bundled agent matches
 */
export type AmbiguousBundledClarification = {
  type: "bundled-ambiguous";
  agentName: string;
  needs: string[];
  matches: Array<{ id: string; name: string; description: string; matchedCapabilities: string[] }>;
};

/**
 * Clarification for ambiguous MCP server matches
 */
export type AmbiguousMCPClarification = {
  type: "mcp-ambiguous";
  agentName: string;
  need: string;
  matches: Array<{ id: string; name: string; matchedDomains: string[] }>;
};

/**
 * Clarification for unmatched need (no integration found)
 */
export type NoMatchClarification = {
  type: "no-match";
  agentName: string;
  need: string;
  suggestion: string;
};

/**
 * Union of all clarification types
 */
export type ClarificationItem =
  | BundledClarification
  | MCPClarification
  | AmbiguousBundledClarification
  | AmbiguousMCPClarification
  | NoMatchClarification;

/**
 * Formats a clarification report into human-readable text for error messages.
 * Groups clarifications by agent for better readability.
 *
 * @param items - Clarification items to format
 * @returns Formatted error message text
 */
export function formatClarificationReport(items: ClarificationItem[]): string {
  if (items.length === 0) {
    return "";
  }

  // Group by agent name for clarity
  const byAgent = new Map<string, ClarificationItem[]>();

  for (const item of items) {
    const existing = byAgent.get(item.agentName) || [];
    existing.push(item);
    byAgent.set(item.agentName, existing);
  }

  const sections: string[] = [];

  for (const [agentName, agentItems] of byAgent) {
    const lines: string[] = [`\n**${agentName}**`];

    for (const item of agentItems) {
      switch (item.type) {
        case "bundled-missing-fields":
          lines.push(`  - Matched bundled agent: ${item.matchedAgent.name}`);
          lines.push(`    Missing configuration:`);
          for (const field of item.missingFields) {
            lines.push(`    • ${field.field}: ${field.reason}`);
          }
          break;

        case "mcp-missing-fields":
          lines.push(`  - Matched MCP server: ${item.matchedServer.name}`);
          lines.push(`    Missing configuration:`);
          for (const field of item.missingFields) {
            lines.push(`    • ${field.field}: ${field.reason}`);
          }
          break;

        case "bundled-ambiguous":
          lines.push(`  - Multiple bundled agents match. Please specify which one:`);
          for (const match of item.matches) {
            lines.push(`    • ${match.name}: ${match.description}`);
            lines.push(`      (matches: ${match.matchedCapabilities.join(", ")})`);
          }
          break;

        case "mcp-ambiguous":
          lines.push(`  - Multiple MCP servers match "${item.need}". Please specify which one:`);
          for (const match of item.matches) {
            lines.push(`    • ${match.name} (${match.id})`);
            lines.push(`      (matches: ${match.matchedDomains.join(", ")})`);
          }
          break;

        case "no-match":
          lines.push(`  - No integration found for "${item.need}"`);
          lines.push(`    ${item.suggestion}`);
          break;
      }
    }

    sections.push(lines.join("\n"));
  }

  const summary = `Missing information for ${items.length} issue${items.length === 1 ? "" : "s"} across ${byAgent.size} agent${byAgent.size === 1 ? "" : "s"}:`;

  return `${summary}\n${sections.join("\n")}`;
}

/**
 * Helper to create bundled clarification with missing fields
 */
export function createBundledMissingFieldsClarification(
  agentName: string,
  needs: string[],
  match: BundledAgentMatch,
  missingFields: MissingField[],
): BundledClarification {
  return {
    type: "bundled-missing-fields",
    agentName,
    needs,
    matchedAgent: { id: match.agentId, name: match.name, description: match.description },
    missingFields,
  };
}

/**
 * Helper to create MCP clarification with missing fields
 */
export function createMCPMissingFieldsClarification(
  agentName: string,
  needs: string[],
  match: MCPServerMatch,
  missingFields: MissingField[],
): MCPClarification {
  return {
    type: "mcp-missing-fields",
    agentName,
    needs,
    matchedServer: { id: match.serverId, name: match.name },
    missingFields,
  };
}

/**
 * Helper to create ambiguous bundled agent clarification
 */
export function createAmbiguousBundledClarification(
  agentName: string,
  needs: string[],
  matches: BundledAgentMatch[],
): AmbiguousBundledClarification {
  return {
    type: "bundled-ambiguous",
    agentName,
    needs,
    matches: matches.map((m) => ({
      id: m.agentId,
      name: m.name,
      description: m.description,
      matchedCapabilities: m.matchedCapabilities,
    })),
  };
}

/**
 * Helper to create ambiguous MCP server clarification
 */
export function createAmbiguousMCPClarification(
  agentName: string,
  need: string,
  matches: MCPServerMatch[],
): AmbiguousMCPClarification {
  return {
    type: "mcp-ambiguous",
    agentName,
    need,
    matches: matches.map((m) => ({
      id: m.serverId,
      name: m.name,
      matchedDomains: m.matchedDomains,
    })),
  };
}

/**
 * Helper to create no-match clarification
 */
export function createNoMatchClarification(agentName: string, need: string): NoMatchClarification {
  return {
    type: "no-match",
    agentName,
    need,
    suggestion: `Be more specific (e.g., if "notifications", specify slack/email/discord) or this integration doesn't exist yet.`,
  };
}
