// Set testing mode to disable file logging
Deno.env.set("DENO_TESTING", "true");

import { assertEquals, assertExists, assertRejects } from "@std/assert";
import { createKVStorage, StorageConfigs } from "../../../../src/core/storage/index.ts";
import { WorkspaceDraftStore } from "../../src/draft/storage.ts";

Deno.test("WorkspaceDraftStore - should create draft successfully", async () => {
  const storage = await createKVStorage(StorageConfigs.memory());
  const store = new WorkspaceDraftStore(storage);
  await store.initialize();

  const draftParams = {
    name: "test-workspace",
    description: "A test workspace",
    sessionId: "session-123",
    userId: "user-456",
  };

  const draft = await store.createDraft(draftParams);

  assertExists(draft.id);
  assertEquals(draft.name, "test-workspace");
  assertEquals(draft.description, "A test workspace");
  assertEquals(draft.sessionId, "session-123");
  assertEquals(draft.userId, "user-456");
  assertEquals(draft.status, "draft");
  assertExists(draft.createdAt);
  assertExists(draft.updatedAt);

  await store.close();
});

Deno.test("WorkspaceDraftStore - should create draft with initial config", async () => {
  const storage = await createKVStorage(StorageConfigs.memory());
  const store = new WorkspaceDraftStore(storage);
  await store.initialize();

  const initialConfig = {
    agents: {
      "test-agent": {
        name: "Test Agent",
        provider: "test",
      },
    },
  };

  const draftParams = {
    name: "test-workspace",
    description: "A test workspace",
    sessionId: "session-123",
    userId: "user-456",
    initialConfig,
  };

  const draft = await store.createDraft(draftParams);

  assertEquals(draft.iterations.length, 1);
  assertEquals(draft.iterations[0].operation, "initial_config");
  assertEquals(draft.iterations[0].config, initialConfig);
  assertExists(draft.config.agents);

  await store.close();
});

Deno.test("WorkspaceDraftStore - should retrieve draft by ID", async () => {
  const storage = await createKVStorage(StorageConfigs.memory());
  const store = new WorkspaceDraftStore(storage);
  await store.initialize();

  const draftParams = {
    name: "test-workspace",
    description: "A test workspace",
    sessionId: "session-123",
    userId: "user-456",
  };

  const createdDraft = await store.createDraft(draftParams);
  const retrievedDraft = await store.getDraft(createdDraft.id);

  assertExists(retrievedDraft);
  assertEquals(retrievedDraft.id, createdDraft.id);
  assertEquals(retrievedDraft.name, createdDraft.name);

  await store.close();
});

Deno.test("WorkspaceDraftStore - should return null for non-existent draft", async () => {
  const storage = await createKVStorage(StorageConfigs.memory());
  const store = new WorkspaceDraftStore(storage);
  await store.initialize();

  const draft = await store.getDraft("non-existent-id");

  assertEquals(draft, null);

  await store.close();
});

Deno.test("WorkspaceDraftStore - should update draft configuration", async () => {
  const storage = await createKVStorage(StorageConfigs.memory());
  const store = new WorkspaceDraftStore(storage);
  await store.initialize();

  const draftParams = {
    name: "test-workspace",
    description: "A test workspace",
    sessionId: "session-123",
    userId: "user-456",
  };

  const draft = await store.createDraft(draftParams);

  const updates = {
    agents: {
      "new-agent": {
        name: "New Agent",
        provider: "test",
      },
    },
  };

  const updatedDraft = await store.updateDraft(draft.id, updates, "Added new agent");

  assertEquals(updatedDraft.iterations.length, 1);
  assertEquals(updatedDraft.iterations[0].operation, "update_config");
  assertEquals(updatedDraft.iterations[0].summary, "Added new agent");
  assertExists(updatedDraft.config.agents);

  await store.close();
});

Deno.test("WorkspaceDraftStore - should throw when updating non-existent draft", async () => {
  const storage = await createKVStorage(StorageConfigs.memory());
  const store = new WorkspaceDraftStore(storage);
  await store.initialize();

  await assertRejects(
    () => store.updateDraft("non-existent", {}, "test update"),
    Error,
    "Draft non-existent not found",
  );

  await store.close();
});

Deno.test("WorkspaceDraftStore - should get drafts by session", async () => {
  const storage = await createKVStorage(StorageConfigs.memory());
  const store = new WorkspaceDraftStore(storage);
  await store.initialize();

  const sessionId = "session-123";

  // Create multiple drafts for the same session
  await store.createDraft({
    name: "workspace-1",
    description: "First workspace",
    sessionId,
    userId: "user-456",
  });

  await store.createDraft({
    name: "workspace-2",
    description: "Second workspace",
    sessionId,
    userId: "user-456",
  });

  // Create draft for different session
  await store.createDraft({
    name: "workspace-3",
    description: "Third workspace",
    sessionId: "different-session",
    userId: "user-456",
  });

  const sessionDrafts = await store.getSessionDrafts(sessionId);

  assertEquals(sessionDrafts.length, 2);
  assertEquals(sessionDrafts.every((d) => d.sessionId === sessionId), true);

  await store.close();
});

Deno.test("WorkspaceDraftStore - should publish draft", async () => {
  const storage = await createKVStorage(StorageConfigs.memory());
  const store = new WorkspaceDraftStore(storage);
  await store.initialize();

  const draftParams = {
    name: "test-workspace",
    description: "A test workspace",
    sessionId: "session-123",
    userId: "user-456",
  };

  const draft = await store.createDraft(draftParams);

  await store.publishDraft(draft.id);

  const publishedDraft = await store.getDraft(draft.id);

  assertExists(publishedDraft);
  assertEquals(publishedDraft.status, "published");

  await store.close();
});

Deno.test("WorkspaceDraftStore - should delete draft", async () => {
  const storage = await createKVStorage(StorageConfigs.memory());
  const store = new WorkspaceDraftStore(storage);
  await store.initialize();

  const draftParams = {
    name: "test-workspace",
    description: "A test workspace",
    sessionId: "session-123",
    userId: "user-456",
  };

  const draft = await store.createDraft(draftParams);

  await store.deleteDraft(draft.id);

  const deletedDraft = await store.getDraft(draft.id);
  assertEquals(deletedDraft, null);

  await store.close();
});

Deno.test("WorkspaceDraftStore - should throw when deleting non-existent draft", async () => {
  const storage = await createKVStorage(StorageConfigs.memory());
  const store = new WorkspaceDraftStore(storage);
  await store.initialize();

  await assertRejects(
    () => store.deleteDraft("non-existent"),
    Error,
    "Draft non-existent not found",
  );

  await store.close();
});
