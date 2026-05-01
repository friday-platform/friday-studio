/**
 * MCP tools for FSM engine operations
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFSMCreateTool } from "./create-fsm.ts";
import { registerFSMToYAMLTool } from "./fsm-to-yaml.ts";
import { registerFSMTestCreateTool } from "./test-create.ts";
import { registerFSMTestRunTool } from "./test-run.ts";
import { registerFSMTestSuiteRunTool } from "./test-suite-run.ts";
import { registerFSMValidateTool } from "./validate-fsm.ts";

/**
 * Register all FSM engine MCP tools
 * @param server The MCP server instance to register tools with
 */
export function registerFSMTools(server: McpServer): void {
  // FSM definition tools
  registerFSMCreateTool(server);
  registerFSMValidateTool(server);
  registerFSMToYAMLTool(server);

  // FSM testing tools
  registerFSMTestCreateTool(server);
  registerFSMTestRunTool(server);
  registerFSMTestSuiteRunTool(server);
}

export {
  registerFSMCreateTool,
  registerFSMTestCreateTool,
  registerFSMTestRunTool,
  registerFSMTestSuiteRunTool,
  registerFSMToYAMLTool,
  registerFSMValidateTool,
};
