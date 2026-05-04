/**
 * @atlas/client - The official TypeScript client for the Atlas daemon API
 * @module
 *
 * @deprecated This is the v1 client. Use `@atlas/client/v2` for new development.
 * The v2 client uses Hono RPC for zero-cost type safety without code generation.
 * See the package README for migration guide.
 */

// Main exports
export { AtlasClient, getAtlasClient } from "./src/client.ts";
export { AtlasApiError } from "./src/errors.ts";
// Schema exports (for advanced usage)
export * from "./src/schemas.ts";
// Type exports
export type {
  AtlasClientOptions,
  DaemonStatus,
  JobDetailedInfo,
  LogEntry,
  SessionDetailedInfo,
  SessionInfo,
  SignalResponse,
  WorkspaceAddRequest,
  WorkspaceBatchAddRequest,
  WorkspaceBatchAddResponse,
  WorkspaceCreateRequest,
  WorkspaceCreateResponse,
  WorkspaceInfo,
} from "./src/types/index.ts";
// Utility exports
export { createAtlasNotRunningError } from "./src/utils.ts";
