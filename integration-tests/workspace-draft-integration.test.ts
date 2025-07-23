/**
 * Workspace Draft System Integration Tests
 *
 * Simplified tests focusing on core draft functionality:
 * 1. Draft CRUD operations
 * 2. Conversation management
 *
 * This test follows TDD principles with proper isolation.
 */

import { assertEquals, assertExists, assertGreater } from "@std/assert";
import { WorkspaceDraftStore } from "../src/core/services/workspace-draft-store.ts";
import { createKVStorage, StorageConfigs } from "../src/core/storage/index.ts";

// Test context
interface TestContext {
  draftStore: WorkspaceDraftStore;
  kv: Deno.Kv;
}

async function createTestContext(): Promise<TestContext> {
  // Setup KV storage
  const kvStorageConfig = StorageConfigs.defaultKV();
  const kvStorage = await createKVStorage(kvStorageConfig);
  await kvStorage.initialize();
  const kv = (kvStorage as any).kv || await Deno.openKv();

  const draftStore = new WorkspaceDraftStore(kv);

  return { draftStore, kv };
}

async function cleanup(ctx: TestContext) {
  try {
    ctx.kv.close();
  } catch {
    // Ignore cleanup errors
  }
}

// Test data factory
function createTestDraftData(testId: string) {
  return {
    name: `test-workspace-${testId}`,
    description: `Test workspace for ${testId}`,
    sessionId: `session-${testId}`,
    conversationId: `conversation-${testId}`,
    userId: `user-${testId}`,
    initialConfig: {
      version: "1.0" as const,
      workspace: {
        name: `test-workspace-${testId}`,
        description: `Test workspace for ${testId}`,
      },
      agents: {
        "test-agent": {
          type: "llm",
          description: "Test agent",
          config: {
            provider: "anthropic",
            model: "claude-3-7-sonnet-latest",
            prompt: "You are a test assistant.",
          },
        },
      },
      jobs: {
        "test-job": {
          name: "test-job",
          description: "Test job",
          execution: {
            strategy: "sequential",
            agents: [
              { id: "test-agent" },
            ],
          },
        },
      },
      signals: {
        "http-test": {
          provider: "http",
          description: "Test HTTP signal",
          config: {
            path: "/webhook/test",
          },
        },
      },
    },
  };
}

/**
 * Test 1: Core Draft CRUD Operations
 */
Deno.test("Draft Integration - CRUD Operations", async () => {
  const ctx = await createTestContext();
  const testId = `crud-${Date.now()}`;
  const testData = createTestDraftData(testId);

  try {
    // Test creation
    const created = await ctx.draftStore.createDraft(testData);
    assertExists(created.id);
    assertEquals(created.name, testData.name);
    assertEquals(created.status, "draft");
    assertExists(created.createdAt);

    // Test retrieval
    const retrieved = await ctx.draftStore.getDraft(created.id);
    assertExists(retrieved);
    assertEquals(retrieved.id, created.id);
    assertEquals(retrieved.name, testData.name);

    // Test update
    const updated = await ctx.draftStore.updateDraft(
      created.id,
      { workspace: { name: "updated-name" } },
      "Test update",
    );
    assertExists(updated);
    assertGreater(new Date(updated.updatedAt).getTime(), new Date(created.updatedAt).getTime());

    // Test deletion
    await ctx.draftStore.deleteDraft(created.id);
    const deleted = await ctx.draftStore.getDraft(created.id);
    assertEquals(deleted, null);
  } finally {
    await cleanup(ctx);
  }
});

/**
 * Test 2: Conversation Management
 */
Deno.test("Draft Integration - Conversation Management", async () => {
  const ctx = await createTestContext();
  const conversationId = `conv-${Date.now()}`;

  try {
    // Create multiple drafts for same conversation
    const draft1Data = createTestDraftData(`conv1-${Date.now()}`);
    draft1Data.conversationId = conversationId;
    const draft1 = await ctx.draftStore.createDraft(draft1Data);

    const draft2Data = createTestDraftData(`conv2-${Date.now()}`);
    draft2Data.conversationId = conversationId;
    const draft2 = await ctx.draftStore.createDraft(draft2Data);

    // Test conversation indexing
    const conversationDrafts = await ctx.draftStore.getConversationDrafts(conversationId);
    assertGreater(conversationDrafts.length, 1);

    const latest = await ctx.draftStore.getLatestConversationDraft(conversationId);
    assertExists(latest);
    assertEquals(latest.conversationId, conversationId);

    const count = await ctx.draftStore.countConversationDrafts(conversationId);
    assertGreater(count, 1);

    // Test draft locking
    const lockResult = await ctx.draftStore.acquireDraftLock(draft1.id, "test-session", "testing");
    assertEquals(lockResult.success, true);

    // Test lock release
    const releaseResult = await ctx.draftStore.releaseDraftLock(draft1.id, "test-session");
    assertEquals(releaseResult, true);
  } finally {
    await cleanup(ctx);
  }
});
