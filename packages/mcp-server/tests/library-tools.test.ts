/**
 * Tests for library MCP tools
 * Focuses on tool availability and basic functionality verification
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { type Logger, PlatformMCPServer } from "../src/platform-server.ts";

// Mock logger
const mockLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// Test setup
let server: PlatformMCPServer;

function setupTest() {
  server = new PlatformMCPServer({
    logger: mockLogger,
    daemonUrl: "http://localhost:8080",
  });
}

// Test: library_list tool availability
Deno.test("library_list tool should be available in tool list", () => {
  setupTest();
  const tools = server.getAvailableTools();
  assertEquals(tools.includes("library_list"), true);
});

// Test: library_get tool availability
Deno.test("library_get tool should be available in tool list", () => {
  setupTest();
  const tools = server.getAvailableTools();
  assertEquals(tools.includes("library_get"), true);
});

// Test: library_stats tool availability
Deno.test("library_stats tool should be available in tool list", () => {
  setupTest();
  const tools = server.getAvailableTools();
  assertEquals(tools.includes("library_stats"), true);
});

// Test: library_templates tool availability
Deno.test("library_templates tool should be available in tool list", () => {
  setupTest();
  const tools = server.getAvailableTools();
  assertEquals(tools.includes("library_templates"), true);
});

// Test: All library tools are registered
Deno.test("all library tools should be registered correctly", () => {
  setupTest();
  const tools = server.getAvailableTools();
  const libraryTools = [
    "library_list",
    "library_get",
    "library_stats",
    "library_templates",
  ];

  libraryTools.forEach((tool) => {
    assertEquals(tools.includes(tool), true, `Tool ${tool} should be available`);
  });
});
