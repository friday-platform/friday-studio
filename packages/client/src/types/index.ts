/**
 * Central export point for all type definitions
 */

// Client options
export interface AtlasClientOptions {
  url?: string;
  timeout?: number;
}

export type { AgentInfo, JobDetailedInfo, JobInfo } from "./agent.ts";
// Re-export all types
export type { DaemonStatus } from "./daemon.ts";
export type {
  CancelSessionResponse,
  LogEntry,
  SessionDetailedInfo,
  SessionInfo,
  WorkspaceSessionInfo,
} from "./session.ts";

export type {
  SignalResponse,
  SignalTriggerResponse,
} from "./signal.ts";
export type {
  WorkspaceAddRequest,
  WorkspaceBatchAddRequest,
  WorkspaceBatchAddResponse,
  WorkspaceCreateRequest,
  WorkspaceCreateResponse,
  WorkspaceDetailedInfo,
  WorkspaceInfo,
} from "./workspace.ts";
