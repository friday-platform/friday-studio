/**
 * Central export point for all type definitions
 */

// Client options
export interface AtlasClientOptions {
  url?: string;
  timeout?: number;
}

// Re-export all types
export type { DaemonStatus } from "./daemon.ts";

export type {
  WorkspaceAddRequest,
  WorkspaceBatchAddRequest,
  WorkspaceBatchAddResponse,
  WorkspaceCreateRequest,
  WorkspaceCreateResponse,
  WorkspaceDetailedInfo,
  WorkspaceInfo,
  WorkspaceRuntime,
} from "./workspace.ts";

export type {
  CancelSessionResponse,
  LogEntry,
  SessionDetailedInfo,
  SessionInfo,
  WorkspaceSessionInfo,
} from "./session.ts";

export type {
  DeleteLibraryItemResponse,
  GenerateFromTemplateRequest,
  LibraryItem,
  LibraryItemWithContent,
  LibrarySearchQuery,
  LibrarySearchResult,
  LibraryStats,
  TemplateConfig,
} from "./library.ts";

export type {
  SignalDetailedInfo,
  SignalInfo,
  SignalResponse,
  SignalTriggerResponse,
} from "./signal.ts";

export type { AgentInfo, JobDetailedInfo, JobInfo } from "./agent.ts";
