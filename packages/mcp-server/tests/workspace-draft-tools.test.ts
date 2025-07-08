/**
 * Tests for workspace draft management MCP tools
 */

import { assertEquals, assertExists } from "@std/assert";
import { AtlasLogger } from "../../../src/utils/logger.ts";
import { type Logger, PlatformMCPServer } from "../src/platform-server.ts";
import { ServerMode } from "../src/types.ts";

let server: PlatformMCPServer;

// Mock logger for testing
const mockLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function setupTest() {
  if (!server) {
    server = new PlatformMCPServer({
      logger: mockLogger,
      mode: ServerMode.INTERNAL,
      daemonUrl: "http://localhost:8080",
    });
  }
}

// Test: Draft tools are properly categorized as internal
Deno.test("workspace draft tools should be categorized as internal tools", () => {
  setupTest();
  const tools = server.getAvailableTools();

  const draftTools = [
    "workspace_draft_create",
    "workspace_draft_update",
    "validate_draft_config",
    "pre_publish_check",
    "publish_workspace",
    "show_draft_config",
    "list_session_drafts",
  ];

  draftTools.forEach((tool) => {
    assertEquals(
      tools.includes(tool),
      true,
      `Draft tool ${tool} should be available in internal mode`,
    );
  });
});

// Test: Draft tools should not be available in public mode
Deno.test("workspace draft tools should not be available in public mode", () => {
  const publicServer = new PlatformMCPServer({
    logger: mockLogger,
    mode: ServerMode.PUBLIC,
    daemonUrl: "http://localhost:8080",
  });

  const tools = publicServer.getAvailableTools();

  const draftTools = [
    "workspace_draft_create",
    "workspace_draft_update",
    "validate_draft_config",
    "pre_publish_check",
    "publish_workspace",
    "show_draft_config",
    "list_session_drafts",
  ];

  draftTools.forEach((tool) => {
    assertEquals(
      tools.includes(tool),
      false,
      `Draft tool ${tool} should not be available in public mode`,
    );
  });
});

// Test: Server should have expected name and mode
Deno.test("server should be properly configured", () => {
  setupTest();
  assertEquals(server.getMode(), ServerMode.INTERNAL);
  assertEquals(server.getServerName(), "atlas-internal");
});

// Test: Tool metadata should be properly defined
Deno.test("draft tools should have proper metadata", () => {
  setupTest();

  // This test verifies that the tools are properly registered
  // by checking they appear in the available tools list
  const tools = server.getAvailableTools();

  assertEquals(tools.includes("workspace_draft_create"), true);
  assertEquals(tools.includes("workspace_draft_update"), true);
  assertEquals(tools.includes("validate_draft_config"), true);
  assertEquals(tools.includes("pre_publish_check"), true);
  assertEquals(tools.includes("publish_workspace"), true);
  assertEquals(tools.includes("show_draft_config"), true);
  assertEquals(tools.includes("list_session_drafts"), true);
});

// Test: library_search should not be available (removed)
Deno.test("library_search should not be available (removed in standardization)", () => {
  setupTest();
  const tools = server.getAvailableTools();
  assertEquals(tools.includes("library_search"), false, "library_search should be removed");
});

// Test: library_list should still be available as replacement
Deno.test("library_list should be available as library_search replacement", () => {
  setupTest();
  const tools = server.getAvailableTools();
  assertEquals(tools.includes("library_list"), true, "library_list should be available");
  assertEquals(tools.includes("library_get"), true, "library_get should be available");
});

// Test: Basic tool count validation
Deno.test("internal mode should have expected tool count", () => {
  setupTest();
  const tools = server.getAvailableTools();

  // Should have all library tools + all workspace tools + all draft tools
  // Without library_search but with all new draft tools
  const minExpectedTools = 15; // Rough count, may vary as tools are added
  assertEquals(
    tools.length >= minExpectedTools,
    true,
    `Should have at least ${minExpectedTools} tools, got ${tools.length}: ${tools.join(", ")}`,
  );
});
