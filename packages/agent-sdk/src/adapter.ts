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
  AgentSessionData,
  ApprovalRequest,
  AtlasAgent,
} from "./types.ts";

/**
 * Agent execution result types
 *
 * Agents can return either a completed result or a request for approval.
 * This structured approach allows approval requests to cross the MCP boundary
 * as successful responses with special structure.
 */
export type AgentExecutionResult = CompletedAgentResult | AwaitingApprovalResult;

/**
 * Standard completed agent result
 */
export interface CompletedAgentResult {
  type: "completed";
  result: unknown;
}

/**
 * Agent requesting supervisor approval
 *
 * This is returned as a successful MCP response (not an error)
 * to properly cross the network boundary.
 */
export interface AwaitingApprovalResult {
  type: "awaiting_approval";
  approvalId: string;
  agentId: string;
  sessionId: string;
  request: ApprovalRequest;
}

/**
 * Adapter for agent server implementations
 * Implement this interface to create a server that can host Atlas agents
 */
export interface AgentServerAdapter {
  /**
   * Register an agent with the server
   * @param agent The agent to register
   */
  registerAgent(agent: AtlasAgent): Promise<void> | void;

  /**
   * Unregister an agent from the server
   * @param agentId The ID of the agent to unregister
   */
  unregisterAgent(agentId: string): Promise<void> | void;

  /**
   * List all registered agents
   * @returns Array of agent metadata
   */
  listAgents(): Promise<AgentMetadata[]>;

  /**
   * Get a specific agent by ID
   * @param agentId The agent ID
   * @returns The agent if found, undefined otherwise
   */
  getAgent(agentId: string): Promise<AtlasAgent | undefined>;

  /**
   * Execute an agent with a prompt
   * @param agentId The agent to execute
   * @param prompt The natural language prompt
   * @param sessionData Session information
   * @param contextOverrides Optional context overrides
   * @returns The execution result
   */
  executeAgent(
    agentId: string,
    prompt: string,
    sessionData: AgentSessionData,
    requestId?: string,
    contextOverrides?: Partial<AgentContext>,
  ): Promise<AgentExecutionResult>;

  /**
   * Get agent expertise information
   * @param agentId The agent ID
   * @returns The agent's expertise metadata
   */
  getAgentExpertise(agentId: string): Promise<AgentMetadata["expertise"] | undefined>;

  /**
   * Start the server
   */
  start(): Promise<void>;

  /**
   * Stop the server
   */
  stop(): Promise<void>;
}

/**
 * Session manager interface for stateful agent execution
 */
export interface AgentSessionManager {
  /**
   * Get or create a session state
   * @param sessionKey Composite key for the session
   * @param agentId The agent ID
   * @returns The session state
   */
  getOrCreateSessionState(sessionKey: string, agentId: string): Record<string, unknown>;

  /**
   * Clear session state
   * @param sessionKey The session key to clear
   */
  clearSession(sessionKey: string): void;

  /**
   * Check if a session exists
   * @param sessionKey The session key to check
   * @returns True if session exists
   */
  hasSession(sessionKey: string): boolean;
}
