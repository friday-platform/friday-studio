/**
 * Unit tests for AtlasToolRegistry
 */

import { assertEquals, assertThrows } from "@std/assert";
import { AtlasToolRegistry, getAtlasToolRegistry, type ToolCategory } from "../../src/registry.ts";

Deno.test("AtlasToolRegistry", async (t) => {
  await t.step("should create new instances without singleton behavior", () => {
    const registry1 = new AtlasToolRegistry({});
    const registry2 = new AtlasToolRegistry({});

    // They should be different instances
    assertEquals(registry1 === registry2, false);
  });

  await t.step("should have all expected tool categories", () => {
    const registry = getAtlasToolRegistry();
    const categories = registry.getAvailableCategories();

    const expectedCategories = [
      "filesystem",
      "workspace",
      "session",
      "job",
      "signal",
      "agent",
      "library",
      "system",
      "conversation",
      "resource",
    ];

    assertEquals(categories.sort(), expectedCategories.sort());
  });

  await t.step("getAllTools() should return all tools", () => {
    const registry = getAtlasToolRegistry();
    const allTools = registry.getAllTools();

    // Should have tools from all categories
    assertEquals(typeof allTools, "object");
    assertEquals(allTools.constructor, Object);

    // Should have specific tools we know exist
    assertEquals("atlas_read" in allTools, true);
    assertEquals("atlas_workspace_list" in allTools, true);
    assertEquals("atlas_session_cancel" in allTools, true);
    assertEquals("atlas_stream_reply" in allTools, true);
    assertEquals("atlas_conversation_storage" in allTools, true);
  });

  await t.step("getToolsByCategory() should return correct tools", () => {
    const registry = getAtlasToolRegistry();

    // Test filesystem category
    const fsTools = registry.getToolsByCategory("filesystem");
    assertEquals("atlas_read" in fsTools, true);
    assertEquals("atlas_write" in fsTools, true);
    assertEquals("atlas_list" in fsTools, true);
    assertEquals("atlas_glob" in fsTools, true);
    assertEquals("atlas_grep" in fsTools, true);

    // Test workspace category
    const workspaceTools = registry.getToolsByCategory("workspace");
    assertEquals("atlas_workspace_list" in workspaceTools, true);
    assertEquals("atlas_workspace_create" in workspaceTools, true);
    assertEquals("atlas_workspace_delete" in workspaceTools, true);
    assertEquals("atlas_workspace_describe" in workspaceTools, true);

    // Test conversation category
    const conversationTools = registry.getToolsByCategory("conversation");
    assertEquals("atlas_stream_reply" in conversationTools, true);
    assertEquals("atlas_conversation_storage" in conversationTools, true);
  });

  await t.step("getToolsByCategory('all') should return all tools", () => {
    const registry = getAtlasToolRegistry();
    const allTools1 = registry.getAllTools();
    const allTools2 = registry.getToolsByCategory("all");

    assertEquals(Object.keys(allTools1).sort(), Object.keys(allTools2).sort());
  });

  await t.step("getToolsByCategory() should throw for invalid category", () => {
    const registry = getAtlasToolRegistry();

    assertThrows(
      () => registry.getToolsByCategory("invalid" as ToolCategory),
      Error,
      "Unknown tool category: invalid",
    );
  });

  await t.step("getToolByName() should return specific tool", () => {
    const registry = getAtlasToolRegistry();

    const readTool = registry.getToolByName("atlas_read");
    assertEquals(readTool !== null, true);
    if (readTool) {
      assertEquals("execute" in readTool, true);
      assertEquals("inputSchema" in readTool, true);
      assertEquals("description" in readTool, true);
    }
  });

  await t.step("getToolByName() should return null for non-existent tool", () => {
    const registry = getAtlasToolRegistry();

    const result = registry.getToolByName("non_existent_tool");
    assertEquals(result, null);
  });

  await t.step("hasTools() should correctly identify tool existence", () => {
    const registry = getAtlasToolRegistry();

    assertEquals(registry.hasTools("atlas_read"), true);
    assertEquals(registry.hasTools("atlas_workspace_list"), true);
    assertEquals(registry.hasTools("non_existent_tool"), false);
  });

  await t.step("getToolNamesByCategory() should return correct tool names", () => {
    const registry = getAtlasToolRegistry();

    const fsToolNames = registry.getToolNamesByCategory("filesystem");
    assertEquals(fsToolNames.includes("atlas_read"), true);
    assertEquals(fsToolNames.includes("atlas_write"), true);
    assertEquals(fsToolNames.includes("atlas_list"), true);
    assertEquals(fsToolNames.includes("atlas_glob"), true);
    assertEquals(fsToolNames.includes("atlas_grep"), true);
  });

  await t.step("getAllToolNames() should return all tool names", () => {
    const registry = getAtlasToolRegistry();
    const allToolNames = registry.getAllToolNames();

    // Should include tools from various categories
    assertEquals(allToolNames.includes("atlas_read"), true);
    assertEquals(allToolNames.includes("atlas_workspace_list"), true);
    assertEquals(allToolNames.includes("atlas_session_cancel"), true);
    assertEquals(allToolNames.includes("atlas_library_list"), true);
  });

  await t.step("getToolsCountByCategory() should return correct counts", () => {
    const registry = getAtlasToolRegistry();

    // Filesystem should have 5 tools
    assertEquals(registry.getToolsCountByCategory("filesystem"), 5);

    // Workspace should have 6 tools
    assertEquals(registry.getToolsCountByCategory("workspace"), 6);

    // Session should have 2 tools
    assertEquals(registry.getToolsCountByCategory("session"), 2);
  });

  await t.step("getSummary() should return correct summary", () => {
    const registry = getAtlasToolRegistry();
    const summary = registry.getSummary();

    assertEquals(typeof summary, "object");
    assertEquals("totalTools" in summary, true);
    assertEquals("categories" in summary, true);
    assertEquals(typeof summary.totalTools, "number");
    assertEquals(typeof summary.categories, "object");

    // Should have all expected categories in summary
    const expectedCategories = [
      "filesystem",
      "workspace",
      "session",
      "job",
      "signal",
      "agent",
      "library",
      "system",
    ];
    for (const category of expectedCategories) {
      assertEquals(category in summary.categories, true);
      assertEquals(typeof summary.categories[category], "number");
    }
  });
});

