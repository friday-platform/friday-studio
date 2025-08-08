import type { AtlasAgent } from "@atlas/agent-sdk";
import type { AgentAdapter, AgentSourceData, AgentSourceType, AgentSummary } from "./types.ts";

// TODO: Phase 5 - Import actual system agents when converted to SDK format
// import { ConversationAgent } from "../../../../system/agents/conversation-agent.ts";
// import { FactExtractor } from "../../../../system/agents/fact-extractor.ts";

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

  /** Load system agents - currently pending SDK conversion */
  private registerSystemAgents(): void {
    throw new Error("System agents have not yet been ported to the SDK.");
    // TODO: Phase 5 - Register system agents when converted to AtlasAgent format
    // const systemAgents = [
    //   { id: "conversation", class: ConversationAgent },
    //   { id: "fact-extractor", class: FactExtractor },
    // ];
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
      metadata: {
        sourceLocation: `system://${id}`,
        version: agent.metadata.version,
      },
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
