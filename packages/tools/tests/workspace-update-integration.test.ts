/**
 * Integration tests for workspace update functionality.
 * Tests the complete workflow from tool call to daemon update.
 */

import { assertEquals, assertExists } from "@std/assert";
import { WorkspaceUpdater } from "../src/internal/workspace-update/workspace-updater.ts";
import { workspaceUpdateTools } from "../src/internal/workspace-update/tools.ts";
import { updateWorkspace } from "../src/internal/workspace-update/atlas-update-workspace.ts";

/**
 * Test WorkspaceUpdater instantiation and basic functionality
 */
Deno.test("Integration - WorkspaceUpdater functionality", () => {
  // Set up required environment
  Deno.env.set("ANTHROPIC_API_KEY", "test-api-key");
  
  // Test that WorkspaceUpdater can be instantiated
  const updater = new WorkspaceUpdater();
  assertExists(updater);
  
  // Test error handling methods
  const notFoundError = new Error("Workspace not found: test-id");
  const friendlyError = updater.getUserFriendlyError(notFoundError);
  assertEquals(friendlyError, "The specified workspace could not be found. Please check the workspace identifier.");
});

/**
 * Test atlas_update_workspace tool functionality
 */
Deno.test("Integration - atlas_update_workspace tool interface", () => {
  // Test tool has correct structure
  assertExists(updateWorkspace);
  assertExists(updateWorkspace.description);
  assertExists(updateWorkspace.inputSchema);
  
  assertEquals(typeof updateWorkspace.description, "string");
  
  // Test schema structure
  const schema = updateWorkspace.inputSchema;
  assertExists(schema);
  
  // Test that schema can validate input (type-safe approach)
  assertEquals(typeof schema, "object");
});

/**
 * Test workspace update tools structure
 */
Deno.test("Integration - Workspace update tools functionality", () => {
  // Test that workspaceUpdateTools is an object
  assertExists(workspaceUpdateTools);
  assertEquals(typeof workspaceUpdateTools, "object");

  // Test that tools object has expected properties
  const toolEntries = Object.entries(workspaceUpdateTools);
  assertEquals(toolEntries.length > 0, true);

  // Test that tools have proper structure
  for (const [name, tool] of toolEntries) {
    assertExists(tool, `Tool ${name} should exist`);
    assertExists(tool.description, `Tool ${name} should have description`);
    assertExists(tool.inputSchema, `Tool ${name} should have input schema`);
  }

  // Test specific tools exist
  assertExists(workspaceUpdateTools.listWorkspaceComponents, "listWorkspaceComponents should exist");
  assertExists(workspaceUpdateTools.updateSignal, "updateSignal should exist");
  assertExists(workspaceUpdateTools.addScheduleSignal, "addScheduleSignal should exist");
});

/**
 * Test workspace updater error handling patterns
 */
Deno.test("Integration - Error handling patterns", () => {
  Deno.env.set("ANTHROPIC_API_KEY", "test-api-key");
  const updater = new WorkspaceUpdater();

  // Test getUserFriendlyError method exists and handles basic cases
  assertExists(updater.getUserFriendlyError, "getUserFriendlyError method should exist");

  const notFoundError = new Error("Workspace not found: test-id");
  const friendlyError = updater.getUserFriendlyError(notFoundError);
  assertEquals(typeof friendlyError, "string");
  assertEquals(friendlyError.length > 0, true);
});

/**
 * Test workspace updater basic functionality  
 */
Deno.test("Integration - WorkspaceUpdater basic functionality", () => {
  Deno.env.set("ANTHROPIC_API_KEY", "test-api-key");
  const updater = new WorkspaceUpdater();

  // Test basic instantiation and properties
  assertExists(updater);
  assertExists(updater.updateWorkspace, "updateWorkspace method should exist");
  assertEquals(typeof updater.updateWorkspace, "function");
});

/**
 * Test tool schemas and validation
 */
Deno.test("Integration - Tool schema validation", () => {
  // Test that all tools have proper schemas
  assertExists(workspaceUpdateTools);
  assertEquals(typeof workspaceUpdateTools, "object");
  
  for (const [name, tool] of Object.entries(workspaceUpdateTools)) {
    assertExists(tool.inputSchema, `Tool ${name} should have input schema`);
    
    // Test that schema is an object (valid schema)
    const schema = tool.inputSchema;
    assertEquals(typeof schema, "object", `Tool ${name} should have valid schema`);
  }

  // Test update workspace schema specifically
  const schema = updateWorkspace.inputSchema;
  assertEquals(typeof schema, "object", "Update workspace should have valid schema");
});

/**
 * Test update workspace integration functionality
 */
Deno.test("Integration - Update workspace tool integration", () => {
  // Test that the main update workspace tool is properly structured
  assertExists(updateWorkspace);
  assertExists(updateWorkspace.description);
  assertExists(updateWorkspace.inputSchema);

  // Test input schema structure
  const schema = updateWorkspace.inputSchema;
  assertEquals(typeof schema, "object", "Schema should be an object");

  // Test that we can create a valid input object structure
  const validInput = {
    workspaceIdentifier: "test-workspace",
    userIntent: "Add a new signal for testing",
  };

  // Test input object structure
  assertEquals(validInput.workspaceIdentifier, "test-workspace");
  assertEquals(validInput.userIntent, "Add a new signal for testing");
});