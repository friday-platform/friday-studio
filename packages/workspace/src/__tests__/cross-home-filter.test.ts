/**
 * Tests for the cross-home registry filter.
 *
 * Background: `WORKSPACE_REGISTRY` is shared across home dirs whenever two
 * daemons (e.g. dev and prod) end up backed by the same JetStream store.
 * Once a cross-home entry lands in the registry, every subsequent daemon
 * boot would walk those entries — watching directories under the wrong
 * home, re-mounting workspaces that don't belong to this install, etc.
 *
 * The fix renders cross-home entries inert at runtime: `list()` filters
 * them out, `find()` masks them, watchers never attach. The entries stay
 * in KV — Phase 6 handles deletion. This file pins that contract.
 */

import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createKVStorage, type KVStorage } from "@atlas/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceManager } from "../manager.ts";
import { RegistryStorageAdapter } from "../registry-storage-adapter.ts";
import type { WorkspaceEntry } from "../types.ts";

/**
 * `MemoryKVStorage.initialize()` clears `data`. The manager calls
 * `registry.initialize()` (and the KV under it) on every boot, which
 * wipes any seed we set up before `manager.initialize`. Proxy the KV so
 * subsequent inits are no-ops. Test-only; production KVs treat re-init
 * as idempotent at the data layer.
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

const hoisted = vi.hoisted(() => ({ atlasHome: "/tmp/atlas-cross-home" }));

vi.mock("@atlas/utils/paths.server", () => ({ getFridayHome: () => hoisted.atlasHome }));

vi.mock("@atlas/system/workspaces", () => ({ SYSTEM_WORKSPACES: {} }));

// Track every workspace passed to watchWorkspace() so we can assert nothing
// from a foreign home ever gets a file watcher.
const watcherSpy = vi.hoisted(() => ({ watched: [] as string[] }));

vi.mock("../watchers/index.ts", () => ({
  WorkspaceConfigWatcher: class {
    watchWorkspace(entry: WorkspaceEntry) {
      watcherSpy.watched.push(entry.id);
      return Promise.resolve();
    }
    unwatchWorkspace() {}
    stop() {}
    shutdown() {
      return Promise.resolve();
    }
  },
}));

// Spy on logger.warn so we can pin the "one warn per skipped entry per
// filter call" contract.
const mockLogger = vi.hoisted(() => {
  const log = { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn(), child: vi.fn() };
  log.child.mockReturnValue(log);
  return log;
});

vi.mock("@atlas/logger", () => ({ logger: mockLogger, createLogger: vi.fn(() => mockLogger) }));

function entry(overrides: Partial<WorkspaceEntry> & { id: string; path: string }): WorkspaceEntry {
  return {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    path: overrides.path,
    configPath: overrides.configPath ?? join(overrides.path, "workspace.yml"),
    status: overrides.status ?? "inactive",
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    lastSeen: overrides.lastSeen ?? new Date().toISOString(),
    metadata: overrides.metadata,
  };
}

async function makeManager(
  home: string,
): Promise<{ manager: WorkspaceManager; registry: RegistryStorageAdapter }> {
  hoisted.atlasHome = home;
  const kv = await makeIdempotentMemoryKV();
  const registry = new RegistryStorageAdapter(kv);
  await registry.initialize();
  return { manager: new WorkspaceManager(registry), registry };
}

/**
 * Warn-log calls that came from the cross-home filter, with a stable
 * fingerprint of the entry they fired on. Other warn calls (e.g. from
 * `WorkspaceConfigSchema` parse failures elsewhere) are ignored.
 */
function crossHomeWarns(): Array<{ workspaceId: string; context: string }> {
  return mockLogger.warn.mock.calls
    .filter(
      ([msg]) =>
        msg === "Skipping workspace registry entry from different home dir" ||
        msg === "Masking cross-home workspace lookup" ||
        msg === "Masking cross-home workspace config lookup",
    )
    .map(([, payload]) => ({
      workspaceId: (payload as { workspaceId: string }).workspaceId,
      context: (payload as { context: string }).context,
    }));
}

