/**
 * Tests for FileLoaderTool
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { FileLoaderTool } from "../../src/tools/file-loader-tool.ts";

Deno.test("FileLoaderTool - Basic Functionality", async (t) => {
  const tool = new FileLoaderTool({
    basePath: ".",
    maxFileSize: 10 * 1024, // 10KB
    maxTotalSize: 50 * 1024, // 50KB
  });

  await t.step("should load specific files", async () => {
    const result = await tool.loadSpecificFiles(["README.md"]);

    assertEquals(result.success, true);
    assertEquals(result.files.length >= 1, true);

    const readmeFile = result.files.find((f) => f.relativePath.endsWith("README.md"));
    assertExists(readmeFile);
    assertExists(readmeFile.content);
    assertEquals(readmeFile.extension, ".md");
  });

  await t.step("should handle glob patterns", async () => {
    const result = await tool.loadFiles({
      patterns: ["*.md"],
      maxFiles: 5,
    });

    assertEquals(result.success, true);
    assertEquals(result.files.length >= 1, true);

    // All files should be markdown
    for (const file of result.files) {
      assertEquals(file.extension, ".md");
    }
  });

  await t.step("should list files without content", async () => {
    const result = await tool.listFiles(["src/core/emcp/*.ts"]);

    assertEquals(result.success, true);
    assertEquals(result.files.length >= 1, true);

    // Should not include content
    for (const file of result.files) {
      assertEquals(file.content, undefined);
      assertEquals(file.extension, ".ts");
    }
  });

  await t.step("should respect file limits", async () => {
    const result = await tool.loadFiles({
      patterns: ["src/**/*.ts"],
      maxFiles: 3,
    });

    assertEquals(result.success, true);
    assertEquals(result.files.length <= 3, true);
  });

  await t.step("should format as markdown", async () => {
    const result = await tool.loadSpecificFiles(["README.md"]);
    const markdown = tool.formatAsMarkdown(result, "Test Files");

    assertStringIncludes(markdown, "# Test Files");
    assertStringIncludes(markdown, "## README.md");
    assertStringIncludes(markdown, "```markdown");
  });
});

Deno.test("FileLoaderTool - Error Handling", async (t) => {
  const tool = new FileLoaderTool({
    basePath: ".",
    allowedExtensions: [".ts"],
  });

  await t.step("should handle non-existent files", async () => {
    const result = await tool.loadSpecificFiles(["non-existent-file.ts"]);

    assertEquals(result.success, true);
    assertEquals(result.files.length, 0);
  });

  await t.step("should handle non-matching patterns", async () => {
    const result = await tool.loadFiles({
      patterns: ["non-existent-dir/**/*.xyz"],
    });

    assertEquals(result.success, true);
    assertEquals(result.files.length, 0);
  });

  await t.step("should respect extension filters", async () => {
    const result = await tool.loadFiles({
      patterns: ["*.md"], // .md not in allowed extensions
    });

    assertEquals(result.success, true);
    assertEquals(result.files.length, 0); // Should filter out .md files
  });
});
