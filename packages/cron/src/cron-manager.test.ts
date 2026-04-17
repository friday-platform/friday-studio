import type { Logger } from "@atlas/logger";
import { createKVStorage, type KVStorage } from "@atlas/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CronManager } from "./cron-manager.ts";

/** Silent logger — the cron manager only needs the call surface, not output. */
function makeSilentLogger(): Logger {
  const self: Logger = {
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
    child: () => self,
  };
  return self;
}
const logger = makeSilentLogger();

/**
 * Drop an already-persisted timer into storage so we can exercise
 * `start()` without running through `registerTimer` (which would need
 * a wakeup callback and fight the tick loop during the test).
 */
async function seedTimer(
  storage: KVStorage,
  timerKey: string,
  workspaceId: string,
  signalId: string,
): Promise<void> {
  await storage.set([`cron_timers`, timerKey], {
    workspaceId,
    signalId,
    schedule: "*/2 * * * *",
    timezone: "UTC",
    // Far-future to guarantee the tick loop can't execute during the test.
    nextExecution: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
}

async function listPersistedTimerKeys(storage: KVStorage): Promise<string[]> {
  const out: string[] = [];
  for await (const { key } of storage.list<unknown>([`cron_timers`])) {
    const last = key[key.length - 1];
    if (typeof last === "string") out.push(last);
  }
  return out;
}

describe("CronManager — orphan pruning", () => {
  let storage: KVStorage;
  let manager: CronManager;

  beforeEach(async () => {
    // Factory returns an initialized KVStorage; going through it avoids
    // the variance mismatch between MemoryKVStorage's `string[]` keys and
    // the KVStorage interface's generic `U extends readonly ...`.
    storage = await createKVStorage({ type: "memory" });
    manager = new CronManager(storage, logger);
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  it("keeps timers whose workspace is in the known set", async () => {
    await seedTimer(storage, "user:autopilot-tick-cron", "user", "autopilot-tick-cron");
    await seedTimer(storage, "system:autopilot-tick-cron", "system", "autopilot-tick-cron");

    await manager.start({ knownWorkspaceIds: new Set(["user", "system"]) });

    expect(manager.getStats().totalTimers).toBe(2);
    expect(await listPersistedTimerKeys(storage)).toHaveLength(2);
  });

  it("drops in-memory + persisted timers for unknown workspaces", async () => {
    await seedTimer(storage, "user:autopilot-tick-cron", "user", "autopilot-tick-cron");
    await seedTimer(
      storage,
      "poached_quiche:autopilot-tick-cron",
      "poached_quiche",
      "autopilot-tick-cron",
    );
    await seedTimer(storage, "bitter_jam:autopilot-tick-cron", "bitter_jam", "autopilot-tick-cron");

    await manager.start({ knownWorkspaceIds: new Set(["user"]) });

    expect(manager.getStats().totalTimers).toBe(1);
    const remaining = await listPersistedTimerKeys(storage);
    expect(remaining).toEqual(["user:autopilot-tick-cron"]);
  });

  it("drops all timers when the known set is empty", async () => {
    await seedTimer(storage, "a:sig", "a", "sig");
    await seedTimer(storage, "b:sig", "b", "sig");

    await manager.start({ knownWorkspaceIds: new Set() });

    expect(manager.getStats().totalTimers).toBe(0);
    expect(await listPersistedTimerKeys(storage)).toHaveLength(0);
  });

  it("leaves everything alone when knownWorkspaceIds is omitted", async () => {
    // Backwards-compat: callers that haven't opted into pruning (e.g.
    // older daemon binaries, tests) must not see any timer vanish.
    await seedTimer(storage, "ghost:sig", "ghost", "sig");
    await seedTimer(storage, "user:sig", "user", "sig");

    await manager.start();

    expect(manager.getStats().totalTimers).toBe(2);
    expect(await listPersistedTimerKeys(storage)).toHaveLength(2);
  });

  it("prunes every timer a missing workspace owns, not just one", async () => {
    // Single workspace with two signals — losing the workspace should
    // remove both rows, otherwise we'd just half-clean and the log
    // spam would continue for the surviving timer.
    await seedTimer(storage, "ghost:cron-a", "ghost", "cron-a");
    await seedTimer(storage, "ghost:cron-b", "ghost", "cron-b");
    await seedTimer(storage, "user:cron-a", "user", "cron-a");

    await manager.start({ knownWorkspaceIds: new Set(["user"]) });

    const remaining = await listPersistedTimerKeys(storage);
    expect(remaining.sort()).toEqual(["user:cron-a"]);
  });
});