describe("WorkspaceManager cross-home filter — list()", () => {
  let home: string;

  beforeEach(async () => {
    // realpath: on macOS mkdtemp returns `/var/folders/...` but
    // Deno.realPath() resolves to `/private/var/folders/...`. The filter
    // compares the stored entry path (already realpath'd by
    // registerWorkspace) against home, so canonicalise both sides.
    home = await realpath(await mkdtemp(join(tmpdir(), "atlas-home-")));
    process.env.DENO_TEST = "true";
    mockLogger.warn.mockClear();
    watcherSpy.watched.length = 0;
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("returns only the in-home entry from a three-entry seed", async () => {
    const { manager, registry } = await makeManager(home);

    const inHome = entry({ id: "in-home", path: join(home, "workspaces", "in-home") });
    const foreignHome = entry({ id: "foreign-home", path: "/some/other/dir/workspaces/X" });
    const tmpEntry = entry({ id: "tmp-entry", path: "/tmp/lives-here" });

    await registry.registerWorkspace(inHome);
    await registry.registerWorkspace(foreignHome);
    await registry.registerWorkspace(tmpEntry);

    const listed = await manager.list();

    expect(listed.map((w) => w.id).sort()).toEqual(["in-home"]);
  });

  it("emits exactly one warn log per skipped entry per list() call", async () => {
    const { manager, registry } = await makeManager(home);

    await registry.registerWorkspace(entry({ id: "in", path: join(home, "ws", "in") }));
    await registry.registerWorkspace(
      entry({ id: "foreign-1", path: "/some/other/home/workspaces/A" }),
    );
    await registry.registerWorkspace(entry({ id: "foreign-2", path: "/tmp/elsewhere" }));

    await manager.list();

    const warns = crossHomeWarns().filter((w) => w.context === "list");
    expect(warns.map((w) => w.workspaceId).sort()).toEqual(["foreign-1", "foreign-2"]);
    expect(warns).toHaveLength(2);
  });

  it("re-emits warns on subsequent list() calls (per-call, not session-scoped)", async () => {
    // The contract per the plan is "one warn per skipped entry per filter
    // call" — multiple calls within a boot session each emit. This keeps
    // the implementation simple (no manager-level seen set) and lets
    // operators see the filter firing across boot, close(), and any
    // intermediate list() calls.
    const { manager, registry } = await makeManager(home);
    await registry.registerWorkspace(entry({ id: "foreign", path: "/elsewhere/X" }));

    await manager.list();
    await manager.list();

    const warns = crossHomeWarns().filter((w) => w.context === "list");
    expect(warns).toHaveLength(2);
  });
});

describe("WorkspaceManager cross-home filter — boot path watchers", () => {
  let home: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "atlas-home-watch-")));
    process.env.DENO_TEST = "true";
    mockLogger.warn.mockClear();
    watcherSpy.watched.length = 0;
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("does not attach watchers to cross-home entries during initialize()", async () => {
    const { manager, registry } = await makeManager(home);

    // Seed a foreign-home entry directly (no fs presence — the filter is
    // path-prefix only, no disk lookup). The boot path must skip this
    // entry entirely: no list result, no config load, no watcher.
    await registry.registerWorkspace(
      entry({ id: "foreign", path: "/foreign/home/workspaces/Bad" }),
    );

    // Seed an in-home workspace with a valid workspace.yml so the boot
    // loop actually reaches `fileWatcher.watchWorkspace()` for it,
    // proving the watcher path runs for legitimate entries.
    const inHomePath = join(home, "workspaces", "in-home");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(inHomePath, { recursive: true });
    await writeFile(
      join(inHomePath, "workspace.yml"),
      'version: "1.0"\nworkspace:\n  name: in-home\n',
    );
    await manager.registerWorkspace(inHomePath, { id: "in-home" });

    // Clear any watch calls registerWorkspace already made — we only
    // care about what initialize() does next.
    watcherSpy.watched.length = 0;

    await manager.initialize([]);

    expect(watcherSpy.watched).toContain("in-home");
    expect(watcherSpy.watched).not.toContain("foreign");
  });
});

describe("WorkspaceManager cross-home filter — find() back-doors", () => {
  let home: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "atlas-home-find-")));
    process.env.DENO_TEST = "true";
    mockLogger.warn.mockClear();
    watcherSpy.watched.length = 0;
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("find({ id }) returns null for cross-home entry and emits a warn", async () => {
    const { manager, registry } = await makeManager(home);
    await registry.registerWorkspace(entry({ id: "foreign", path: "/elsewhere/X" }));

    const result = await manager.find({ id: "foreign" });

    expect(result).toBeNull();
    const warns = crossHomeWarns().filter((w) => w.workspaceId === "foreign");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.context).toBe("find");
  });

  it("find({ name }) returns null for cross-home entry", async () => {
    const { manager, registry } = await makeManager(home);
    await registry.registerWorkspace(
      entry({ id: "foreign", name: "Cross Home WS", path: "/elsewhere/Y" }),
    );

    const result = await manager.find({ name: "Cross Home WS" });

    expect(result).toBeNull();
  });

  it("find({ path }) returns null when the path is cross-home", async () => {
    const { manager, registry } = await makeManager(home);
    await registry.registerWorkspace(entry({ id: "foreign", path: "/elsewhere/Z" }));

    const result = await manager.find({ path: "/elsewhere/Z" });

    expect(result).toBeNull();
  });

  it("getWorkspaceConfig() returns null for cross-home entry", async () => {
    const { manager, registry } = await makeManager(home);
    await registry.registerWorkspace(entry({ id: "foreign", path: "/elsewhere/Q" }));

    const result = await manager.getWorkspaceConfig("foreign");

    expect(result).toBeNull();
    const warns = crossHomeWarns().filter(
      (w) => w.workspaceId === "foreign" && w.context === "getWorkspaceConfig",
    );
    expect(warns).toHaveLength(1);
  });
});

