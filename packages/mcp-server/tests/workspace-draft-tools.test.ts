/**
 * Tests for workspace draft management MCP tools
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

// Test: Platform MCP server can be created successfully
Deno.test("platform MCP server should be created successfully", () => {
  const server = new PlatformMCPServer({
    logger: mockLogger,
    daemonUrl: "http://localhost:8080",
  });

  assertExists(server);
  assertExists(server.getServer());
});
