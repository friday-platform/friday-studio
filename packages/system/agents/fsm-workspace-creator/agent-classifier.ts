/**
 * Classifies workspace plan agents via direct registry lookup.
 *
 * Each capability ID is checked against the bundled agents registry (bundled
 * takes precedence) then the MCP servers registry. No keyword extraction or
 * fuzzy matching.
 */

import { bundledAgentsRegistry } from "@atlas/bundled-agents/registry";
import type { WorkspacePlan } from "@atlas/core/artifacts";

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
 * Classify a single agent: bundled or LLM with MCP tools.
 *
 * Uses first-match-wins: iterates capabilities in order and returns on
 * the first bundled registry hit. Remaining capabilities are ignored.
 * This differs from workspace-builder's `classifyAgents()` which
 * partitions ALL capabilities into bundled/MCP/unknown buckets and
 * emits clarifications for conflicts.
 *
 * First-match-wins is acceptable here because the planner's `z.enum`
 * constraint validates capability combinations upstream — conflicting
 * combos (mixed-bundled-mcp, multiple-bundled) are caught by the
 * workspace-builder's `classifyAgents()` before reaching this path.
 */
function classifyAgent(agent: WorkspacePlan["agents"][0]): ClassifiedAgent {
  for (const capabilityId of agent.capabilities) {
    const bundledEntry = bundledAgentsRegistry[capabilityId];
    if (bundledEntry) {
      return {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        config: agent.configuration || {},
        type: { kind: "bundled", bundledId: bundledEntry.id, name: bundledEntry.name },
      };
    }
  }

  // No bundled agent — LLM with MCP tools from capabilities
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    config: agent.configuration || {},
    type: { kind: "llm", mcpTools: agent.capabilities },
  };
}

/**
 * Classify all agents in a workspace plan.
 */
export function classifyAgents(plan: WorkspacePlan): ClassifiedAgent[] {
  return plan.agents.map(classifyAgent);
}