describe("WorkspaceManager cross-home filter — generateUniqueId still sees everything", () => {
  let home: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "atlas-home-uniq-")));
    process.env.DENO_TEST = "true";
    mockLogger.warn.mockClear();
    watcherSpy.watched.length = 0;
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("queries the raw registry (not the filtered list), so cross-home IDs appear in the taken set", async () => {
    // The behavioral assertion: generateUniqueId calls
    // registry.listWorkspaces() directly, not the filtered manager.list().
    // We spy on listWorkspaces and verify it returned the cross-home
    // entries, proving they're in the namespace the unique-id walk sees.
    const { manager, registry } = await makeManager(home);
    const seeded: WorkspaceEntry[] = [
      entry({ id: "in-home-X", path: join(home, "ws", "X") }),
      entry({ id: "cross-home-COLLIDE", path: "/foreign/ws/Y" }),
    ];
    for (const e of seeded) await registry.registerWorkspace(e);

    const listSpy = vi.spyOn(registry, "listWorkspaces");
    const generate = (
      manager as unknown as { generateUniqueId: () => Promise<string> }
    ).generateUniqueId.bind(manager);
    await generate();

    expect(listSpy).toHaveBeenCalled();
    const returned = (await listSpy.mock.results[0]?.value) as WorkspaceEntry[];
    expect(returned.map((w) => w.id).sort()).toEqual(["cross-home-COLLIDE", "in-home-X"]);
  });
});

describe("WorkspaceManager cross-home filter — system workspaces bypass the filter", () => {
  let home: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "atlas-home-system-")));
    process.env.DENO_TEST = "true";
    mockLogger.warn.mockClear();
    watcherSpy.watched.length = 0;
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("preserves system:// entries regardless of home prefix", async () => {
    // `system://` paths are home-agnostic by construction — they're the
    // bundled system workspaces, not user data on disk. The filter must
    // not drop them even though `system://...` doesn't start with the
    // active home.
    const { manager, registry } = await makeManager(home);
    await registry.registerWorkspace(
      entry({ id: "fast-loop", path: "system://fast-loop", metadata: { system: true } }),
    );

    const listed = await manager.list({ includeSystem: true });

    expect(listed.map((w) => w.id)).toContain("fast-loop");
    expect(crossHomeWarns()).toHaveLength(0);
  });

  it("preserves metadata.system entries regardless of path prefix", async () => {
    // Belt-and-suspenders: any entry tagged `metadata.system: true` is
    // treated as home-agnostic even if its `path` is a real on-disk
    // path under a foreign home. Same justification: system workspaces
    // are bundled with the daemon binary, not per-home state.
    const { manager, registry } = await makeManager(home);
    await registry.registerWorkspace(
      entry({
        id: "sys-with-real-path",
        path: "/some/other/install/system/fast-loop",
        metadata: { system: true },
      }),
    );

    const listed = await manager.list({ includeSystem: true });

    expect(listed.map((w) => w.id)).toContain("sys-with-real-path");
  });
});

describe("WorkspaceManager cross-home filter — initialize() sweeps are home-scoped", () => {
  let home: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "atlas-home-sweep-")));
    process.env.DENO_TEST = "true";
    mockLogger.warn.mockClear();
    watcherSpy.watched.length = 0;
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("registerSystemWorkspaces orphan sweep does not unregister cross-home system rows", async () => {
    // Phase 5 gate: a cross-home `system=true` row written by another
    // daemon (or another install of the same version) isn't ours to
    // garbage-collect. If the orphan sweep ran on it, two installs
    // sharing a registry would wipe each other's system entries.
    const { manager, registry } = await makeManager(home);
    await registry.registerWorkspace(
      entry({
        id: "foreign-system",
        path: "/foreign/install/system/foo",
        metadata: { system: true },
      }),
    );

    await manager.initialize([]);

    // Survived the orphan sweep.
    const survived = await registry.getWorkspace("foreign-system");
    expect(survived).not.toBeNull();
  });

  it("migrateFastLoopToSystem does not touch cross-home fast-loop entries", async () => {
    // Cross-home fast-loop migration would mutate a row owned by
    // another install. The filter at the migration call site is what
    // prevents that — without it, a stale "fast-loop" entry pointing at
    // a foreign install would be rewritten on every boot.
    const { manager, registry } = await makeManager(home);
    await registry.registerWorkspace(
      entry({
        id: "foreign-fast-loop",
        name: "fast-loop",
        path: "/foreign/install/workspaces/fast-loop",
      }),
    );

    await manager.initialize([]);

    const survived = await registry.getWorkspace("foreign-fast-loop");
    expect(survived).not.toBeNull();
    // The cross-home entry's name is unchanged (no rewrite happened).
    expect(survived?.name).toBe("fast-loop");
  });
});

