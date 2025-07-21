/**
 * Unit tests for workspace tools
 */

import { assertEquals, assertRejects } from "@std/assert";
import { workspaceTools } from "../../src/workspace.ts";

Deno.test("Workspace Tools", async (t) => {
  await t.step("should have all expected tools", () => {
    const expectedTools = [
      "atlas_workspace_list",
      "atlas_workspace_create",
      "atlas_workspace_delete",
      "atlas_workspace_describe",
    ];

    for (const toolName of expectedTools) {
      assertEquals(toolName in workspaceTools, true);
      assertEquals(typeof workspaceTools[toolName as keyof typeof workspaceTools], "object");
    }
  });

  await t.step("all tools should have required properties", () => {
    for (const [toolName, tool] of Object.entries(workspaceTools)) {
      assertEquals("description" in tool, true, `${toolName} should have description`);
      assertEquals("parameters" in tool, true, `${toolName} should have parameters`);
      assertEquals("execute" in tool, true, `${toolName} should have execute function`);
      assertEquals(typeof tool.execute, "function", `${toolName}.execute should be a function`);
    }
  });
});

Deno.test("atlas_workspace_list tool", async (t) => {
  const tool = workspaceTools.atlas_workspace_list;

  await t.step("should have correct description", () => {
    assertEquals(typeof tool.description, "string");
    assertEquals(tool.description!.includes("Lists all available"), true);
  });

  await t.step("should validate parameters schema", () => {
    const params = tool.parameters;

    // Should accept empty object (no parameters required)
    const validParams = {};
    const result = params.safeParse(validParams);
    assertEquals(result.success, true);
  });

  await t.step("should fail when daemon is not available", async () => {
    await assertRejects(
      () => tool.execute({}, { toolCallId: "test", messages: [] }),
      Error,
      "Failed to list workspaces",
    );
  });
});

Deno.test("atlas_workspace_create tool", async (t) => {
  const tool = workspaceTools.atlas_workspace_create;

  await t.step("should have correct description", () => {
    assertEquals(typeof tool.description, "string");
    assertEquals(tool.description!.includes("Creates a new workspace"), true);
  });

  await t.step("should validate parameters schema", () => {
    const params = tool.parameters;

    // Valid with required name
    const valid1 = { name: "test-workspace" };
    assertEquals(params.safeParse(valid1).success, true);

    // Valid with all optional parameters
    const valid2 = {
      name: "test-workspace",
      description: "Test workspace",
      template: "basic",
      config: { key: "value" },
    };
    assertEquals(params.safeParse(valid2).success, true);
  });

  await t.step("should reject invalid parameters", () => {
    const params = tool.parameters;

    // Missing required name
    const invalid = {};
    assertEquals(params.safeParse(invalid).success, false);
  });

  await t.step("should fail when daemon is not available", async () => {
    await assertRejects(
      () => tool.execute({ name: "test-workspace" }, { toolCallId: "test", messages: [] }),
      Error,
      "Failed to create workspace",
    );
  });
});

Deno.test("atlas_workspace_delete tool", async (t) => {
  const tool = workspaceTools.atlas_workspace_delete;

  await t.step("should have correct description", () => {
    assertEquals(typeof tool.description, "string");
    assertEquals(tool.description!.includes("Removes a workspace"), true);
  });

  await t.step("should validate parameters schema", () => {
    const params = tool.parameters;

    // Valid with required workspaceId
    const valid1 = { workspaceId: "workspace-123" };
    assertEquals(params.safeParse(valid1).success, true);

    // Valid with optional force
    const valid2 = {
      workspaceId: "workspace-123",
      force: true,
    };
    assertEquals(params.safeParse(valid2).success, true);
  });

  await t.step("should reject invalid parameters", () => {
    const params = tool.parameters;

    // Missing required workspaceId
    const invalid = {};
    assertEquals(params.safeParse(invalid).success, false);
  });

  await t.step("should fail when daemon is not available", async () => {
    await assertRejects(
      () => tool.execute({ workspaceId: "test-id" }, { toolCallId: "test", messages: [] }),
      Error,
      "Failed to delete workspace",
    );
  });
});

Deno.test("atlas_workspace_describe tool", async (t) => {
  const tool = workspaceTools.atlas_workspace_describe;

  await t.step("should have correct description", () => {
    assertEquals(typeof tool.description, "string");
    assertEquals(tool.description!.includes("Gets comprehensive"), true);
  });

  await t.step("should validate parameters schema", () => {
    const params = tool.parameters;

    // Valid with required workspaceId
    const valid = { workspaceId: "workspace-123" };
    assertEquals(params.safeParse(valid).success, true);
  });

  await t.step("should reject invalid parameters", () => {
    const params = tool.parameters;

    // Missing required workspaceId
    const invalid = {};
    assertEquals(params.safeParse(invalid).success, false);
  });

  await t.step("should fail when daemon is not available", async () => {
    await assertRejects(
      () => tool.execute({ workspaceId: "test-id" }, { toolCallId: "test", messages: [] }),
      Error,
      "Failed to describe workspace",
    );
  });
});
