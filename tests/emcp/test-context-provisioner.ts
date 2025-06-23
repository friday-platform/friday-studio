/**
 * Tests for ContextProvisioner
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import { ContextProvisioner } from "../../src/core/context/context-provisioner.ts";
import type { JobSpecification } from "../../src/core/session-supervisor.ts";

Deno.test("ContextProvisioner - Basic Functionality", async (t) => {
  const provisioner = new ContextProvisioner({
    workspaceId: "test-workspace",
  });

  await t.step("should initialize successfully", async () => {
    await provisioner.initialize();

    const availableTypes = provisioner.getAvailableContextTypes();
    assertEquals(availableTypes.includes("codebase"), true);
    assertEquals(provisioner.canProvideContext("codebase"), true);
    assertEquals(provisioner.canProvideContext("database"), false);
  });

  await t.step("should provision filesystem context with new job spec format", async () => {
    const jobSpec: JobSpecification = {
      name: "test-job",
      description: "Test job",
      execution: {
        strategy: "sequential",
        context: {
          filesystem: {
            patterns: ["README.md"],
            include_content: true,
          },
        },
        agents: [],
      },
    };

    const context = await provisioner.provisionFilesystemContext(
      "test-agent",
      jobSpec,
      "test-session",
    );

    assertExists(context);
    assertStringIncludes(context, "README.md");
  });

  await t.step("should handle job spec without filesystem context", async () => {
    const jobSpec: JobSpecification = {
      name: "test-job",
      description: "Test job",
      execution: {
        strategy: "sequential",
        agents: [],
      },
    };

    const context = await provisioner.provisionFilesystemContext(
      "test-agent",
      jobSpec,
      "test-session",
    );

    assertEquals(context, "");
  });

  await t.step("should handle job spec with empty patterns", async () => {
    const jobSpec: JobSpecification = {
      name: "test-job",
      description: "Test job",
      execution: {
        strategy: "sequential",
        context: {
          filesystem: {
            patterns: [],
          },
        },
        agents: [],
      },
    };

    const context = await provisioner.provisionFilesystemContext(
      "test-agent",
      jobSpec,
      "test-session",
    );

    // The filesystem provider returns a header even with no files
    assertExists(context);
    assertStringIncludes(context, "Atlas Codebase Files");
  });

  await t.step("should shutdown properly", async () => {
    await provisioner.shutdown();
  });
});

Deno.test("ContextProvisioner - Advanced Scenarios", async (t) => {
  const provisioner = new ContextProvisioner({
    workspaceId: "test-workspace-advanced",
  });

  await t.step("should initialize with custom sources", async () => {
    const sources = new Map([
      ["custom-fs", {
        name: "custom-fs",
        provider: "filesystem",
        config: {
          basePath: "/custom/path",
          maxFileSize: "2kb",
        },
      }],
    ]);

    await provisioner.initialize(sources);
    assertEquals(provisioner.canProvideContext("codebase"), true);
  });

  await t.step("should handle multiple file patterns", async () => {
    const jobSpec: JobSpecification = {
      name: "multi-file-job",
      description: "Test job with multiple files",
      execution: {
        strategy: "sequential",
        context: {
          filesystem: {
            patterns: [
              "README.md",
              "CLAUDE.md",
              "package.json",
            ],
            include_content: true,
          },
        },
        agents: [],
      },
    };

    const context = await provisioner.provisionFilesystemContext(
      "test-agent",
      jobSpec,
      "test-session",
    );

    // Since we're loading actual files, check that we got some content
    assertExists(context);
    // The context should contain file content
    const hasContent = context.length > 0;
    assertEquals(hasContent, true);
  });

  await t.step("should handle filesystem context with custom settings", async () => {
    const jobSpec: JobSpecification = {
      name: "custom-settings-job",
      description: "Test job with custom filesystem settings",
      execution: {
        strategy: "sequential",
        context: {
          filesystem: {
            patterns: ["*.md"],
            base_path: ".",
            max_file_size: 1024, // 1kb
            include_content: true,
          },
        },
        agents: [],
      },
    };

    const context = await provisioner.provisionFilesystemContext(
      "test-agent",
      jobSpec,
      "test-session",
    );

    // Should get some markdown files
    assertExists(context);
    const hasContent = context.length > 0;
    assertEquals(hasContent, true);
  });

  await t.step("should cleanup", async () => {
    await provisioner.shutdown();
  });
});
