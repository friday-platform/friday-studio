/**
 * Tests for ContextProvisioner
 */

import { assertEquals, assertExists, assertStringIncludes } from "jsr:@std/assert";
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

  await t.step("should provision codebase context with legacy job spec", async () => {
    const jobSpec: JobSpecification = {
      name: "test-job",
      description: "Test job",
      execution: {
        strategy: "sequential",
        context: {
          codebase_files: ["README.md"],
          focus_areas: ["project setup", "basic usage"],
        },
        agents: [],
      },
    };

    const context = await provisioner.provisionCodebaseContext(
      "test-agent",
      jobSpec,
      "test-session",
    );

    assertExists(context);
    assertStringIncludes(context, "Analysis Focus Areas");
    assertStringIncludes(context, "project setup");
    assertStringIncludes(context, "basic usage");
    assertStringIncludes(context, "Atlas Codebase Files");
  });

  await t.step("should handle job spec without codebase files", async () => {
    const jobSpec: JobSpecification = {
      name: "test-job",
      description: "Test job",
      execution: {
        strategy: "sequential",
        agents: [],
      },
    };

    const context = await provisioner.provisionCodebaseContext(
      "test-agent",
      jobSpec,
      "test-session",
    );

    assertEquals(context, "");
  });

  await t.step("should handle job spec with invalid codebase_files", async () => {
    const jobSpec: JobSpecification = {
      name: "test-job",
      description: "Test job",
      execution: {
        strategy: "sequential",
        context: {
          codebase_files: "not-an-array" as any,
        },
        agents: [],
      },
    };

    const context = await provisioner.provisionCodebaseContext(
      "test-agent",
      jobSpec,
      "test-session",
    );

    assertEquals(context, "");
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
          codebase_files: [
            "README.md",
            "CLAUDE.md",
            "package.json",
          ],
          focus_areas: ["documentation", "configuration"],
        },
        agents: [],
      },
    };

    const context = await provisioner.provisionCodebaseContext(
      "test-agent",
      jobSpec,
      "test-session",
    );

    assertStringIncludes(context, "documentation");
    assertStringIncludes(context, "configuration");
    // Should contain multiple file sections
    const fileSections = context.split("##").length;
    assertEquals(fileSections >= 2, true); // At least 2 file sections
  });

  await t.step("should cleanup", async () => {
    await provisioner.shutdown();
  });
});
