/**
 * Setup gate (T13): when the injected `RequiresSetupProbe` reports a
 * workspace still needs setup, the manager must skip schedule + fs-watch
 * registration for that workspace. Once setup completes,
 * `restartSignalsForWorkspace` (called by the answer handler) registers
 * normally.
 *
 * The gate sits inside `registerWithRegistrars`, which both the initial
 * `registerWorkspace` call and `restartSignalsForWorkspace` route
 * through. Tests drive the public surfaces and inspect the spy registrar
 * to assert the gate's behavior.
 */

import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createKVStorage, type KVStorage } from "@atlas/storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceManager } from "../manager.ts";
import { RegistryStorageAdapter } from "../registry-storage-adapter.ts";
import type { WorkspaceSignalRegistrar } from "../types.ts";

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

const hoisted = vi.hoisted(() => ({ atlasHome: "/tmp/atlas-setup-gate" }));

vi.mock("@atlas/utils/paths.server", () => ({ getFridayHome: () => hoisted.atlasHome }));
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

interface SpyRegistrar extends WorkspaceSignalRegistrar {
  registered: string[];
  unregistered: string[];
}

function makeSpyRegistrar(): SpyRegistrar {
  const registered: string[] = [];
  const unregistered: string[] = [];
  return {
    registered,
    unregistered,
    registerWorkspace: (id) => {
      registered.push(id);
      return Promise.resolve();
    },
    unregisterWorkspace: (id) => {
      unregistered.push(id);
      return Promise.resolve();
    },
  };
}

async function makeWorkspace(home: string, name: string, body: string): Promise<string> {
  const wsPath = join(home, "workspaces", name);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(wsPath, { recursive: true });
  await writeFile(join(wsPath, "workspace.yml"), body);
  return await realpath(wsPath);
}