Deno.test("getAtlasToolRegistry function", async (t) => {
  await t.step("should return same instance on multiple calls", () => {
    const registry1 = getAtlasToolRegistry();
    const registry2 = getAtlasToolRegistry();

    // Should return the same default instance
    assertEquals(registry1 === registry2, true);
    assertEquals(registry1 instanceof AtlasToolRegistry, true);
  });

  await t.step("should be different from new AtlasToolRegistry()", () => {
    const defaultRegistry = getAtlasToolRegistry();
    const newRegistry = new AtlasToolRegistry({});

    // Should be different instances
    assertEquals(defaultRegistry === newRegistry, false);

    // But should have same functionality when newRegistry has tools
    const fullyConfiguredRegistry = new AtlasToolRegistry({
      filesystem: defaultRegistry.getToolsByCategory("filesystem"),
      workspace: defaultRegistry.getToolsByCategory("workspace"),
      session: defaultRegistry.getToolsByCategory("session"),
      job: defaultRegistry.getToolsByCategory("job"),
      signal: defaultRegistry.getToolsByCategory("signal"),
      agent: defaultRegistry.getToolsByCategory("agent"),
      library: defaultRegistry.getToolsByCategory("library"),
      system: defaultRegistry.getToolsByCategory("system"),
      conversation: defaultRegistry.getToolsByCategory("conversation"),
      resource: defaultRegistry.getToolsByCategory("resource"),
    });

    assertEquals(
      Object.keys(defaultRegistry.getAllTools()).sort(),
      Object.keys(fullyConfiguredRegistry.getAllTools()).sort(),
    );
  });
});
