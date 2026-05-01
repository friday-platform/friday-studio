/**
 * Agent Server Adapter Interface
 *
 * Defines the contract between the Atlas Agent SDK and server implementations.
 * This allows different server types (MCP, HTTP, etc.) to host agents without
 * the SDK knowing about server-specific details.
 */

import type {
  AgentContext,
  AgentMetadata,
  AgentResult,
  AgentSessionData,
  AtlasAgent,
} from "./types.ts";

/** Adapter for agent server implementations */
export interface AgentServerAdapter {
  registerAgent(agent: AtlasAgent): Promise<void> | void;
  listAgents(): Promise<AgentMetadata[]>;
  getAgent(agentId: string): Promise<AtlasAgent | undefined>;
  executeAgent(
    agentId: string,
    prompt: string,
    sessionData: AgentSessionData,
    requestId?: string,
    contextOverrides?: Partial<AgentContext>,
  ): Promise<AgentResult>;
  getAgentExpertise(agentId: string): Promise<AgentMetadata["expertise"] | undefined>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Session manager interface for stateful agent execution */
export interface AgentSessionManager {
  getOrCreateSessionState(sessionKey: string, agentId: string): Record<string, unknown>;
  clearSession(sessionKey: string): void;
  hasSession(sessionKey: string): boolean;
}
