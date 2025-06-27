/**
 * @atlas/client - The official TypeScript client for the Atlas daemon API
 * @module
 */

// Main exports
export { AtlasClient, getAtlasClient } from "./src/client.ts";
export { AtlasApiError } from "./src/errors.ts";

// Type exports
export type {
  AtlasClientOptions,
  DaemonStatus,
  JobDetailedInfo,
  LibraryItem,
  LibrarySearchQuery,
  LibrarySearchResult,
  LibraryStats,
  LogEntry,
  SessionDetailedInfo,
  SessionInfo,
  SignalResponse,
  TemplateConfig,
  WorkspaceCreateRequest,
  WorkspaceCreateResponse,
  WorkspaceInfo,
} from "./src/types/index.ts";

// Utility exports
export { checkAtlasRunning, createAtlasNotRunningError } from "./src/utils.ts";

// Schema exports (for advanced usage)
export * from "./src/schemas.ts";
