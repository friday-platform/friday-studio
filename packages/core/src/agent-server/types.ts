/**
 * Internal types for the Atlas Agent MCP Server
 */

import type { AgentRegistry } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { z } from "zod";
import type { AtlasDaemon } from "../../../../apps/atlasd/src/atlas-daemon.ts";
import type { GlobalMCPServerPool } from "../mcp-server-pool.ts";

/**
 * Dependencies for the agent server
 */
export interface AgentServerDependencies {
  /** Agent registry for discovery */
  agentRegistry: AgentRegistry;

  /** Logger instance */
  logger: Logger;

  /** Base URL for the daemon */
  daemonUrl: string;

  /** Global MCP server connection pool */
  mcpServerPool: GlobalMCPServerPool;

  /** Optional state store for persistence */
  stateStore?: StateStore;

  /** Disable timeouts for testing */
  disableTimeouts?: boolean;

  /** Check if a session has an active SSE connection */
  hasActiveSSE?: (sessionId?: string) => boolean;

  /** The Atlas daemon instance */
  daemon: AtlasDaemon;
}

/**
 * Pending prompt waiting for approval
 */
export interface PendingPrompt {
  id: string;
  agentId: string;
  prompt: string;
  context: unknown;
  timestamp: number;
}

/**
 * Agent session state for persistence
 */
export interface AgentSessionState {
  id: string;
  agentName: string;
  atlasSessionId: string; // From auth headers, not MCP session
  pendingPrompts: Map<string, PendingPrompt>;
  memory: Record<string, unknown>;
  lastActivity: number;
}

/**
 * Simplified agent state for persistence
 */
interface AgentState {
  memory: Record<string, unknown>;
  pendingPrompts: Array<[string, PendingPrompt]>; // Array for JSON serialization
  lastActivity: number;
  version?: number;
  metadata?: StateMetadata;
}

/**
 * State metadata for tracking versions and history
 */
interface StateMetadata {
  version: number;
  createdAt: number;
  updatedAt: number;
  size: number;
  compressed?: boolean;
  checksum?: string;
}

/**
 * State snapshot for rollback support
 */
interface StateSnapshot {
  id: string;
  sessionKey: string;
  state: AgentState;
  timestamp: number;
  reason?: string;
}

/**
 * External state persistence interface
 */
interface StateStore {
  get(key: string): Promise<AgentState | null>;
  set(key: string, state: AgentState): Promise<void>;
  delete(key: string): Promise<void>;
  list?(pattern?: string): Promise<string[]>; // Optional for debugging
  getSnapshot(snapshotId: string): Promise<StateSnapshot | null>;
  saveSnapshot(snapshot: StateSnapshot): Promise<void>;
  listSnapshots(sessionKey: string): Promise<StateSnapshot[]>;
  deleteSnapshot(snapshotId: string): Promise<void>;
}

/**
 * Session context for agent isolation and tracking
 * DUPLICATED FROM AGENT SDK DUE TO ZOD/V4<>V3 nonsense.
 * @FIXME: Remove this once the MCP Server supports Zod/v4.
 * @see packages/agent-sdk/src/types.ts
 */
const AgentSessionDataSchema = z.object({
  sessionId: z.string(),
  workspaceId: z.string(),
  userId: z.string().optional(),
  streamId: z.string().optional(),
});

/**
 * MCP tool parameter schema
 *
 * Note: Session context is passed as tool arguments due to MCP SDK limitation.
 * The StreamableHTTPClientTransport doesn't support per-request headers on a
 * shared transport instance, and creating multiple transports per session would
 * be inefficient. Parameters prefixed with underscore are system parameters.
 */
export const AgentToolParamsSchema = z.object({
  /** Natural language prompt for the agent */
  prompt: z.string().describe("What you want the agent to do"),

  /** Additional context if needed */
  context: z.unknown().optional().describe("Additional context if needed"),

  /** Session context for agent isolation and tracking */
  _sessionContext: AgentSessionDataSchema,

  /** Resume support for supervisor approvals */
  _approvalId: z.string().optional(),
  _approvalDecision: z.unknown().optional(),
});

export type AgentToolParams = z.infer<typeof AgentToolParamsSchema>;
