import type { AtlasAgent } from "@atlas/agent-sdk";
import { conversationAgent } from "../../../../system/agents/conversation/conversation.agent.ts";
import { workspaceCreationAgent } from "../../../../system/agents/workspace-creation/workspace-creation.agent.ts";
import type { AgentAdapter, AgentSourceData, AgentSourceType, AgentSummary } from "./types.ts";

/**
 * Loads built-in Atlas system agents.
 * System agents are embedded in the binary and restricted to system workspaces.
 */
export class SystemAgentAdapter implements AgentAdapter {
  readonly adapterName = "system-agent-adapter";
  readonly sourceType = "system" as const;

  private agents = new Map<string, AtlasAgent>();

  constructor() {
    this.registerSystemAgents();
  }

  private registerSystemAgents(): void {
    this.agents.set(conversationAgent.metadata.id, conversationAgent);
    this.agents.set(workspaceCreationAgent.metadata.id, workspaceCreationAgent);
  }

  loadAgent(id: string): Promise<AgentSourceData> {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new Error(`System agent not found: ${id}`);
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
        type: "system" as AgentSourceType,
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
