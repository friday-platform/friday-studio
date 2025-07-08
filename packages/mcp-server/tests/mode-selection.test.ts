/**
 * Tests for MCP server mode selection and tool filtering
 */

import { assertArrayIncludes, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { MODE_CONFIGS, ServerMode, ToolCategory } from "../src/types.ts";
import {
  getToolsForMode,
  INTERNAL_TOOLS,
  isToolAllowedForMode,
  PUBLIC_TOOLS,
  TOOL_METADATA,
} from "../src/tool-categories.ts";

Deno.test("ServerMode enum has correct values", () => {
  assertEquals(ServerMode.INTERNAL, "internal");
  assertEquals(ServerMode.PUBLIC, "public");
});

Deno.test("ToolCategory enum has correct values", () => {
  assertEquals(ToolCategory.INTERNAL, "internal");
  assertEquals(ToolCategory.PUBLIC, "public");
});

Deno.test("MODE_CONFIGS has correct configuration for internal mode", () => {
  const config = MODE_CONFIGS[ServerMode.INTERNAL];

  assertEquals(config.mode, ServerMode.INTERNAL);
  assertEquals(config.serverName, "atlas-internal");
  assertEquals(config.allowedToolCategories, [ToolCategory.INTERNAL, ToolCategory.PUBLIC]);
  assertEquals(config.enableContextInjection, true);
});

Deno.test("MODE_CONFIGS has correct configuration for public mode", () => {
  const config = MODE_CONFIGS[ServerMode.PUBLIC];

  assertEquals(config.mode, ServerMode.PUBLIC);
  assertEquals(config.serverName, "atlas-public");
  assertEquals(config.allowedToolCategories, [ToolCategory.PUBLIC]);
  assertEquals(config.enableContextInjection, false);
});

Deno.test("Internal tools are correctly categorized", () => {
  const expectedInternalTools = [
    "library_store",
    "library_get",
    "library_list",
    "library_stats",
    "library_templates",
    "workspace_jobs_list",
    "workspace_jobs_describe",
    "workspace_sessions_list",
    "workspace_signals_list",
    "workspace_signals_trigger",
    "workspace_agents_list",
    "workspace_agents_describe",
    // Draft management tools (migrated from conversation agent)
    "workspace_draft_create",
    "workspace_draft_update",
    "validate_draft_config",
    "pre_publish_check",
    "publish_workspace",
    "show_draft_config",
    "list_session_drafts",
  ];

  assertEquals([...INTERNAL_TOOLS], expectedInternalTools);
});

Deno.test("Public tools are correctly categorized", () => {
  const expectedPublicTools = [
    "workspace_list",
    "workspace_create",
    "workspace_delete",
    "workspace_describe",
    "session_describe",
    "session_cancel",
  ];

  assertEquals([...PUBLIC_TOOLS], expectedPublicTools);
});

Deno.test("All internal tools have correct metadata", () => {
  for (const toolName of INTERNAL_TOOLS) {
    const metadata = TOOL_METADATA[toolName];

    assertEquals(metadata.category, ToolCategory.INTERNAL);
    assertEquals(metadata.requiresWorkspaceContext, true);
    assertEquals(metadata.accessLevel, "agent");
  }
});

Deno.test("All public tools have correct metadata", () => {
  for (const toolName of PUBLIC_TOOLS) {
    const metadata = TOOL_METADATA[toolName];

    assertEquals(metadata.category, ToolCategory.PUBLIC);
    assertEquals(metadata.requiresWorkspaceContext, false);
  }
});

Deno.test("getToolsForMode returns all tools for internal mode", () => {
  const tools = getToolsForMode(ServerMode.INTERNAL);

  // Should include both internal and public tools
  assertArrayIncludes(tools, [...INTERNAL_TOOLS]);
  assertArrayIncludes(tools, [...PUBLIC_TOOLS]);

  // Should be exactly the sum of internal + public tools
  assertEquals(tools.length, INTERNAL_TOOLS.length + PUBLIC_TOOLS.length);
});

Deno.test("getToolsForMode returns only public tools for public mode", () => {
  const tools = getToolsForMode(ServerMode.PUBLIC);

  // Should include only public tools
  assertArrayIncludes(tools, [...PUBLIC_TOOLS]);

  // Should NOT include any internal tools
  for (const internalTool of INTERNAL_TOOLS) {
    assertEquals(tools.includes(internalTool), false);
  }

  // Should be exactly the public tools
  assertEquals(tools.length, PUBLIC_TOOLS.length);
});

Deno.test("isToolAllowedForMode works correctly for internal mode", () => {
  // Internal tools should be allowed
  for (const toolName of INTERNAL_TOOLS) {
    assertEquals(isToolAllowedForMode(toolName, ServerMode.INTERNAL), true);
  }

  // Public tools should also be allowed
  for (const toolName of PUBLIC_TOOLS) {
    assertEquals(isToolAllowedForMode(toolName, ServerMode.INTERNAL), true);
  }
});

Deno.test("isToolAllowedForMode works correctly for public mode", () => {
  // Internal tools should NOT be allowed
  for (const toolName of INTERNAL_TOOLS) {
    assertEquals(isToolAllowedForMode(toolName, ServerMode.PUBLIC), false);
  }

  // Public tools should be allowed
  for (const toolName of PUBLIC_TOOLS) {
    assertEquals(isToolAllowedForMode(toolName, ServerMode.PUBLIC), true);
  }
});

Deno.test("isToolAllowedForMode returns false for unknown tools", () => {
  assertEquals(isToolAllowedForMode("unknown_tool", ServerMode.INTERNAL), false);
  assertEquals(isToolAllowedForMode("unknown_tool", ServerMode.PUBLIC), false);
});
