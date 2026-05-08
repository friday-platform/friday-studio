/**
 * @atlas/mcp-server
 * MCP server implementations for Atlas platform
 */

import { artifactsDeleteTool } from "./src/tools/artifacts/delete.ts";

export {
  PlatformMCPServer,
  type PlatformMCPServerDependencies,
} from "./src/platform-server.ts";
// `record_validation` — local AI-SDK tool conditionally injected by the FSM
// runtime when an action's
// resolved validation strategy is `"self"`. Canonical implementation in
// @atlas/core/agent-context (so fsm-engine and the agent orchestrator can
// both import without pulling mcp-server's daemon dep into their closure);
// the platform-tools file is a thin re-export for catalog discoverability.
export {
  createRecordValidationTool,
  RECORD_VALIDATION_TOOL_NAME,
  type RecordValidationInput,
} from "./src/tools/platform/record-validation.ts";
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
