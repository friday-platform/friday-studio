import type { AtlasAgent } from "@atlas/agent-sdk";
import { bundledAgents } from "@atlas/bundled-agents";
import { createLogger } from "@atlas/logger";
import { AgentNotFoundError } from "../errors.ts";
import type { AgentAdapter, AgentSourceData, AgentSummary } from "./types.ts";

/**
 * Loads agents bundled with Atlas.
 * Bundled agents are compiled into the binary and available to all workspaces.
 * YAML agents are converted at startup for better performance.
 */
export class BundledAgentAdapter implements AgentAdapter {
  readonly adapterName = "bundled-agent-adapter";
  readonly sourceType = "bundled" as const;

  private agents = new Map<string, AtlasAgent>();
  private logger = createLogger({ component: "BundledAgentAdapter" });

  constructor() {
    this.registerBundledAgents();
  }

  /** Register all bundled agents at startup */
  private registerBundledAgents(): void {
    for (const agent of bundledAgents) {
      try {
        // Use ID for registration
        const agentKey = agent.metadata.id;
        this.agents.set(agentKey, agent);
        this.logger.debug("Registered bundled SDK agent", {
          id: agent.metadata.id,
          displayName: agent.metadata.displayName,
          key: agentKey,
        });
      } catch (error) {
        this.logger.error("Failed to register bundled SDK agent", { id: agent.metadata.id, error });
        throw new Error(`Failed to register bundled SDK agent '${agent.metadata.id}'`);
      }
    }
  }

  loadAgent(id: string): Promise<AgentSourceData> {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new AgentNotFoundError(id, "Bundled");
    }

    return Promise.resolve({
      type: "bundled",
      id,
      agent,
      metadata: { sourceLocation: `bundled://${id}`, version: agent.metadata.version },
    });
  }

  listAgents(): Promise<AgentSummary[]> {
    // Use a Map to deduplicate agents (since we register by both ID and name)
    const uniqueAgents = new Map<string, { key: string; agent: AtlasAgent }>();

    for (const [key, agent] of this.agents.entries()) {
      const agentId = agent.metadata.id || key;
      // Only include the agent once, preferring the ID-based entry
      if (!uniqueAgents.has(agentId) || key === agentId) {
        uniqueAgents.set(agentId, { key, agent });
      }
    }

    return Promise.resolve(
      Array.from(uniqueAgents.values()).map(({ key, agent }) => ({
        id: key,
        displayName: agent.metadata.displayName,
        type: "bundled",
        description: agent.metadata.description,
        version: agent.metadata.version,
      })),
    );
  }

  exists(id: string): Promise<boolean> {
    return Promise.resolve(this.agents.has(id));
  }
}
