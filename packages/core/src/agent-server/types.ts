/**
 * Internal types for the Atlas Agent MCP Server
 */

import type { AgentRegistry } from "@atlas/agent-sdk";
import type { PlatformModels } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import { z } from "zod";

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

  /** Platform model resolver threaded into every AgentContext built by this server. */
  platformModels: PlatformModels;

  /** Optional state store for persistence */
  stateStore?: StateStore;

  /** Disable timeouts for testing */
  disableTimeouts?: boolean;

  /** Check if a session has an active SSE connection */
  hasActiveSSE?: (sessionId?: string) => boolean;
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
  datetime: z
    .object({
      timezone: z.string(),
      timestamp: z.string(),
      localDate: z.string(),
      localTime: z.string(),
      timezoneOffset: z.string(),
      latitude: z.string().optional(),
      longitude: z.string().optional(),
    })
    .optional(),
  memoryContextKey: z.string().optional(),
  foregroundWorkspaceIds: z.array(z.string()).optional(),
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

  /** JSON Schema for structured output — resolved from FSM documentTypes */
  outputSchema: z.record(z.string(), z.unknown()).optional(),

  /** Agent-specific config from workspace runtime (e.g. workDir from clone step) */
  config: z.record(z.string(), z.unknown()).optional(),
});

export type AgentToolParams = z.infer<typeof AgentToolParamsSchema>;
