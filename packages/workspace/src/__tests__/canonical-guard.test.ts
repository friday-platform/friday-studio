/**
 * Tests for canonical workspace guards: system workspace registration,
 * canonical metadata schema, and canonical flag propagation.
 *
 * Manager-level delete/rename guards are covered in manager-canonical.test.ts.
 * This file covers registration, schema, and the SYSTEM_WORKSPACES bootstrap.
 */

import process from "node:process";
import { createKVStorage } from "@atlas/storage/kv";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_WORKSPACE_IDS, getCanonicalKind } from "../canonical.ts";
import { WorkspaceManager } from "../manager.ts";
import { RegistryStorageAdapter } from "../registry-storage-adapter.ts";
import { WorkspaceMetadataSchema } from "../types.ts";

vi.mock("@atlas/system/workspaces", () => {
  const config = {
    workspace: { name: "System", description: "The canonical system workspace" },
    signals: {},
    jobs: {},
  };
  return { SYSTEM_WORKSPACES: { system: config } as Record<string, typeof config> };
});

vi.mock("../watchers/index.ts", () => ({
  WorkspaceConfigWatcher: class {
    watchWorkspace() {
      return Promise.resolve();
    }
    unwatchWorkspace() {}
    stop() {}
    shutdown() {
      return Promise.resolve();
    }
  },
}));

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

describe("WorkspaceMetadataSchema canonical field", () => {
  it("accepts 'personal' as canonical value", () => {
    const result = WorkspaceMetadataSchema.safeParse({ canonical: "personal" });
    expect(result.success).toBe(true);
  });

  it("accepts 'system' as canonical value", () => {
    const result = WorkspaceMetadataSchema.safeParse({ canonical: "system" });
    expect(result.success).toBe(true);
  });

  it("accepts undefined (non-canonical workspace)", () => {
    const result = WorkspaceMetadataSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.canonical).toBeUndefined();
    }
  });

  it("rejects invalid canonical value", () => {
    const result = WorkspaceMetadataSchema.safeParse({ canonical: "invalid" });
    expect(result.success).toBe(false);
  });
});

describe("system workspace bootstrap via registerSystemWorkspaces", () => {
  let manager: WorkspaceManager;

  beforeEach(async () => {
    process.env.DENO_TEST = "true";
    const result = await createTestManager();
    manager = result.manager;
    await manager.initialize([]);
  });

  it("registers 'system' entry on initialize()", async () => {
    const found = await manager.find({ id: "system" });
    expect(found).not.toBeNull();
    expect(found?.name).toBe("System");
    expect(found?.metadata?.system).toBe(true);
  });

  it("sets canonical='system' on the system workspace entry", async () => {
    const found = await manager.find({ id: "system" });
    expect(found?.metadata?.canonical).toBe("system");
  });
});

describe("getCanonicalKind integration", () => {
  it("maps CANONICAL_WORKSPACE_IDS.SYSTEM to 'system'", () => {
    expect(getCanonicalKind(CANONICAL_WORKSPACE_IDS.SYSTEM)).toBe("system");
  });

  it("maps CANONICAL_WORKSPACE_IDS.PERSONAL to 'personal'", () => {
    expect(getCanonicalKind(CANONICAL_WORKSPACE_IDS.PERSONAL)).toBe("personal");
  });

  it("returns undefined for non-canonical workspace IDs", () => {
    expect(getCanonicalKind("braised_biscuit")).toBeUndefined();
  });
});
