/**
 * Tests for canonical workspace guards in WorkspaceManager.
 *
 * Verifies that canonical workspaces (personal, system) are properly
 * protected from deletion and rename per the canonical constraints.
 */

import { createKVStorage } from "@atlas/storage/kv";
import { beforeEach, describe, expect, it } from "vitest";
import { WorkspaceManager } from "../manager.ts";
import { RegistryStorageAdapter } from "../registry-storage-adapter.ts";
import type { WorkspaceEntry } from "../types.ts";

async function createTestManager(): Promise<{
  manager: WorkspaceManager;
  registry: RegistryStorageAdapter;
}> {
  const kv = await createKVStorage({ type: "memory" });
  const registry = new RegistryStorageAdapter(kv);
  await registry.initialize();
  const manager = new WorkspaceManager(registry);
  return { manager, registry };
}

function makeEntry(overrides: Partial<WorkspaceEntry>): WorkspaceEntry {
  return {
    id: "test-workspace",
    name: "Test Workspace",
    path: "system://test-workspace",
    configPath: "system://test-workspace/workspace.yml",
    status: "inactive",
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    ...overrides,
  };
}

describe("WorkspaceManager.deleteWorkspace", () => {
  let manager: WorkspaceManager;
  let registry: RegistryStorageAdapter;

  beforeEach(async () => {
    const result = await createTestManager();
    manager = result.manager;
    registry = result.registry;
  });

  it("blocks deletion of canonical workspace without force", async () => {
    const entry = makeEntry({
      id: "system",
      name: "System",
      metadata: { canonical: "system", system: true },
    });
    await registry.registerWorkspace(entry);

    await expect(manager.deleteWorkspace("system")).rejects.toThrow(
      "Cannot delete canonical workspace",
    );
  });

  it("allows deletion of canonical workspace with force", async () => {
    const entry = makeEntry({
      id: "system",
      name: "System",
      metadata: { canonical: "system", system: true },
    });
    await registry.registerWorkspace(entry);

    await manager.deleteWorkspace("system", { force: true });
    const found = await manager.find({ id: "system" });
    expect(found).toBeNull();
  });

  it("blocks deletion of personal canonical workspace without force", async () => {
    const entry = makeEntry({ id: "user", name: "Personal", metadata: { canonical: "personal" } });
    await registry.registerWorkspace(entry);

    await expect(manager.deleteWorkspace("user")).rejects.toThrow(
      "Cannot delete canonical workspace",
    );
  });

  it("allows deletion of non-canonical workspace", async () => {
    const entry = makeEntry({
      id: "user-workspace",
      name: "My Workspace",
      path: "/tmp/test-workspace",
      configPath: "/tmp/test-workspace/workspace.yml",
      metadata: {},
    });
    await registry.registerWorkspace(entry);

    await manager.deleteWorkspace("user-workspace");
    const found = await manager.find({ id: "user-workspace" });
    expect(found).toBeNull();
  });
});

describe("WorkspaceManager.renameWorkspace", () => {
  let manager: WorkspaceManager;
  let registry: RegistryStorageAdapter;

  beforeEach(async () => {
    const result = await createTestManager();
    manager = result.manager;
    registry = result.registry;
  });

  it("blocks rename of system canonical workspace", async () => {
    const entry = makeEntry({
      id: "system",
      name: "System",
      metadata: { canonical: "system", system: true },
    });
    await registry.registerWorkspace(entry);

    await expect(manager.renameWorkspace("system", "New Name")).rejects.toThrow(
      "Cannot rename system canonical workspace",
    );
  });

  it("allows rename of personal canonical workspace", async () => {
    const entry = makeEntry({ id: "user", name: "Personal", metadata: { canonical: "personal" } });
    await registry.registerWorkspace(entry);

    await manager.renameWorkspace("user", "My Space");
    const found = await manager.find({ id: "user" });
    expect(found?.name).toBe("My Space");
  });

  it("allows rename of non-canonical workspace", async () => {
    const entry = makeEntry({
      id: "user-workspace",
      name: "Old Name",
      path: "/tmp/test-workspace",
      configPath: "/tmp/test-workspace/workspace.yml",
      metadata: {},
    });
    await registry.registerWorkspace(entry);

    await manager.renameWorkspace("user-workspace", "New Name");
    const found = await manager.find({ id: "user-workspace" });
    expect(found?.name).toBe("New Name");
  });

  it("throws for non-existent workspace", async () => {
    await expect(manager.renameWorkspace("nonexistent", "Name")).rejects.toThrow(
      "Workspace not found",
    );
  });
});
