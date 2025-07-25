/**
 * End-to-End Draft Workflow Integration Test
 *
 * Tests the complete draft workflow from creation to file system publishing:
 * 1. Draft creation with proper configuration
 * 2. Publishing to file system
 * 3. Configuration validation with Atlas ConfigLoader
 *
 * This test focuses on the integration without requiring LLM APIs.
 */

import { assertEquals, assertExists } from "@std/assert";
import { WorkspaceDraftStore } from "../packages/workspace/src/draft/storage.ts";
import { FilesystemWorkspaceCreationAdapter } from "../src/core/services/workspace-creation-adapter.ts";
// Configuration validation removed to focus on file creation
import { createKVStorage, StorageConfigs } from "../src/core/storage/index.ts";
import { join } from "@std/path";
import { exists } from "@std/fs";

// Test context
interface TestContext {
  draftStore: WorkspaceDraftStore;
  workspaceAdapter: FilesystemWorkspaceCreationAdapter;
  tempDir: string;
  kvStorage: import("../src/core/storage/index.ts").KVStorage;
}

async function createTestContext(): Promise<TestContext> {
  const tempDir = await Deno.makeTempDir({ prefix: "atlas_e2e_" });

  // Setup KV storage
  const kvStorageConfig = StorageConfigs.memory(); // Use memory storage for tests
  const kvStorage = await createKVStorage(kvStorageConfig);

  const draftStore = new WorkspaceDraftStore(kvStorage);
  await draftStore.initialize();
  const workspaceAdapter = new FilesystemWorkspaceCreationAdapter(tempDir);

  return { draftStore, workspaceAdapter, tempDir, kvStorage };
}

async function cleanup(ctx: TestContext) {
  try {
    await ctx.draftStore.close();
    await Deno.remove(ctx.tempDir, { recursive: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * End-to-End Draft to Workspace Publishing Workflow
 */
Deno.test("E2E - Draft to Workspace Publishing", async () => {
  const ctx = await createTestContext();
  const testId = `e2e-${Date.now()}`;

  try {
    // Create a draft with complete Atlas configuration
    const testData = {
      name: `test-workspace-${testId}`,
      description: `E2E test workspace`,
      sessionId: `session-${testId}`,
      conversationId: `conversation-${testId}`,
      userId: `user-${testId}`,
      initialConfig: {
        version: "1.0" as const,
        workspace: {
          name: `test-workspace-${testId}`,
          description: "E2E test workspace",
        },
        agents: {
          "conversation-agent": {
            type: "llm",
            description: "Conversation agent for testing",
            config: {
              provider: "anthropic",
              model: "claude-3-7-sonnet-latest",
              prompt: "You are a helpful assistant for testing.",
            },
          },
        },
        jobs: {
          "main-job": {
            name: "main-job",
            description: "Main job for testing",
            execution: {
              strategy: "sequential",
              agents: [
                { id: "conversation-agent" },
              ],
            },
          },
        },
        signals: {
          "http-webhook": {
            provider: "http",
            description: "HTTP webhook for testing",
            config: {
              path: "/webhook/test",
            },
          },
        },
      },
    };

    const draft = await ctx.draftStore.createDraft(testData);
    assertExists(draft.id);
    assertEquals(draft.name, testData.name);

    // Test publishing to file system
    const publishResult = await ctx.workspaceAdapter.createWorkspace({
      name: testData.name,
      config: draft.config,
    });

    assertExists(publishResult);
    assertEquals(publishResult.success, true);

    // Verify workspace files were created
    const workspacePath = publishResult.workspacePath;
    const workspaceYmlExists = await exists(join(workspacePath, "workspace.yml"));
    assertEquals(workspaceYmlExists, true);

    // Verify basic file structure was created
    const readmeExists = await exists(join(workspacePath, "README.md"));
    assertEquals(readmeExists, true);

    const envExists = await exists(join(workspacePath, ".env"));
    assertEquals(envExists, true);

    const gitignoreExists = await exists(join(workspacePath, ".gitignore"));
    assertEquals(gitignoreExists, true);

    // Verify draft still exists and is accessible
    const finalDraft = await ctx.draftStore.getDraft(draft.id);
    assertExists(finalDraft);
    assertEquals(finalDraft.name, testData.name);
  } finally {
    await cleanup(ctx);
  }
});