describe("WorkspaceManager setup gate — registerWithRegistrars", () => {
  let home: string;

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), "atlas-setup-gate-")));
    hoisted.atlasHome = home;
    process.env.DENO_TEST = "true";
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("skips registrar registration when probe reports requires_setup=true", async () => {
    const kv = await makeIdempotentMemoryKV();
    const registry = new RegistryStorageAdapter(kv);
    await registry.initialize();

    const wsPath = await makeWorkspace(
      home,
      "needs-setup",
      'version: "1.0"\nworkspace:\n  name: needs-setup\n',
    );

    const manager = new WorkspaceManager(registry);
    manager.setRequiresSetupProbe({ check: () => Promise.resolve(true) });

    const registrar = makeSpyRegistrar();
    await manager.initialize([registrar]);

    await manager.registerWorkspace(wsPath, { id: "needs-setup", skipEnvValidation: true });

    expect(registrar.registered).not.toContain("needs-setup");
  });

  it("registers normally when probe reports requires_setup=false", async () => {
    const kv = await makeIdempotentMemoryKV();
    const registry = new RegistryStorageAdapter(kv);
    await registry.initialize();

    const wsPath = await makeWorkspace(
      home,
      "ready",
      'version: "1.0"\nworkspace:\n  name: ready\n',
    );

    const manager = new WorkspaceManager(registry);
    manager.setRequiresSetupProbe({ check: () => Promise.resolve(false) });

    const registrar = makeSpyRegistrar();
    await manager.initialize([registrar]);

    await manager.registerWorkspace(wsPath, { id: "ready", skipEnvValidation: true });

    expect(registrar.registered).toContain("ready");
  });

  it("registers normally when no probe is wired (preserves pre-gate behavior)", async () => {
    const kv = await makeIdempotentMemoryKV();
    const registry = new RegistryStorageAdapter(kv);
    await registry.initialize();

    const wsPath = await makeWorkspace(
      home,
      "no-probe",
      'version: "1.0"\nworkspace:\n  name: no-probe\n',
    );

    const manager = new WorkspaceManager(registry);
    // No setRequiresSetupProbe — manager must treat as not setup-required.

    const registrar = makeSpyRegistrar();
    await manager.initialize([registrar]);

    await manager.registerWorkspace(wsPath, { id: "no-probe", skipEnvValidation: true });

    expect(registrar.registered).toContain("no-probe");
  });

  it("registers normally when probe throws (fail-open per Decision 3)", async () => {
    const kv = await makeIdempotentMemoryKV();
    const registry = new RegistryStorageAdapter(kv);
    await registry.initialize();

    const wsPath = await makeWorkspace(
      home,
      "probe-broken",
      'version: "1.0"\nworkspace:\n  name: probe-broken\n',
    );

    const manager = new WorkspaceManager(registry);
    manager.setRequiresSetupProbe({ check: () => Promise.reject(new Error("link is down")) });

    const registrar = makeSpyRegistrar();
    await manager.initialize([registrar]);

    await manager.registerWorkspace(wsPath, { id: "probe-broken", skipEnvValidation: true });

    expect(registrar.registered).toContain("probe-broken");
  });

  it("re-registers signals via handleWorkspaceConfigChange once setup completes", async () => {
    const kv = await makeIdempotentMemoryKV();
    const registry = new RegistryStorageAdapter(kv);
    await registry.initialize();

    const wsPath = await makeWorkspace(
      home,
      "completes-setup",
      'version: "1.0"\nworkspace:\n  name: completes-setup\n',
    );

    let probeValue = true;
    const manager = new WorkspaceManager(registry);
    manager.setRequiresSetupProbe({ check: () => Promise.resolve(probeValue) });

    const registrar = makeSpyRegistrar();
    await manager.initialize([registrar]);

    await manager.registerWorkspace(wsPath, { id: "completes-setup", skipEnvValidation: true });
    expect(registrar.registered).not.toContain("completes-setup");

    // Simulate the user finishing setup. The answer handler invokes
    // `restartSignalsForWorkspace`, which the public
    // `handleWorkspaceConfigChange` entrypoint also runs through.
    probeValue = false;
    const workspace = await registry.getWorkspace("completes-setup");
    if (!workspace) throw new Error("test seed missing");
    await manager.handleWorkspaceConfigChange(workspace, workspace.configPath);

    expect(registrar.registered).toContain("completes-setup");
  });

  it("unregisters signals via handleWorkspaceConfigChange when a healthy workspace re-enters setup", async () => {
    // Inverse of the test above. Decision 4 (re-setup recovery) lands the
    // workspace back in setup state when a previously-pinned credential
    // disconnects. `handleWorkspaceConfigChange` runs through
    // `restartSignalsForWorkspace`, which unregisters unconditionally then
    // re-registers via the probe gate — so the cron / fs-watch registrars
    // observe the unregister but the re-register is skipped while the
    // probe reports `requires_setup: true`. Pin both halves: the
    // unregister fires AND the registered count does not advance.
    const kv = await makeIdempotentMemoryKV();
    const registry = new RegistryStorageAdapter(kv);
    await registry.initialize();

    const wsPath = await makeWorkspace(
      home,
      "credential-disconnect",
      'version: "1.0"\nworkspace:\n  name: credential-disconnect\n',
    );

    let probeValue = false;
    const manager = new WorkspaceManager(registry);
    manager.setRequiresSetupProbe({ check: () => Promise.resolve(probeValue) });

    const registrar = makeSpyRegistrar();
    await manager.initialize([registrar]);

    await manager.registerWorkspace(wsPath, {
      id: "credential-disconnect",
      skipEnvValidation: true,
    });
    expect(registrar.registered).toContain("credential-disconnect");
    const registeredCountBefore = registrar.registered.length;

    // Flip the probe — the credential just disconnected and the workspace
    // is back in setup state. The next config-change tick must take the
    // signals offline.
    probeValue = true;
    const workspace = await registry.getWorkspace("credential-disconnect");
    if (!workspace) throw new Error("test seed missing");
    await manager.handleWorkspaceConfigChange(workspace, workspace.configPath);

    // Unregister fired — this is what stops cron timers from firing
    // sessions that would no-op on missing credentials.
    expect(registrar.unregistered).toContain("credential-disconnect");
    // Re-register was skipped by the setup gate — `registered` count
    // unchanged from the initial registration.
    expect(registrar.registered.length).toBe(registeredCountBefore);
  });
});
