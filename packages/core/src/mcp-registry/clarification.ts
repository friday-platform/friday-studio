import type { MissingField } from "./requirement-validator.ts";

export type BundledClarification = {
  type: "bundled-missing-fields";
  agentName: string;
  needs: string[];
  matchedAgent: { id: string; name: string; description: string };
  missingFields: MissingField[];
};

export type MCPClarification = {
  type: "mcp-missing-fields";
  agentName: string;
  needs: string[];
  matchedServer: { id: string; name: string };
  missingFields: MissingField[];
};

export type AmbiguousBundledClarification = {
  type: "bundled-ambiguous";
  agentName: string;
  needs: string[];
  matches: Array<{ id: string; name: string; description: string; matchedCapabilities: string[] }>;
};

export type AmbiguousMCPClarification = {
  type: "mcp-ambiguous";
  agentName: string;
  need: string;
  matches: Array<{ id: string; name: string; matchedDomains: string[] }>;
};

export type NoMatchClarification = {
  type: "no-match";
  agentName: string;
  need: string;
  suggestion: string;
};

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
