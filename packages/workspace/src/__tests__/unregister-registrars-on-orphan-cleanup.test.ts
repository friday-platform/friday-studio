import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createKVStorage, type KVStorage } from "@atlas/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceManager } from "../manager.ts";
import { RegistryStorageAdapter } from "../registry-storage-adapter.ts";
import type { WorkspaceEntry, WorkspaceSignalRegistrar } from "../types.ts";

/**
 * MemoryKVStorage.initialize() wipes `data`, so when `manager.initialize()`
 * re-inits the registry (which re-inits the underlying KV), the orphan
 * seed disappears before `registerSystemWorkspaces` can see it. Proxy the
 * KV so subsequent `initialize` calls are no-ops — preserves the seed
 * across the double-init. Test-only; production KVs treat re-init as
 * idempotent at the data layer anyway.
 */
async function makeIdempotentMemoryKV(): Promise<KVStorage> {
  const kv = await createKVStorage({ type: "memory" });
  let inited = false;
  return new Proxy(kv, {
    get(target, prop, receiver) {
      if (prop === "initialize") {
        return async () => {
          if (inited) return;
          inited = true;
          await target.initialize();
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

const hoisted = vi.hoisted(() => ({ atlasHome: "/tmp/atlas-orphan-cleanup" }));

vi.mock("@atlas/utils/paths.server", () => ({ getAtlasHome: () => hoisted.atlasHome }));

// Empty SYSTEM_WORKSPACES so any entry already in the registry with
// `metadata.system=true` will count as an orphan on initialize().
vi.mock("@atlas/system/workspaces", () => ({ SYSTEM_WORKSPACES: {} }));

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

/**
 * Regression test for the bug that left orphaned cron timers firing against
 * non-existent workspaces:
 *
 * `WorkspaceManager.initialize()` prunes registry entries marked
 * `system=true` that no longer appear in `SYSTEM_WORKSPACES`. The original
 * code called `registry.unregisterWorkspace()` directly and bypassed the
 * signal-registrar chain — so any `CronSignalRegistrar` / `FsWatchRegistrar`
 * bindings survived the purge and kept firing every tick.
 *
 * The fix pairs the registry call with `unregisterWithRegistrars` so every
 * registrar (cron included) sees the cleanup. This test pins that pairing.
 */
describe("WorkspaceManager orphan-system cleanup fires registrar chain", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "atlas-orphan-cleanup-"));
    hoisted.atlasHome = tempDir;
    process.env.DENO_TEST = "true";
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("unregisters orphaned system workspaces from every signal registrar", async () => {
    const kv = await makeIdempotentMemoryKV();
    const registry = new RegistryStorageAdapter(kv);
    await registry.initialize();

    // Seed an orphan: a `system=true` entry in the registry whose id is
    // not in the (mocked-empty) SYSTEM_WORKSPACES map. `initialize()`
    // should treat it as stale and purge it.
    const orphanEntry: WorkspaceEntry = {
      id: "poached_quiche",
      name: "Poached Quiche",
      path: "system://poached_quiche",
      configPath: "system://poached_quiche/workspace.yml",
      status: "inactive",
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      metadata: { system: true },
    };
    await registry.registerWorkspace(orphanEntry);

    // Spy registrar that records every unregister call so we can assert
    // the orphan's id flows through the registrar chain.
    const unregisterCalls: string[] = [];
    const spyRegistrar: WorkspaceSignalRegistrar = {
      registerWorkspace: () => Promise.resolve(),
      unregisterWorkspace: (id) => {
        unregisterCalls.push(id);
        return Promise.resolve();
      },
    };

    const manager = new WorkspaceManager(registry);
    await manager.initialize([spyRegistrar]);

    // The orphan must have been routed through the registrar — this is
    // the exact path that clears cron timers for deleted workspaces.
    expect(unregisterCalls).toContain("poached_quiche");

    // And it must also be gone from the registry itself so we don't
    // resurrect it on the next boot.
    const stillThere = await registry.getWorkspace("poached_quiche");
    expect(stillThere).toBeNull();
  });
});
