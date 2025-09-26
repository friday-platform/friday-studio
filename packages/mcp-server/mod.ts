/**
 * @atlas/mcp-server
 * MCP server implementations for Atlas platform
 */

import { artifactsDeleteTool } from "./src/tools/artifacts/delete.ts";

export {
  type Logger,
  PlatformMCPServer,
  type PlatformMCPServerDependencies,
} from "./src/platform-server.ts";

export { WorkspaceMCPServer, type WorkspaceMCPServerDependencies } from "./src/workspace-server.ts";

// These tools are not available to every agent or the SDK. They can be added on a per-agent basis when necessary (for now this only includes the conversation agent).
export { artifactsDeleteTool };