describe("WorkspaceManager cross-home filter — mutation paths refuse to touch", () => {
  let home: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "atlas-home-mutate-")));
    process.env.DENO_TEST = "true";
    mockLogger.warn.mockClear();
    watcherSpy.watched.length = 0;
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("deleteWorkspace leaves cross-home entries intact and does not touch their path", async () => {
    // The critical case from the prior review: removeDirectory=true on
    // a cross-home id could `rm -rf` a directory under another Friday
    // install. The guard at the top of deleteWorkspace must refuse
    // BEFORE any registry unregister or filesystem rm runs.
    const { manager, registry } = await makeManager(home);
    await registry.registerWorkspace(
      entry({ id: "foreign", path: "/some/foreign/install/workspaces/X" }),
    );

    await manager.deleteWorkspace("foreign", { removeDirectory: true });

    // Entry still in registry — guard fired before the unregister call.
    const survived = await registry.getWorkspace("foreign");
    expect(survived).not.toBeNull();
    // Warn was emitted with the right context.
    const warns = mockLogger.warn.mock.calls.filter(
      ([msg]) => msg === "Refusing to delete cross-home workspace",
    );
    expect(warns).toHaveLength(1);
  });

  it("renameWorkspace throws not-found for cross-home entries and does not rewrite the registry", async () => {
    const { manager, registry } = await makeManager(home);
    await registry.registerWorkspace(
      entry({ id: "foreign", name: "Original Name", path: "/foreign/X" }),
    );

    await expect(manager.renameWorkspace("foreign", "New Name")).rejects.toThrow(
      /Workspace not found/,
    );

    const survived = await registry.getWorkspace("foreign");
    expect(survived?.name).toBe("Original Name");
    const warns = mockLogger.warn.mock.calls.filter(
      ([msg]) => msg === "Refusing to rename cross-home workspace",
    );
    expect(warns).toHaveLength(1);
  });

  it("updateWorkspacePersistence throws not-found for cross-home entries", async () => {
    const { manager, registry } = await makeManager(home);
    await registry.registerWorkspace(
      entry({ id: "foreign", path: "/foreign/Y", configPath: "/foreign/Y/eph_workspace.yml" }),
    );

    await expect(manager.updateWorkspacePersistence("foreign", true)).rejects.toThrow(
      /Workspace not found/,
    );

    // configPath unchanged — no rename happened.
    const survived = await registry.getWorkspace("foreign");
    expect(survived?.configPath).toBe("/foreign/Y/eph_workspace.yml");
    const warns = mockLogger.warn.mock.calls.filter(
      ([msg]) => msg === "Refusing to toggle persistence for cross-home workspace",
    );
    expect(warns).toHaveLength(1);
  });

  it("restartSignalsForWorkspace is a no-op for cross-home entries", async () => {
    // Private method — reach in via cast. The signal-restart path runs
    // when a workspace's config changes; for a cross-home entry, the
    // guard must skip the unregister/register cycle (otherwise we'd
    // mount signals for a workspace we don't own).
    const { manager, registry } = await makeManager(home);
    await registry.registerWorkspace(entry({ id: "foreign", path: "/foreign/Z" }));

    const restart = (
      manager as unknown as {
        restartSignalsForWorkspace: (id: string, path: string, config: unknown) => Promise<void>;
      }
    ).restartSignalsForWorkspace.bind(manager);

    // Minimal config shape — the guard fires before config is used.
    await restart("foreign", "/foreign/Z", {} as unknown);

    // Registry entry must be unchanged — guard fired before the
    // unregister/register cycle could touch it. Mirrors the
    // "no side effects" assertion from the other three mutation tests.
    const survived = await registry.getWorkspace("foreign");
    expect(survived).not.toBeNull();
    expect(survived?.path).toBe("/foreign/Z");

    const warns = mockLogger.warn.mock.calls.filter(
      ([msg]) => msg === "Refusing to restart signals for cross-home workspace",
    );
    expect(warns).toHaveLength(1);
  });
});
