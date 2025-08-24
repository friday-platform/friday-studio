import { assertExists } from "@std/assert";
import { createAndRegisterWorkspace } from "../../src/cli/modules/workspaces/creator.ts";

Deno.test({
  name: "createWorkspace - creates workspace in current directory",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const testPath = "./test-workspace-current";

    try {
      await createAndRegisterWorkspace({ name: "Test Workspace Current", path: testPath });

      // Check that workspace.yml was created
      const workspaceFile = `${testPath}/workspace.yml`;
      const content = await Deno.readTextFile(workspaceFile);

      // Verify content contains expected values
      assertExists(content.match(/name: Test Workspace Current/));
      assertExists(content.match(/description: 'Atlas workspace: Test Workspace Current'/));
      assertExists(content.match(/version: '1.0'/));
    } finally {
      // Cleanup
      try {
        await Deno.remove(testPath, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  },
});

Deno.test({
  name: "createWorkspace - creates workspace in nested directory",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const testPath = "./test-workspaces/nested/deep/workspace";

    try {
      await createAndRegisterWorkspace({
        name: "Nested Test Workspace",
        path: testPath,
        description: "A test workspace in nested directories",
      });

      // Check that workspace.yml was created
      const workspaceFile = `${testPath}/workspace.yml`;
      const content = await Deno.readTextFile(workspaceFile);

      // Verify content contains expected values
      assertExists(content.match(/name: Nested Test Workspace/));
      assertExists(content.match(/description: A test workspace in nested directories/));
    } finally {
      // Cleanup
      try {
        await Deno.remove("./test-workspaces", { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  },
});

Deno.test({
  name: "createWorkspace - creates workspace with absolute path",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const testPath = `${Deno.cwd()}/test-workspace-absolute`;

    try {
      await createAndRegisterWorkspace({ name: "Absolute Path Workspace", path: testPath });

      // Check that workspace.yml was created
      const workspaceFile = `${testPath}/workspace.yml`;
      const content = await Deno.readTextFile(workspaceFile);

      // Verify content contains expected values
      assertExists(content.match(/name: Absolute Path Workspace/));
      // Note: The creator function creates empty signals/jobs/agents objects, not examples
      assertExists(content.match(/signals: \{\}/));
      assertExists(content.match(/jobs: \{\}/));
      assertExists(content.match(/agents: \{\}/));
    } finally {
      // Cleanup
      try {
        await Deno.remove(testPath, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  },
});

Deno.test({
  name: "createWorkspace - handles special characters in name",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const testPath = "./test-workspace-special";

    try {
      await createAndRegisterWorkspace({ name: "My Workspace & Co. (v2.0)", path: testPath });

      // Check that workspace.yml was created
      const workspaceFile = `${testPath}/workspace.yml`;
      const content = await Deno.readTextFile(workspaceFile);

      // Verify special characters are preserved in YAML
      assertExists(content.match(/name: My Workspace & Co\. \(v2\.0\)/));
    } finally {
      // Cleanup
      try {
        await Deno.remove(testPath, { recursive: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  },
});
