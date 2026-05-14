/**
 * @atlas/mcp-server
 * MCP server implementations for Atlas platform
 */

import { artifactsDeleteTool } from "./src/tools/artifacts/delete.ts";

export {
  PlatformMCPServer,
  type PlatformMCPServerDependencies,
} from "./src/platform-server.ts";
// Workspace-state storage initializer — daemon wires this once at
// startup before any state_* MCP tool runs. Per-workspace JetStream
// KV bucket; see ./src/tools/state/storage.ts.
export { initWorkspaceStateStorage } from "./src/tools/state/storage.ts";
// Pure tool handlers — used by the standalone tool-worker process and any
// in-process dispatcher to execute tools without going through the MCP server.
export { BashArgsSchema, executeBash } from "./src/tools/system/bash-handler.ts";
export { executeWebfetch, WebfetchArgsSchema } from "./src/tools/webfetch-handler.ts";
// These tools are not available to every agent or the SDK. They can be added on a per-agent basis when necessary (for now this only includes the conversation agent).
export { artifactsDeleteTool };
