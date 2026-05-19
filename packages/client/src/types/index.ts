/**
 * Central export point for all type definitions
 */

// Client options
export interface AtlasClientOptions {
  url?: string;
  timeout?: number;
}

// `SignalTriggerResponse` re-exported from `@atlas/core` (was a local
// duplicate before pass-4 fix #1).
export type { SignalTriggerResponse } from "@atlas/core";
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
export type { SignalResponse } from "./signal.ts";
export type {
  WorkspaceAddRequest,
  WorkspaceBatchAddRequest,
  WorkspaceBatchAddResponse,
  WorkspaceCreateRequest,
  WorkspaceCreateResponse,
  WorkspaceDetailedInfo,
  WorkspaceInfo,
} from "./workspace.ts";
