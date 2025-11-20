/**
 * Actor Type Definitions with Discriminated Unions
 *
 * Provides type-safe actor interfaces and configuration slices
 * for the Atlas actor hierarchy.
 */

import type { AgentResult } from "@atlas/agent-sdk";
import type {
  AtlasMemoryConfig,
  JobSpecification,
  RuntimeConfig,
  SupervisorsConfig,
  ToolsConfig,
  WorkspaceAgentConfig,
  WorkspaceConfig,
  WorkspaceSignalConfig,
} from "@atlas/config";
import type { SessionSupervisorStatusType } from "../constants/supervisor-status.ts";

// Type aliases for clarity
type AgentConfig = WorkspaceAgentConfig;
type MemoryConfig = AtlasMemoryConfig;
type SignalsConfig = Record<string, WorkspaceSignalConfig>;
type JobsConfig = Record<string, JobSpecification>;

// ==============================================================================
// CONFIGURATION SLICE TYPES
// ==============================================================================

/**
 * Configuration slice for WorkspaceSupervisor
 * Contains only the configuration it needs to operate
 */
export interface WorkspaceSupervisorConfig {
  workspaceId: string;
  workspacePath: string;
  workspace: WorkspaceConfig["workspace"];
  signals: SignalsConfig;
  jobs: JobsConfig;
  memory?: MemoryConfig;
  tools?: ToolsConfig;
  supervisorDefaults?: SupervisorsConfig;
  runtime?: RuntimeConfig;
}

/**
 * Configuration slice for SessionSupervisor
 * Contains job-specific configuration and agents
 */
export interface SessionSupervisorConfig {
  agents: Record<string, AgentConfig>;
  memory?: MemoryConfig;
  tools?: ToolsConfig;
}

/**
 * Configuration slice for AgentExecutionActor
 * Contains minimal agent-specific configuration
 */
export interface AgentExecutionConfig {
  agentId: string; // The agent's ID (key from agents record)
  agent: AgentConfig;
  tools?: string[]; // Agent's specific tools array
  memory?: MemoryConfig;
  workspaceTools?: ToolsConfig; // Workspace-level tools config
  workspaceTimeout?: import("@atlas/config").WorkspaceTimeoutConfig; // Workspace timeout configuration
}

// ==============================================================================
// ACTOR CONFIGURATION DISCRIMINATED UNION
// ==============================================================================

/**
 * Discriminated union for actor configurations
 * Enables type-safe configuration passing
 */
export type ActorConfig =
  | { type: "workspace"; config: WorkspaceSupervisorConfig }
  | { type: "session"; config: SessionSupervisorConfig }
  | { type: "agent"; config: AgentExecutionConfig };

// ==============================================================================
// ACTOR RESULT TYPES
// ==============================================================================

export interface SessionInfo {
  id: string;
  status: "pending" | "executing" | "completed" | "failed" | "cancelled";
  startTime: number;
  endTime?: number;
  error?: string;
}

export interface SessionResult {
  sessionId: string;
  status: "success" | "error";
  result?: unknown;
  error?: string;
  duration: number;
}

export interface AgentContext {
  sessionId: string;
  workspaceId: string;
  task?: string;
  reasoning?: string;
  input: unknown;
}

// ==============================================================================
// BASE ACTOR INTERFACE
// ==============================================================================

/**
 * Common initialization parameters for all actors
 */
export interface ActorInitParams {
  actorId: string;
  parentId?: string;
}

/**
 * Base interface for all actors with discriminated type
 */
export interface BaseActor {
  id: string;
  type: ActorConfig["type"];
  initialize(params: ActorInitParams): void | Promise<void>;
  shutdown(): void | Promise<void>;
}

// ==============================================================================
// SPECIFIC ACTOR INTERFACES
// ==============================================================================

/**
 * WorkspaceSupervisor actor interface
 */
export interface WorkspaceSupervisorActor extends BaseActor {
  type: "workspace";
  processSignal(signal: unknown): Promise<SessionInfo>;
  getSession(sessionId: string): SessionInfo | undefined;
  getActiveSessionCount(): number;
}

/**
 * SessionSupervisor actor interface
 */
export interface SessionSupervisorActor extends BaseActor {
  type: "session";
  execute(): Promise<SessionResult>;
  abort(): Promise<void>;
  getStatus(): SessionSupervisorStatusType;
}

/**
 * AgentExecution actor interface
 */
export interface AgentExecutionActor extends BaseActor {
  type: "agent";
  execute(context: AgentContext): Promise<AgentResult>;
}

// ==============================================================================
// TYPE GUARD FUNCTIONS
// ==============================================================================

/**
 * Type guard for WorkspaceSupervisor
 */
export function isWorkspaceSupervisor(actor: BaseActor): actor is WorkspaceSupervisorActor {
  return actor.type === "workspace";
}

/**
 * Type guard for SessionSupervisor
 */
export function isSessionSupervisor(actor: BaseActor): actor is SessionSupervisorActor {
  return actor.type === "session";
}

/**
 * Type guard for AgentExecution
 */
export function isAgentExecution(actor: BaseActor): actor is AgentExecutionActor {
  return actor.type === "agent";
}

// ==============================================================================
// ACTOR REFERENCE MAPPING
// ==============================================================================

/**
 * Type-safe actor reference mapping
 * Maps actor types to their actual actor instances
 * Note: These are plain class instances, not XState machine references
 */
export type ActorRefMap = {
  workspace: WorkspaceSupervisorActor;
  session: SessionSupervisorActor;
  agent: AgentExecutionActor;
};
