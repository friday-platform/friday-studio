/**
 * Classifies workspace plan agents as bundled or LLM-based
 */

import type { WorkspacePlan } from "@atlas/core/artifacts";
import {
  extractKeywordsFromNeed,
  matchBundledAgents,
} from "@atlas/core/mcp-registry/deterministic-matching";
import type { ClassifiedAgent } from "./types.ts";

/**
 * Classify a single agent: bundled or LLM with MCP tools
 */
function classifyAgent(agent: WorkspacePlan["agents"][0]): ClassifiedAgent {
  // Pre-process needs to extract known keywords from verbose descriptions
  // e.g., "html-email" → ["email"], which matches the email bundled agent
  const normalizedNeeds = agent.needs.flatMap(extractKeywordsFromNeed);
  const bundledMatches = matchBundledAgents(normalizedNeeds);

  if (bundledMatches.length === 1 && bundledMatches[0]) {
    const match = bundledMatches[0];
    return {
      id: agent.id,
      name: agent.name,
      description: agent.description,
      config: agent.configuration || {},
      type: { kind: "bundled", bundledId: match.agentId, name: match.name },
    };
  }

  // No bundled agent - use LLM with MCP tools
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    config: agent.configuration || {},
    type: { kind: "llm", mcpTools: agent.needs },
  };
}

/**
 * Classify all agents in a workspace plan
 */
export function classifyAgents(plan: WorkspacePlan): ClassifiedAgent[] {
  return plan.agents.map(classifyAgent);
}
