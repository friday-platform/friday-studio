/**
 * End-to-end integration test for workspace add reading name from workspace.yml
 */

import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { AtlasDaemon } from "@atlas/atlasd";
import { AtlasClient } from "@atlas/client";
// Tests will use client API for verification instead of direct workspace manager access

// Helper to create a test workspace directory with workspace.yml
async function createTestWorkspaceWithYaml(
  basePath: string,
  dirName: string,
  workspaceName: string,
  workspaceDescription?: string,
): Promise<string> {
  const workspacePath = join(basePath, dirName);
  await ensureDir(workspacePath);

  // Create a workspace.yml with the specified name that matches v2 schema
  const workspaceYml = `version: "1.0"

workspace:
  name: "${workspaceName}"${
    workspaceDescription
      ? `
  description: "${workspaceDescription}"`
      : ""
  }

signals:
  test-signal:
    provider: http
    description: Test signal for integration tests
    config:
      path: /test-signal

jobs:
  test-job:
    name: test-job
    description: Test job for integration tests
    execution:
      agents: ["test-agent"]
      strategy: sequential

agents:
  test-agent:
    type: llm
    description: Test agent for integration tests
    config:
      model: claude-3-5-sonnet-20241022
      prompt: |
        You are a test agent for integration tests. 
        Please respond to requests in a helpful and concise manner.
`;

  await Deno.writeTextFile(join(workspacePath, "workspace.yml"), workspaceYml);
  return workspacePath;
}

// Helper to reset state between tests
async function resetTestState() {
  // Workspace manager cleanup now handled by daemon shutdown
  // Clear any persisted data
  const testKvPath = join(Deno.env.get("HOME") || "", ".atlas", "test.db");
  try {
    await Deno.remove(testKvPath);
  } catch {
    // Ignore if doesn't exist
  }
}

// Initialize clean state before each test
await resetTestState();

Deno.test({
  name: "Workspace Add E2E - Reads workspace name from workspace.yml",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetTestState();
    const testDir = await Deno.makeTempDir({ prefix: "atlas-yaml-name-e2e-" });
    const port = 10000 + Math.floor(Math.random() * 10000);
    const daemon = new AtlasDaemon({ port });

    try {
      // Start daemon
      await daemon.initialize();
      await daemon.startNonBlocking();

      // Create test workspace with specific name in YAML
      const workspacePath = await createTestWorkspaceWithYaml(
        testDir,
        "directory-name",
        "My Custom Workspace Name",
        "This is my workspace description",
      );

      // Add workspace without providing a name
      const client = new AtlasClient({ url: `http://localhost:${port}` });
      const result = await client.addWorkspace({
        path: workspacePath,
      });

      // Verify it used the name from workspace.yml, not the directory name
      assertExists(result.id);
      assertEquals(result.name, "My Custom Workspace Name");
      assertEquals(result.description, "This is my workspace description");
      assertEquals(result.status, "stopped");

      // Clean up
      await client.deleteWorkspace(result.id);
    } finally {
      await daemon.shutdown();
      await Deno.remove(testDir, { recursive: true });
      await resetTestState();
    }
  },
});

Deno.test({
  name: "Workspace Add E2E - CLI provided name overrides workspace.yml",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetTestState();
    const testDir = await Deno.makeTempDir({ prefix: "atlas-yaml-override-e2e-" });
    const port = 10000 + Math.floor(Math.random() * 10000);
    const daemon = new AtlasDaemon({ port });

    try {
      // Start daemon
      await daemon.initialize();
      await daemon.startNonBlocking();

      // Create test workspace with name in YAML
      const workspacePath = await createTestWorkspaceWithYaml(
        testDir,
        "my-directory",
        "YAML Workspace Name",
        "YAML Description",
      );

      // Add workspace WITH a provided name
      const client = new AtlasClient({ url: `http://localhost:${port}` });
      const result = await client.addWorkspace({
        path: workspacePath,
        name: "CLI Override Name",
        description: "CLI Override Description",
      });

      // Verify it used the CLI provided name, not the YAML name
      assertExists(result.id);
      assertEquals(result.name, "CLI Override Name");
      assertEquals(result.description, "CLI Override Description");

      // Clean up
      await client.deleteWorkspace(result.id);
    } finally {
      await daemon.shutdown();
      await Deno.remove(testDir, { recursive: true });
      await resetTestState();
    }
  },
});

Deno.test({
  name: "Workspace Add E2E - Batch operation reads names from workspace.yml",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await resetTestState();
    const testDir = await Deno.makeTempDir({ prefix: "atlas-yaml-batch-e2e-" });
    const port = 10000 + Math.floor(Math.random() * 10000);
    const daemon = new AtlasDaemon({ port });

    try {
      // Start daemon
      await daemon.initialize();
      await daemon.startNonBlocking();

      // Create multiple workspaces with different names
      const workspace1 = await createTestWorkspaceWithYaml(
        testDir,
        "dir-one",
        "First Workspace Name",
      );
      const workspace2 = await createTestWorkspaceWithYaml(
        testDir,
        "dir-two",
        "Second Workspace Name",
      );
      const workspace3 = await createTestWorkspaceWithYaml(
        testDir,
        "dir-three",
        "Third Workspace Name",
      );

      // Batch add all workspaces
      const client = new AtlasClient({ url: `http://localhost:${port}` });
      const result = await client.addWorkspaces({
        paths: [workspace1, workspace2, workspace3],
      });

      // Verify all were added with names from YAML
      assertEquals(result.added.length, 3);
      assertEquals(result.failed.length, 0);

      // Check each workspace has the correct name from YAML
      const names = result.added.map((w) => w.name).sort();
      assertEquals(names, [
        "First Workspace Name",
        "Second Workspace Name",
        "Third Workspace Name",
      ]);

      // Clean up
      for (const workspace of result.added) {
        await client.deleteWorkspace(workspace.id);
      }
    } finally {
      await daemon.shutdown();
      await Deno.remove(testDir, { recursive: true });
      await resetTestState();
    }
  },
});
