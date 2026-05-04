/**
 * @atlas/mcp - Per-caller MCP client + daemon-scoped shared process registry.
 *
 * Stdio MCP children are owned by their transport. HTTP-with-startup children
 * (e.g. workspace-mcp on a fixed port) are owned by `sharedMCPProcesses` and
 * survive across `createMCPTools` calls. Daemons MUST call
 * `sharedMCPProcesses.shutdown()` during their shutdown sequence.
 *
 * @module
 */

export type {
  CreateMCPToolsOptions,
  DisconnectedIntegration,
  DisconnectedIntegrationKind,
  MCPToolsResult,
  ScrubToolResult,
} from "./src/create-mcp-tools.ts";
export { createMCPTools, MCPStartupError } from "./src/create-mcp-tools.ts";
export type {
  ProcessRegistry,
  ProcessRegistryDeps,
  SharedProcessHandle,
  SharedProcessSpec,
} from "./src/process-registry.ts";
export { sharedMCPProcesses } from "./src/process-registry.ts";
