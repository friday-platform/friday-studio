import type { AgentMetadata } from "@atlas/agent-sdk";
import { AgentRegistry } from "@atlas/core";

export interface CatalogAgent {
  id: string;
  name: string;
  description: string;
}

/**
 * Get catalog of available agents for task planning.
 * Returns simplified agent info (id, name, description) without MCP requirements.
 * MVP version - keeps it simple.
 */
export async function getAgentCatalog(): Promise<CatalogAgent[]> {
  const registry = new AgentRegistry({ includeSystemAgents: false });
  await registry.initialize();

  const agents = await registry.listAgents();

  // Filter out conversation agent (don't let it call itself)
  // System agents with custom inputSchemas (workspace-planner, fsm-workspace-creator)
  // are registered directly in conversation agent, not available via do_task
  return agents
    .filter((agent: AgentMetadata) => agent.id !== "conversation")
    .map((agent: AgentMetadata) => ({
      id: agent.id,
      name: agent.displayName || agent.id,
      description: agent.description,
    }));
}
