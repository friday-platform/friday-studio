// Set testing mode to disable file logging
Deno.env.set("DENO_TESTING", "true");

import { assert, assertEquals, assertExists } from "@std/assert";
import { createKVStorage, StorageConfigs } from "../../../../src/core/storage/index.ts";
import { DraftLockManager } from "../../src/draft/locking.ts";
import { WorkspaceDraftStore } from "../../src/draft/storage.ts";

Deno.test("DraftLockManager - should acquire lock successfully", async () => {
  const storage = await createKVStorage(StorageConfigs.memory());
  const store = new WorkspaceDraftStore(storage);
  const lockManager = new DraftLockManager(storage);
  await store.initialize();

  // Create a draft first
  const draft = await store.createDraft({
    name: "test-workspace",
    description: "A test workspace",
    sessionId: "session-123",
    userId: "user-456",
  });

  const lockResult = await lockManager.acquireDraftLock(
    draft.id,
    "user-456",
    "test operation",
    30000,
  );

  assertEquals(lockResult.success, true);
  assertExists(lockResult.lock);
  assertEquals(lockResult.lock?.draftId, draft.id);
  assertEquals(lockResult.lock?.lockedBy, "user-456");
  assertEquals(lockResult.lock?.operation, "test operation");

  await store.close();
});

Deno.test("DraftLockManager - should fail to acquire lock when draft doesn't exist", async () => {
  const storage = await createKVStorage(StorageConfigs.memory());
  await storage.initialize();
  const lockManager = new DraftLockManager(storage);

  const lockResult = await lockManager.acquireDraftLock(
    "non-existent-draft",
    "user-456",
    "test operation",
    30000,
  );

  assertEquals(lockResult.success, false);
  assertEquals(lockResult.error?.includes("not found"), true);

  await storage.close();
});

Deno.test("DraftLockManager - should fail to acquire lock when already locked by different user", async () => {
  const storage = await createKVStorage(StorageConfigs.memory());
  const store = new WorkspaceDraftStore(storage);
  const lockManager = new DraftLockManager(storage);
  await store.initialize();

  // Create a draft first
  const draft = await store.createDraft({
    name: "test-workspace",
    description: "A test workspace",
    sessionId: "session-123",
    userId: "user-456",
  });

  // First user acquires lock
  const firstLock = await lockManager.acquireDraftLock(
    draft.id,
    "user-456",
    "first operation",
    30000,
  );
  assertEquals(firstLock.success, true);

  // Second user tries to acquire lock
  const secondLock = await lockManager.acquireDraftLock(
    draft.id,
    "user-789",
    "second operation",
    30000,
  );

  assertEquals(secondLock.success, false);
  assertEquals(secondLock.error?.includes("locked by user-456"), true);

  await store.close();
});

Deno.test("DraftLockManager - should extend lock for same user", async () => {
  const storage = await createKVStorage(StorageConfigs.memory());
  const store = new WorkspaceDraftStore(storage);
  const lockManager = new DraftLockManager(storage);
  await store.initialize();

  // Create a draft first
  const draft = await store.createDraft({
    name: "test-workspace",
    description: "A test workspace",
    sessionId: "session-123",
    userId: "user-456",
  });

  // First lock
  const firstLock = await lockManager.acquireDraftLock(
    draft.id,
    "user-456",
    "first operation",
    5000,
  );
  assertEquals(firstLock.success, true);
  const originalExpiry = firstLock.lock?.expiresAt;

  // Second lock by same user - should extend
  const secondLock = await lockManager.acquireDraftLock(
    draft.id,
    "user-456",
    "extended operation",
    10000,
  );

  assertEquals(secondLock.success, true);
  assertEquals(secondLock.lock?.operation, "extended operation");
  // Expiry should be later than original
  const newExpiry = secondLock.lock?.expiresAt;
  assert(new Date(newExpiry!) > new Date(originalExpiry!));

  await store.close();
});

Deno.test("DraftLockManager - should release lock successfully", async () => {
  const storage = await createKVStorage(StorageConfigs.memory());
  const store = new WorkspaceDraftStore(storage);
  const lockManager = new DraftLockManager(storage);
  await store.initialize();

  // Create a draft first
  const draft = await store.createDraft({
    name: "test-workspace",
    description: "A test workspace",
    sessionId: "session-123",
    userId: "user-456",
  });

  // Acquire lock
  const lockResult = await lockManager.acquireDraftLock(
    draft.id,
    "user-456",
    "test operation",
    30000,
  );
  assertEquals(lockResult.success, true);

  // Release lock
  const released = await lockManager.releaseDraftLock(draft.id, "user-456");
  assertEquals(released, true);

  // Should be able to acquire lock again
  const newLockResult = await lockManager.acquireDraftLock(
    draft.id,
    "user-789",
    "new operation",
    30000,
  );
  assertEquals(newLockResult.success, true);

  await store.close();
});

Deno.test("DraftLockManager - should fail to release lock for different user", async () => {
  const storage = await createKVStorage(StorageConfigs.memory());
  const store = new WorkspaceDraftStore(storage);
  const lockManager = new DraftLockManager(storage);
  await store.initialize();

  // Create a draft first
  const draft = await store.createDraft({
    name: "test-workspace",
    description: "A test workspace",
    sessionId: "session-123",
    userId: "user-456",
  });

  // Acquire lock
  const lockResult = await lockManager.acquireDraftLock(
    draft.id,
    "user-456",
    "test operation",
    30000,
  );
  assertEquals(lockResult.success, true);

  // Try to release with different user
  const released = await lockManager.releaseDraftLock(draft.id, "user-789");
  assertEquals(released, false);

  await store.close();
});

Deno.test("DraftLockManager - should handle expired locks", async () => {
  const storage = await createKVStorage(StorageConfigs.memory());
  const store = new WorkspaceDraftStore(storage);
  const lockManager = new DraftLockManager(storage);
  await store.initialize();

  // Create a draft first
  const draft = await store.createDraft({
    name: "test-workspace",
    description: "A test workspace",
    sessionId: "session-123",
    userId: "user-456",
  });

  // Acquire lock with very short timeout (1ms)
  const firstLock = await lockManager.acquireDraftLock(
    draft.id,
    "user-456",
    "first operation",
    1,
  );
  assertEquals(firstLock.success, true);

  // Wait for lock to expire
  await new Promise((resolve) => setTimeout(resolve, 10));

  // Different user should be able to acquire lock now
  const secondLock = await lockManager.acquireDraftLock(
    draft.id,
    "user-789",
    "second operation",
    30000,
  );
  assertEquals(secondLock.success, true);

  await store.close();
});
