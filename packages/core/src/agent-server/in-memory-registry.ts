/**
 * In-Memory Agent Registry
 *
 * Simple implementation of AgentRegistry that stores agents in memory.
 * Suitable for development and testing. Production deployments should
 * use a persistent registry implementation.
 */

import type { AgentMetadata, AgentRegistry, AtlasAgent } from "@atlas/agent-sdk";

export class InMemoryAgentRegistry implements AgentRegistry {
  private agents = new Map<string, AtlasAgent>();

  listAgents(filters?: { domains?: string[]; tags?: string[] }): Promise<AgentMetadata[]> {
    let agents = Array.from(this.agents.values());

    // Apply filters if provided
    if (filters?.domains && filters.domains.length > 0) {
      agents = agents.filter((agent) =>
        agent.metadata.expertise.domains.some((domain) => filters.domains.includes(domain)),
      );
    }

    if (filters?.tags && filters.tags.length > 0) {
      agents = agents.filter(
        (agent) =>
          agent.metadata.metadata?.tags?.some((tag) => filters.tags.includes(tag)) ?? false,
      );
    }

    return Promise.resolve(agents.map((agent) => agent.metadata));
  }

  getAgent(id: string): Promise<AtlasAgent | undefined> {
    return Promise.resolve(this.agents.get(id));
  }

  registerAgent(agent: AtlasAgent): Promise<void> {
    const id = agent.metadata.id;
    this.agents.set(id, agent);
    return Promise.resolve();
  }

  searchAgents(query: string): Promise<AgentMetadata[]> {
    const lowerQuery = query.toLowerCase();

    return Promise.resolve(
      Array.from(this.agents.values())
        .filter((agent) => {
          const meta = agent.metadata;
          // Search in name, description, domains, capabilities
          return (
            meta.displayName?.toLowerCase().includes(lowerQuery) ||
            meta.description.toLowerCase().includes(lowerQuery) ||
            meta.expertise.domains.some((d) => d.toLowerCase().includes(lowerQuery)) ||
            meta.expertise.capabilities.some((c) => c.toLowerCase().includes(lowerQuery))
          );
        })
        .map((agent) => agent.metadata),
    );
  }

  getAgentsByDomain(domain: string): Promise<AgentMetadata[]> {
    return Promise.resolve(
      Array.from(this.agents.values())
        .filter((agent) => agent.metadata.expertise.domains.includes(domain))
        .map((agent) => agent.metadata),
    );
  }

  /**
   * Clear all agents from the registry
   * Useful for testing
   */
  clear(): void {
    this.agents.clear();
  }

  /**
   * Get the number of registered agents
   */
  size(): number {
    return this.agents.size;
  }
}
