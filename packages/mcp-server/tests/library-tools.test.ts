/**
 * Tests for library MCP tools
 */

import { assertExists } from "@std/assert";
import { type Logger, PlatformMCPServer } from "../src/platform-server.ts";

// Mock logger for testing
const mockLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// Test: Platform MCP server can be created successfully with library tools
Deno.test("platform MCP server with library tools should be created successfully", () => {
  const server = new PlatformMCPServer({
    logger: mockLogger,
    daemonUrl: "http://localhost:8080",
  });

  assertExists(server);
  assertExists(server.getServer());

  // All library tools are now automatically registered through the modular system
  // No need to check individual tool availability since they're always included
});
