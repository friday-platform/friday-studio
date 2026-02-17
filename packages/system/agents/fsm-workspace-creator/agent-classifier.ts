/**
 * Classifies workspace plan agents as bundled or LLM-based
 */

import type { WorkspacePlan } from "@atlas/core/artifacts";
import { findFullBundledMatch } from "@atlas/core/mcp-registry/deterministic-matching";

type AgentType =
  | { kind: "bundled"; bundledId: string; name: string }
  | { kind: "llm"; mcpTools: string[] };

export interface ClassifiedAgent {
  id: string;
  name: string;
  description: string;
  config: Record<string, unknown>;
  type: AgentType;
}

/**
 * Classify a single agent: bundled or LLM with MCP tools
 */
function classifyAgent(agent: WorkspacePlan["agents"][0]): ClassifiedAgent {
  const match = findFullBundledMatch(agent.needs);

  if (match) {
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
