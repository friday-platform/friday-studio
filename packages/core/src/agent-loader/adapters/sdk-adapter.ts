import type { AtlasAgent } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import type { AgentAdapter, AgentSourceData, AgentSourceType, AgentSummary } from "./types.ts";

/**
 * Loads agents created programmatically using the Atlas SDK.
 * Agents are registered at runtime by application code.
 */
export class SDKAgentAdapter implements AgentAdapter {
  readonly adapterName = "sdk-agent-adapter";
  readonly sourceType = "sdk" as const;

  private agents = new Map<string, AtlasAgent>();
  private logger = createLogger({ component: "SDKAgentAdapter" });

  /** Register a single agent */
  registerAgent(agent: AtlasAgent): void {
    const id = agent.metadata.id;
    this.agents.set(id, agent);
    this.logger.debug("Registered SDK agent", { id });
  }

  /** Register multiple agents */
  registerAgents(agents: AtlasAgent[]): void {
    for (const agent of agents) {
      this.registerAgent(agent);
    }
  }

  /** Unregister an agent */
  unregisterAgent(id: string): boolean {
    const removed = this.agents.delete(id);
    if (removed) {
      this.logger.debug("Unregistered SDK agent", { id });
    }
    return removed;
  }

  /** Clear all registered agents */
  clear(): void {
    const count = this.agents.size;
    this.agents.clear();
    this.logger.debug("Cleared SDK agents", { count });
  }

  loadAgent(id: string): Promise<AgentSourceData> {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new Error(`SDK agent not found: ${id}`);
    }

    return Promise.resolve({
      type: "sdk",
      id,
      agent,
      metadata: { sourceLocation: `sdk://${id}`, version: agent.metadata.version },
    });
  }

  listAgents(): Promise<AgentSummary[]> {
    return Promise.resolve(
      Array.from(this.agents.entries()).map(([id, agent]) => ({
        id,
        type: "sdk" as AgentSourceType,
        displayName: agent.metadata.displayName,
        description: agent.metadata.description,
        version: agent.metadata.version,
      })),
    );
  }

  exists(id: string): Promise<boolean> {
    return Promise.resolve(this.agents.has(id));
  }

  /** Get the total number of registered agents */
  get size(): number {
    return this.agents.size;
  }

  /** Get a specific agent instance */
  getAgent(id: string): AtlasAgent | undefined {
    return this.agents.get(id);
  }
}
