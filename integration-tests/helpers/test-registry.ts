/**
 * Test Agent Registry
 *
 * Extended version of InMemoryAgentRegistry with additional
 * testing utilities and domain filtering support.
 */

import { InMemoryAgentRegistry } from "../../packages/core/src/agent-server/in-memory-registry.ts";
import type { AgentMetadata, AtlasAgent } from "@atlas/agent-sdk";

export class TestAgentRegistry extends InMemoryAgentRegistry {
  private registrationHistory: Array<{
    agentId: string;
    timestamp: number;
    action: "register" | "unregister";
  }> = [];

  /**
   * Register an agent and track registration history
   */
  async registerAgent(agent: AtlasAgent): Promise<void> {
    await super.registerAgent(agent);

    this.registrationHistory.push({
      agentId: agent.metadata.id,
      timestamp: Date.now(),
      action: "register",
    });
  }

  /**
   * Unregister an agent (for testing)
   */
  async unregisterAgent(agentId: string): Promise<void> {
    const agents = this.getInternalAgentsMap();
    agents.delete(agentId);

    this.registrationHistory.push({
      agentId,
      timestamp: Date.now(),
      action: "unregister",
    });
  }

  /**
   * Get internal agents map for testing purposes
   */
  private getInternalAgentsMap(): Map<string, AtlasAgent> {
    // Access the private agents map through reflection
    // This is for testing only
    return (this).agents;
  }

  /**
   * Get registration history
   */
  getRegistrationHistory(): typeof this.registrationHistory {
    return [...this.registrationHistory];
  }

  /**
   * Clear registration history
   */
  clearHistory(): void {
    this.registrationHistory = [];
  }

  /**
   * Get agents by multiple domains (OR operation)
   */
  async getAgentsByDomains(domains: string[]): Promise<AgentMetadata[]> {
    const agents = await this.listAgents();

    return agents.filter((agent) =>
      agent.expertise.domains.some((domain) => domains.includes(domain))
    );
  }

  /**
   * Get agents by capabilities
   */
  async getAgentsByCapabilities(capabilities: string[]): Promise<AgentMetadata[]> {
    const agents = await this.listAgents();

    return agents.filter((agent) =>
      capabilities.every((cap) =>
        agent.expertise.capabilities.some((agentCap) =>
          agentCap.toLowerCase().includes(cap.toLowerCase())
        )
      )
    );
  }

  /**
   * Check if an agent exists
   */
  async hasAgent(agentId: string): Promise<boolean> {
    const agent = await this.getAgent(agentId);
    return agent !== undefined;
  }

  /**
   * Get statistics about registered agents
   */
  getStats(): {
    total: number;
    byDomain: Record<string, number>;
    registrations: number;
    unregistrations: number;
  } {
    const agents = Array.from(this.getInternalAgentsMap().values());
    const byDomain: Record<string, number> = {};

    for (const agent of agents) {
      for (const domain of agent.metadata.expertise.domains) {
        byDomain[domain] = (byDomain[domain] || 0) + 1;
      }
    }

    const registrations = this.registrationHistory.filter((h) => h.action === "register").length;
    const unregistrations =
      this.registrationHistory.filter((h) => h.action === "unregister").length;

    return {
      total: this.size(),
      byDomain,
      registrations,
      unregistrations,
    };
  }

  /**
   * Create a snapshot of current registry state
   */
  async createSnapshot(): Promise<{
    agents: AgentMetadata[];
    stats: ReturnType<typeof this.getStats>;
    timestamp: number;
  }> {
    const agents = await this.listAgents();
    const stats = this.getStats();

    return {
      agents,
      stats,
      timestamp: Date.now(),
    };
  }

  /**
   * Bulk register multiple agents
   */
  async bulkRegister(agents: AtlasAgent[]): Promise<void> {
    for (const agent of agents) {
      await this.registerAgent(agent);
    }
  }

  /**
   * Find agents matching a predicate
   */
  async findAgents(
    predicate: (agent: AgentMetadata) => boolean,
  ): Promise<AgentMetadata[]> {
    const agents = await this.listAgents();
    return agents.filter(predicate);
  }
}
