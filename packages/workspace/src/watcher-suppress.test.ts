/**
 * Tests for the active-session guard in handleWatcherChange and the
 * processPendingWatcherChange drain valve that prevents config reloads
 * from killing in-flight agent sessions.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createKVStorage } from "@atlas/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceManager } from "./manager.ts";
import { RegistryStorageAdapter } from "./registry-storage-adapter.ts";

// ---------------------------------------------------------------------------
// Capture the watcher onConfigChange callback
// ---------------------------------------------------------------------------
type WatcherCallback = (
  workspaceId: string,
  change: { filePath: string } | { oldPath: string; newPath?: string },
) => Promise<void>;

const captured = vi.hoisted(() => ({ onConfigChange: null as WatcherCallback | null }));

vi.mock("./watchers/index.ts", () => ({
  WorkspaceConfigWatcher: class MockConfigWatcher {
    constructor(opts: { onConfigChange: WatcherCallback }) {
      captured.onConfigChange = opts.onConfigChange;
    }
    watchWorkspace() {
      return Promise.resolve();
    }
    unwatchWorkspace() {}
    shutdown() {
      return Promise.resolve();
    }
  },
}));

vi.mock("@atlas/system/workspaces", () => ({ SYSTEM_WORKSPACES: {} }));

// ---------------------------------------------------------------------------
// Mock runtime — duck-typed to satisfy the shape manager.ts reads
// ---------------------------------------------------------------------------
interface MockSession {
  session: { status: string; id: string };
  id: string;
  jobName: string;
  signalId: string;
  startedAt: Date;
}

function createMockRuntime(opts: { activeSessions?: boolean; activeExecutions?: boolean }): {
  sessions: MockSession[];
  getSessions: () => MockSession[];
  getOrchestrator: () => { hasActiveExecutions: () => boolean };
  shutdown: () => Promise<void>;
} {
  const sessions: MockSession[] = opts.activeSessions
    ? [
        {
          session: { status: "active", id: "sess-1" },
          id: "sess-1",
          jobName: "j1",
          signalId: "s1",
          startedAt: new Date(),
        },
      ]
    : [];

  return {
    sessions,
    getSessions: () => sessions,
    getOrchestrator: () => ({ hasActiveExecutions: () => opts.activeExecutions ?? false }),
    shutdown: () => Promise.resolve(),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function setupManager(): Promise<{ manager: WorkspaceManager; tempDir: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), "atlas-watcher-test-"));
  await writeFile(
    join(tempDir, "workspace.yml"),
    'version: "1.0"\nworkspace:\n  name: watcher-test\n',
  );

  const kv = await createKVStorage({ type: "memory" });
  const registry = new RegistryStorageAdapter(kv);
  await registry.initialize();
  const manager = new WorkspaceManager(registry);

  process.env.DENO_TEST = "true";
  await manager.initialize([]);

  return { manager, tempDir };
}

function getRuntimesMap(
  manager: WorkspaceManager,
): Map<string, ReturnType<typeof createMockRuntime>> {
  // Access private runtimes map for test setup — bracket notation bypasses
  // TypeScript private checks at compile time, and JS has no runtime enforcement.
  return (manager as unknown as Record<string, unknown>)["runtimes"] as Map<
    string,
    ReturnType<typeof createMockRuntime>
  >;
}

function getPendingMap(
  manager: WorkspaceManager,
): Map<string, { filePath: string } | { oldPath: string; newPath?: string }> {
  return (manager as unknown as Record<string, unknown>)["pendingWatcherChanges"] as Map<
    string,
    { filePath: string } | { oldPath: string; newPath?: string }
  >;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("watcher-suppress — handleWatcherChange active-session guard", () => {
  let tempDir: string;
  let manager: WorkspaceManager;
  let workspaceId: string;
  let configChangeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const setup = await setupManager();
    manager = setup.manager;
    tempDir = setup.tempDir;

    const result = await manager.registerWorkspace(tempDir);
    workspaceId = result.workspace.id;

    configChangeSpy = vi.spyOn(manager, "handleWorkspaceConfigChange").mockResolvedValue();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("defers reload when an active session exists", async () => {
    const runtime = createMockRuntime({ activeSessions: true });
    getRuntimesMap(manager).set(workspaceId, runtime);

    const change = { filePath: join(tempDir, "workspace.yml") };
    await captured.onConfigChange!(workspaceId, change);

    expect(configChangeSpy).not.toHaveBeenCalled();
    expect(getPendingMap(manager).has(workspaceId)).toBe(true);
  });

  it("applies reload immediately when no active session exists", async () => {
    const runtime = createMockRuntime({ activeSessions: false });
    getRuntimesMap(manager).set(workspaceId, runtime);

    const change = { filePath: join(tempDir, "workspace.yml") };
    await captured.onConfigChange!(workspaceId, change);

    expect(configChangeSpy).toHaveBeenCalledOnce();
    expect(getPendingMap(manager).has(workspaceId)).toBe(false);
  });

  it("defers reload when orchestrator has active executions", async () => {
    const runtime = createMockRuntime({ activeSessions: false, activeExecutions: true });
    getRuntimesMap(manager).set(workspaceId, runtime);

    const change = { filePath: join(tempDir, "workspace.yml") };
    await captured.onConfigChange!(workspaceId, change);

    expect(configChangeSpy).not.toHaveBeenCalled();
    expect(getPendingMap(manager).has(workspaceId)).toBe(true);
  });
});

describe("watcher-suppress — processPendingWatcherChange", () => {
  let tempDir: string;
  let manager: WorkspaceManager;
  let workspaceId: string;
  let configChangeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    const setup = await setupManager();
    manager = setup.manager;
    tempDir = setup.tempDir;

    const result = await manager.registerWorkspace(tempDir);
    workspaceId = result.workspace.id;

    configChangeSpy = vi.spyOn(manager, "handleWorkspaceConfigChange").mockResolvedValue();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("drains pending entry and calls reload path exactly once", async () => {
    const runtime = createMockRuntime({ activeSessions: true });
    getRuntimesMap(manager).set(workspaceId, runtime);

    const change = { filePath: join(tempDir, "workspace.yml") };
    await captured.onConfigChange!(workspaceId, change);
    expect(configChangeSpy).not.toHaveBeenCalled();

    // Clear active sessions so drain proceeds
    runtime.sessions.length = 0;

    await manager.processPendingWatcherChange(workspaceId);

    expect(configChangeSpy).toHaveBeenCalledOnce();
    expect(getPendingMap(manager).has(workspaceId)).toBe(false);
  });

  it("is a no-op when no pending entry exists", async () => {
    await manager.processPendingWatcherChange(workspaceId);

    expect(configChangeSpy).not.toHaveBeenCalled();
  });

  it("last-write wins: second config update while session active overwrites first", async () => {
    const runtime = createMockRuntime({ activeSessions: true });
    getRuntimesMap(manager).set(workspaceId, runtime);

    const firstChange = { filePath: join(tempDir, "workspace.yml") };
    await captured.onConfigChange!(workspaceId, firstChange);

    const secondChange = { filePath: join(tempDir, "workspace.yml") };
    await captured.onConfigChange!(workspaceId, secondChange);

    expect(getPendingMap(manager).get(workspaceId)).toBe(secondChange);

    runtime.sessions.length = 0;
    await manager.processPendingWatcherChange(workspaceId);

    expect(configChangeSpy).toHaveBeenCalledOnce();
  });

  it("does not drain if sessions are still active", async () => {
    const runtime = createMockRuntime({ activeSessions: true });
    getRuntimesMap(manager).set(workspaceId, runtime);

    await captured.onConfigChange!(workspaceId, { filePath: join(tempDir, "workspace.yml") });

    // Sessions still active — drain should be blocked
    await manager.processPendingWatcherChange(workspaceId);

    expect(configChangeSpy).not.toHaveBeenCalled();
    expect(getPendingMap(manager).has(workspaceId)).toBe(true);
  });
});
