// Set testing mode to disable file logging
Deno.env.set("DENO_TESTING", "true");

import { assertEquals, assertExists } from "@std/assert";
import { createKVStorage, StorageConfigs } from "../../../../src/core/storage/index.ts";
import {
  createDraftStore,
  createDraftStoreFromStorage,
  createDraftStoreWithConfig,
} from "../../src/draft/factory.ts";

Deno.test("Factory - should create draft store with default config", async () => {
  const store = await createDraftStore();

  assertExists(store);
  assertExists(store.getStorage());

  // Test basic functionality
  const draft = await store.createDraft({
    name: "test-workspace",
    description: "A test workspace",
    sessionId: "session-123",
    userId: "user-456",
  });

  assertExists(draft.id);
  assertEquals(draft.name, "test-workspace");

  await store.close();
});

Deno.test("Factory - should create draft store with custom config", async () => {
  const config = StorageConfigs.memory();
  const store = await createDraftStoreWithConfig(config);

  assertExists(store);
  assertExists(store.getStorage());

  // Test basic functionality
  const draft = await store.createDraft({
    name: "test-workspace-custom",
    description: "A test workspace with custom config",
    sessionId: "session-456",
    userId: "user-789",
  });

  assertExists(draft.id);
  assertEquals(draft.name, "test-workspace-custom");

  await store.close();
});

Deno.test("Factory - should create draft store from existing storage", async () => {
  const storage = await createKVStorage(StorageConfigs.memory());
  await storage.initialize();

  const store = createDraftStoreFromStorage(storage);
  await store.initialize();

  assertExists(store);
  assertEquals(store.getStorage(), storage);

  // Test basic functionality
  const draft = await store.createDraft({
    name: "test-workspace-existing",
    description: "A test workspace with existing storage",
    sessionId: "session-789",
    userId: "user-123",
  });

  assertExists(draft.id);
  assertEquals(draft.name, "test-workspace-existing");

  await store.close();
});
