import type { AtlasAgent } from "@atlas/agent-sdk";
import { conversationAgent, workspaceChatAgent } from "@atlas/system/agents";
import { AgentNotFoundError } from "../errors.ts";
import type { AgentAdapter, AgentSourceData, AgentSummary } from "./types.ts";

/**
 * Loads built-in Atlas system agents.
 * System agents are embedded in the binary and restricted to system workspaces.
 */
export class SystemAgentAdapter implements AgentAdapter {
  readonly adapterName = "system-agent-adapter";
  readonly sourceType = "system" as const;

  private agents = new Map<string, AtlasAgent<unknown, unknown>>();

  constructor() {
    this.registerSystemAgents();
  }

  private registerSystemAgents(): void {
    this.agents.set(conversationAgent.metadata.id, conversationAgent);
    this.agents.set(workspaceChatAgent.metadata.id, workspaceChatAgent);
  }

  loadAgent(id: string): Promise<AgentSourceData> {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new AgentNotFoundError(id, "System");
    }

    return Promise.resolve({
      type: "system",
      id,
      agent,
      metadata: { sourceLocation: `system://${id}`, version: agent.metadata.version },
    });
  }

  listAgents(): Promise<AgentSummary[]> {
    return Promise.resolve(
      Array.from(this.agents.entries()).map(([id, agent]) => ({
        id,
        type: "system",
        displayName: agent.metadata.displayName,
        description: agent.metadata.description,
        version: agent.metadata.version,
      })),
    );
  }

  exists(id: string): Promise<boolean> {
    return Promise.resolve(this.agents.has(id));
  }
}
