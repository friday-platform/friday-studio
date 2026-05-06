import type { AtlasAgent } from "@atlas/agent-sdk";
import { judgeAgent, workspaceChatAgent } from "@atlas/system/agents";
import { AgentNotFoundError } from "../errors.ts";
import type { AgentAdapter, AgentSourceData, AgentSummary } from "./types.ts";

/**
 * Module-level registry of bundled system agents keyed by agentId. Mirrors
 * the set populated in `SystemAgentAdapter.registerSystemAgents` — kept in
 * lockstep so synchronous lookups (see `getSystemAgentType`) don't require
 * instantiating the adapter or awaiting the async loader. Add new system
 * agents here AND in `registerSystemAgents`.
 */
const SYSTEM_AGENT_IDS: ReadonlySet<string> = new Set([
  workspaceChatAgent.metadata.id,
  judgeAgent.metadata.id,
]);

/**
 * Synchronous lookup: returns the FSM-classifier agent type for a bundled
 * system agent. System agents (workspace-chat, judge-agent) have fixed
 * prompts baked into TypeScript code — from the validate-classifier's
 * perspective they're indistinguishable from `type: atlas` workspace-config
 * agents. The classifier short-circuits both to `skip` (rule 1).
 *
 * Returns `undefined` for any agentId not registered as a system agent so
 * callers can chain into other resolution paths (e.g. `workspace.agents`
 * config lookup) without false positives.
 */
export function getSystemAgentType(agentId: string): "atlas" | undefined {
  return SYSTEM_AGENT_IDS.has(agentId) ? "atlas" : undefined;
}

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
    this.agents.set(workspaceChatAgent.metadata.id, workspaceChatAgent);
    // B7 (melodic-strolling-seal-pt2). Judge agent for `validate: external`
    // — invoked via the FSM engine's `runJudge` callback (workspace runtime
    // wires the executor → this adapter → judgeAgent.handler).
    this.agents.set(judgeAgent.metadata.id, judgeAgent as AtlasAgent<unknown, unknown>);
    // NOTE: when adding agents here, also add the id to `SYSTEM_AGENT_IDS`
    // above so synchronous type lookups stay in sync.
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
