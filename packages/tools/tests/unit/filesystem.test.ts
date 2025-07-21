/**
 * Unit tests for filesystem tools
 */

import { assertEquals, assertRejects } from "@std/assert";
import { filesystemTools } from "../../src/filesystem.ts";

Deno.test("Filesystem Tools", async (t) => {
  await t.step("should have all expected tools", () => {
    const expectedTools = [
      "atlas_read",
      "atlas_write",
      "atlas_list",
      "atlas_glob",
      "atlas_grep",
    ];

    for (const toolName of expectedTools) {
      assertEquals(toolName in filesystemTools, true);
      assertEquals(typeof filesystemTools[toolName as keyof typeof filesystemTools], "object");
    }
  });

  await t.step("all tools should have required properties", () => {
    for (const [toolName, tool] of Object.entries(filesystemTools)) {
      assertEquals("description" in tool, true, `${toolName} should have description`);
      assertEquals("parameters" in tool, true, `${toolName} should have parameters`);
      assertEquals("execute" in tool, true, `${toolName} should have execute function`);
      assertEquals(typeof tool.execute, "function", `${toolName}.execute should be a function`);
    }
  });
});

Deno.test("atlas_read tool", async (t) => {
  const tool = filesystemTools.atlas_read;

  await t.step("should have correct description", () => {
    assertEquals(typeof tool.description, "string");
    assertEquals(tool.description!.includes("Reads files"), true);
  });

  await t.step("should validate parameters schema", () => {
    const params = tool.parameters;
    assertEquals(typeof params, "object");

    // Test valid parameters
    const validParams = { filePath: "/test/path.txt" };
    const result = params.safeParse(validParams);
    assertEquals(result.success, true);

    // Test with optional parameters
    const validWithOptional = {
      filePath: "/test/path.txt",
      offset: 10,
      limit: 100,
    };
    const resultOptional = params.safeParse(validWithOptional);
    assertEquals(resultOptional.success, true);
  });

  await t.step("should reject invalid parameters", () => {
    const params = tool.parameters;

    // Missing required filePath
    const invalid1 = {};
    assertEquals(params.safeParse(invalid1).success, false);

    // Wrong type for offset
    const invalid2 = { filePath: "/test", offset: "not a number" };
    assertEquals(params.safeParse(invalid2).success, false);
  });

  await t.step("should fail for non-existent file", async () => {
    await assertRejects(
      () =>
        tool.execute({ filePath: "/non/existent/file.txt" }, { toolCallId: "test", messages: [] }),
      Error,
      "Failed to read file",
    );
  });
});

Deno.test("atlas_write tool", async (t) => {
  const tool = filesystemTools.atlas_write;

  await t.step("should have correct description", () => {
    assertEquals(typeof tool.description, "string");
    assertEquals(tool.description!.includes("Writes content"), true);
  });

  await t.step("should validate parameters schema", () => {
    const params = tool.parameters;

    const validParams = {
      filePath: "/test/output.txt",
      content: "test content",
    };
    const result = params.safeParse(validParams);
    assertEquals(result.success, true);
  });

  await t.step("should reject invalid parameters", () => {
    const params = tool.parameters;

    // Missing required parameters
    const invalid1 = { filePath: "/test" };
    assertEquals(params.safeParse(invalid1).success, false);

    const invalid2 = { content: "test" };
    assertEquals(params.safeParse(invalid2).success, false);
  });
});

Deno.test("atlas_list tool", async (t) => {
  const tool = filesystemTools.atlas_list;

  await t.step("should have correct description", () => {
    assertEquals(typeof tool.description, "string");
    assertEquals(tool.description!.includes("Lists directory"), true);
  });

  await t.step("should validate parameters schema", () => {
    const params = tool.parameters;

    // Valid with no parameters (uses defaults)
    const valid1 = {};
    assertEquals(params.safeParse(valid1).success, true);

    // Valid with path
    const valid2 = { path: "/some/path" };
    assertEquals(params.safeParse(valid2).success, true);

    // Valid with ignore patterns
    const valid3 = {
      path: "/some/path",
      ignore: ["*.log", "node_modules"],
    };
    assertEquals(params.safeParse(valid3).success, true);
  });

  await t.step("should fail for non-existent directory", async () => {
    await assertRejects(
      () => tool.execute({ path: "/non/existent/directory" }, { toolCallId: "test", messages: [] }),
      Error,
      "Failed to list directory",
    );
  });
});

Deno.test("atlas_glob tool", async (t) => {
  const tool = filesystemTools.atlas_glob;

  await t.step("should have correct description", () => {
    assertEquals(typeof tool.description, "string");
    assertEquals(tool.description!.includes("glob"), true);
  });

  await t.step("should validate parameters schema", () => {
    const params = tool.parameters;

    // Valid with required pattern
    const valid1 = { pattern: "**/*.ts" };
    assertEquals(params.safeParse(valid1).success, true);

    // Valid with optional path
    const valid2 = {
      pattern: "**/*.js",
      path: "/some/path",
    };
    assertEquals(params.safeParse(valid2).success, true);
  });

  await t.step("should reject invalid parameters", () => {
    const params = tool.parameters;

    // Missing required pattern
    const invalid = {};
    assertEquals(params.safeParse(invalid).success, false);
  });
});

Deno.test("atlas_grep tool", async (t) => {
  const tool = filesystemTools.atlas_grep;

  await t.step("should have correct description", () => {
    assertEquals(typeof tool.description, "string");
    assertEquals(tool.description!.includes("search"), true);
  });

  await t.step("should validate parameters schema", () => {
    const params = tool.parameters;

    // Valid with required pattern
    const valid1 = { pattern: "test" };
    assertEquals(params.safeParse(valid1).success, true);

    // Valid with all optional parameters
    const valid2 = {
      pattern: "error",
      path: "/logs",
      include: "*.log",
    };
    assertEquals(params.safeParse(valid2).success, true);
  });

  await t.step("should reject invalid parameters", () => {
    const params = tool.parameters;

    // Missing required pattern
    const invalid = {};
    assertEquals(params.safeParse(invalid).success, false);
  });

  await t.step("should handle search gracefully when tools are not available", async () => {
    // This test ensures the tool doesn't crash when ripgrep/grep are not available
    const result = await tool.execute({
      pattern: "nonexistent_pattern_that_will_not_match",
      path: "/tmp",
    }, { toolCallId: "test", messages: [] });

    assertEquals(typeof result, "object");
    assertEquals("matches" in result, true);
    assertEquals("count" in result, true);
    assertEquals("tool" in result, true);
  });
});
