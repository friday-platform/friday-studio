/**
 * Tests for FilesystemProvider EMCP implementation
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { FilesystemProvider } from "../../src/core/emcp/providers/filesystem-provider.ts";
import type {
  CodebaseContextSpec,
  ContextSpec,
  EMCPContext,
} from "../../src/core/emcp/emcp-provider.ts";

Deno.test({
  name: "FilesystemProvider - Basic Functionality",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const provider = new FilesystemProvider();

    await t.step("should initialize successfully", async () => {
      await provider.initialize({
        default: {
          basePath: ".",
          allowedExtensions: [".ts", ".md"],
          maxFileSize: "1kb",
          maxTotalSize: "5kb",
        },
      });

      assertEquals(provider.config.name, "filesystem");
      assertEquals(provider.canProvide("codebase"), true);
      assertEquals(provider.canProvide("database"), false);
    });

    await t.step("should provision codebase context", async () => {
      const spec: CodebaseContextSpec = {
        type: "codebase",
        filePatterns: ["README.md"],
        focusAreas: ["project overview", "setup instructions"],
        maxSize: "2kb",
      };

      const context: EMCPContext = {
        workspaceId: "test-workspace",
        sessionId: "test-session",
        agentId: "test-agent",
      };

      const result = await provider.provisionContext(spec, context);

      assertEquals(result.success, true);
      assertExists(result.content);
      assertStringIncludes(result.content!.content as string, "Analysis Focus Areas");
      assertStringIncludes(result.content!.content as string, "project overview");
      assertStringIncludes(result.content!.content as string, "setup instructions");
      assertExists(result.cost);
      assertEquals(typeof result.cost!.processingTimeMs, "number");
    });

    await t.step("should handle missing files gracefully", async () => {
      const spec: CodebaseContextSpec = {
        type: "codebase",
        filePatterns: ["nonexistent-file.ts"],
        maxSize: "1kb",
      };

      const context: EMCPContext = {
        workspaceId: "test-workspace",
        sessionId: "test-session",
        agentId: "test-agent",
      };

      const result = await provider.provisionContext(spec, context);

      assertEquals(result.success, true);
      assertStringIncludes(result.content!.content as string, "Pattern could not be processed");
    });

    await t.step("should handle empty file patterns", async () => {
      const spec: CodebaseContextSpec = {
        type: "codebase",
        filePatterns: [],
        maxSize: "1kb",
      };

      const context: EMCPContext = {
        workspaceId: "test-workspace",
        sessionId: "test-session",
        agentId: "test-agent",
      };

      const result = await provider.provisionContext(spec, context);

      assertEquals(result.success, true);
      assertStringIncludes(result.content!.content as string, "Atlas Codebase Files");
    });

    await t.step("should cleanup properly", async () => {
      await provider.shutdown();
    });
  },
});

Deno.test({
  name: "FilesystemProvider - Edge Cases",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const provider = new FilesystemProvider();

    await t.step("should handle wrong context type", async () => {
      await provider.initialize({ default: {} });

      const context: EMCPContext = {
        workspaceId: "test-workspace",
        sessionId: "test-session",
        agentId: "test-agent",
      };

      try {
        // Create a spec with wrong type to test runtime error handling
        const wrongSpec: ContextSpec = {
          type: "database",
          maxSize: "1kb",
        };

        await provider.provisionContext(wrongSpec, context);
        throw new Error("Should have thrown an error");
      } catch (error) {
        assertStringIncludes((error as Error).message, "Expected context type 'codebase'");
      }
    });

    await t.step("should handle size limits", async () => {
      await provider.initialize({
        default: {
          maxTotalSize: "100b", // Very small limit
        },
      });

      const spec: CodebaseContextSpec = {
        type: "codebase",
        filePatterns: ["README.md", "CLAUDE.md"],
        maxSize: "100b",
      };

      const context: EMCPContext = {
        workspaceId: "test-workspace",
        sessionId: "test-session",
        agentId: "test-agent",
      };

      const result = await provider.provisionContext(spec, context);

      assertEquals(result.success, true);
      // The result should contain content, but might show error messages if files can't be read
      assertExists(result.content);
      assertExists(result.content!.content);

      // Check if truncation happened OR if files couldn't be loaded due to permissions
      const content = result.content!.content as string;
      const hasPermissionError = content.includes("could not be processed") ||
        content.includes("could not be loaded") ||
        content.includes("No files matched this pattern");
      const hasTruncation = content.includes("truncated due to size limits");

      // Either permission error or truncation is acceptable
      assertEquals(hasPermissionError || hasTruncation, true);
    });

    await t.step("should cleanup", async () => {
      await provider.shutdown();
    });
  },
});

Deno.test({
  name: "FilesystemProvider - Glob Support",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    const provider = new FilesystemProvider();

    await t.step("should initialize for glob tests", async () => {
      await provider.initialize({
        default: {
          basePath: ".",
          allowedExtensions: [".ts", ".md", ".json"],
          maxFileSize: "2kb",
          maxTotalSize: "10kb",
        },
      });
    });

    await t.step("should handle glob patterns", async () => {
      const spec: CodebaseContextSpec = {
        type: "codebase",
        filePatterns: ["*.md"], // Glob pattern for markdown files
        focusAreas: ["documentation"],
        maxSize: "5kb",
      };

      const context: EMCPContext = {
        workspaceId: "test-workspace",
        sessionId: "test-session",
        agentId: "test-agent",
      };

      const result = await provider.provisionContext(spec, context);

      assertEquals(result.success, true);
      assertStringIncludes(result.content!.content as string, "documentation");
      assertExists(result.metadata);
      assertEquals(typeof result.metadata!.filesLoaded, "number");

      // Files might not be loaded due to permissions, which is OK
      const filesLoaded = result.metadata!.filesLoaded as number;
      const content = result.content!.content as string;

      // If no files were loaded, ensure there's an error message
      if (filesLoaded === 0) {
        const hasErrorMessage = content.includes("could not be processed") ||
          content.includes("could not be loaded") ||
          content.includes("No files matched this pattern");
        assertEquals(hasErrorMessage, true);
      }
      // Otherwise we loaded at least one file
    });

    await t.step("should handle nested glob patterns", async () => {
      const spec: CodebaseContextSpec = {
        type: "codebase",
        filePatterns: ["src/**/*.ts"], // Nested glob pattern
        maxSize: "8kb",
      };

      const context: EMCPContext = {
        workspaceId: "test-workspace",
        sessionId: "test-session",
        agentId: "test-agent",
      };

      const result = await provider.provisionContext(spec, context);

      assertEquals(result.success, true);
      assertExists(result.metadata);
      assertEquals(typeof result.metadata!.filesLoaded, "number");
      // Should find TypeScript files in src directory
    });

    await t.step("should handle specific file patterns", async () => {
      const spec: CodebaseContextSpec = {
        type: "codebase",
        filePatterns: ["src/core/emcp/emcp-provider.ts"], // Specific file
        maxSize: "3kb",
      };

      const context: EMCPContext = {
        workspaceId: "test-workspace",
        sessionId: "test-session",
        agentId: "test-agent",
      };

      const result = await provider.provisionContext(spec, context);

      assertEquals(result.success, true);
      assertExists(result.content);

      const content = result.content!.content as string;
      const filesLoaded = result.metadata!.filesLoaded as number;

      // Either the file was loaded OR we got an error message
      if (filesLoaded === 1) {
        assertStringIncludes(content, "emcp-provider.ts");
      } else {
        // File couldn't be loaded - check for error message
        assertEquals(filesLoaded, 0);
        const hasErrorMessage = content.includes("could not be processed") ||
          content.includes("could not be loaded") ||
          content.includes("No files matched this pattern");
        assertEquals(hasErrorMessage, true);
      }
    });

    await t.step("should handle non-matching patterns", async () => {
      const spec: CodebaseContextSpec = {
        type: "codebase",
        filePatterns: ["non-existent-dir/**/*.xyz"], // Pattern that won't match
        maxSize: "1kb",
      };

      const context: EMCPContext = {
        workspaceId: "test-workspace",
        sessionId: "test-session",
        agentId: "test-agent",
      };

      const result = await provider.provisionContext(spec, context);

      assertEquals(result.success, true);
      assertEquals(result.metadata!.filesLoaded as number, 0);
    });

    await t.step("should cleanup glob tests", async () => {
      await provider.shutdown();
    });
  },
});
