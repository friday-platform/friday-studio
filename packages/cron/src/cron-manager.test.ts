import type { Logger } from "@atlas/logger";
import { createKVStorage, type KVStorage } from "@atlas/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CronManager, type OnMissedPolicy } from "./cron-manager.ts";

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

/**
 * Seed a timer whose `nextExecution` is already in the past, so the
 * onMissed policy enforcement at `start()` exercises the catchup path.
 */
async function seedMissedTimer(
  storage: KVStorage,
  opts: {
    timerKey: string;
    workspaceId: string;
    signalId: string;
    schedule: string;
    nextExecutionAgoMs: number;
    onMissed?: OnMissedPolicy;
    missedWindowMs?: number;
    lastExecution?: Date;
  },
): Promise<void> {
  await storage.set([`cron_timers`, opts.timerKey], {
    workspaceId: opts.workspaceId,
    signalId: opts.signalId,
    schedule: opts.schedule,
    timezone: "UTC",
    nextExecution: new Date(Date.now() - opts.nextExecutionAgoMs).toISOString(),
    lastExecution: opts.lastExecution?.toISOString(),
    onMissed: opts.onMissed,
    missedWindowMs: opts.missedWindowMs,
  });
}

interface FiredCall {
  workspaceId: string;
  signalId: string;
  scheduled: string;
  policy?: string;
  missedCount?: number;
  firstMissedAt?: string;
}

describe("CronManager — onMissed policy", () => {
  let storage: KVStorage;
  let manager: CronManager;
  let fired: FiredCall[];

  beforeEach(async () => {
    storage = await createKVStorage({ type: "memory" });
    manager = new CronManager(storage, logger);
    fired = [];
    manager.setWakeupCallback((workspaceId, signalId, signalData) => {
      const data = (signalData as { data: Record<string, unknown> }).data;
      fired.push({
        workspaceId,
        signalId,
        scheduled: data.scheduled as string,
        policy: data.policy as string | undefined,
        missedCount: data.missedCount as number | undefined,
        firstMissedAt: data.firstMissedAt as string | undefined,
      });
      return Promise.resolve();
    });
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  it("skip: no make-up fire, advances nextExecution past now", async () => {
    // Every minute, nextExecution slipped 5 min into the past
    await seedMissedTimer(storage, {
      timerKey: "user:every-minute",
      workspaceId: "user",
      signalId: "every-minute",
      schedule: "* * * * *",
      nextExecutionAgoMs: 5 * 60 * 1000,
      onMissed: "skip",
    });

    await manager.start();

    expect(fired).toHaveLength(0);
    const timers = manager.listTimers();
    expect(timers).toHaveLength(1);
    expect(timers[0]?.nextExecution.getTime()).toBeGreaterThan(Date.now());
  });

  it("coalesce: fires once with missedCount + firstMissedAt", async () => {
    // Every minute, nextExecution 4 min in the past → 4 missed slots,
    // collapse into one fire.
    await seedMissedTimer(storage, {
      timerKey: "user:digest",
      workspaceId: "user",
      signalId: "digest",
      schedule: "* * * * *",
      nextExecutionAgoMs: 4 * 60 * 1000,
      onMissed: "coalesce",
    });

    await manager.start();

    expect(fired).toHaveLength(1);
    expect(fired[0]?.policy).toBe("coalesce");
    expect(fired[0]?.missedCount).toBeGreaterThanOrEqual(3);
    expect(fired[0]?.firstMissedAt).toBeTruthy();
  });

  it("catchup: fires every missed slot in chronological order", async () => {
    // Every minute, 3 min in the past → 3 separate fires.
    await seedMissedTimer(storage, {
      timerKey: "user:replay",
      workspaceId: "user",
      signalId: "replay",
      schedule: "* * * * *",
      nextExecutionAgoMs: 3 * 60 * 1000,
      onMissed: "catchup",
    });

    await manager.start();

    expect(fired.length).toBeGreaterThanOrEqual(2);
    expect(fired.length).toBeLessThanOrEqual(4);
    for (const f of fired) {
      expect(f.policy).toBe("catchup");
      expect(f.missedCount).toBe(1);
    }
    // Strictly ascending scheduled times
    const slots = fired.map((f) => Date.parse(f.scheduled));
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i]).toBeGreaterThan(slots[i - 1] ?? 0);
    }
  });

  it("missedWindowMs caps how far back catchup walks", async () => {
    // Daemon "down" 2 hours (nextExecution = -2h) but window = 5 min →
    // catchup must drop everything older than 5 min.
    await seedMissedTimer(storage, {
      timerKey: "user:bounded-replay",
      workspaceId: "user",
      signalId: "bounded-replay",
      schedule: "* * * * *",
      nextExecutionAgoMs: 2 * 60 * 60 * 1000,
      onMissed: "catchup",
      missedWindowMs: 5 * 60 * 1000,
    });

    await manager.start();

    // 5-minute window with every-minute cron → 4-5 fires, never 120.
    expect(fired.length).toBeLessThanOrEqual(6);
    expect(fired.length).toBeGreaterThan(0);
  });

  it("manual: emits notification but does NOT fire the signal", async () => {
    await seedMissedTimer(storage, {
      timerKey: "user:expensive",
      workspaceId: "user",
      signalId: "expensive",
      schedule: "* * * * *",
      nextExecutionAgoMs: 3 * 60 * 1000,
      onMissed: "manual",
    });

    await manager.start();

    // No fires — manual surfaces in the UI for operator decision
    expect(fired).toHaveLength(0);
    // nextExecution still advances past now so the next normal slot fires
    const timer = manager.listTimers()[0];
    expect(timer?.nextExecution.getTime()).toBeGreaterThan(Date.now());
  });

  it("legacy timers (no onMissed) default to manual — no auto-fire", async () => {
    // Pre-G1.5 persisted timer — neither field present. Default
    // flipped from `skip` to `manual` 2026-05-03 so silent drops
    // never happen unannounced. The notification still publishes
    // (out-of-test surface); only the auto-fire is suppressed.
    await seedMissedTimer(storage, {
      timerKey: "user:legacy",
      workspaceId: "user",
      signalId: "legacy",
      schedule: "* * * * *",
      nextExecutionAgoMs: 5 * 60 * 1000,
    });

    await manager.start();

    expect(fired).toHaveLength(0);
  });

  it("registerTimer preserves persisted nextExecution on re-registration", async () => {
    // Daemon-startup ordering bug regression (live-tested 2026-05-03):
    //   workspaceManager.initialize → registrar calls registerTimer
    //   cronManager.start → loadPersistedTimers + applyMissedPolicy
    //
    // If registerTimer recomputed nextExecution every call, it would
    // overwrite the persisted "missed slot" with a fresh future slot
    // and applyMissedPolicy would never see a gap. Set a coalesce
    // timer with a past nextExecution, RE-REGISTER it (simulating
    // workspace.yml re-load on daemon restart), then start() —
    // applyMissedPolicy must still see the original past slot and
    // produce a coalesce fire.
    await seedMissedTimer(storage, {
      timerKey: "user:digest",
      workspaceId: "user",
      signalId: "digest",
      schedule: "* * * * *",
      nextExecutionAgoMs: 4 * 60 * 1000,
      onMissed: "coalesce",
    });

    // Simulates the cron registrar firing for the same signal on
    // restart. With the bug present, this would persist
    // nextExecution=now+~1min and applyMissedPolicy would do nothing.
    await manager.registerTimer({
      workspaceId: "user",
      signalId: "digest",
      schedule: "* * * * *",
      timezone: "UTC",
      onMissed: "coalesce",
    });

    await manager.start();

    expect(fired).toHaveLength(1);
    expect(fired[0]?.policy).toBe("coalesce");
    expect(fired[0]?.missedCount).toBeGreaterThanOrEqual(3);
  });

  it("registerTimer recomputes nextExecution when schedule changed", async () => {
    // If the user edited workspace.yml to a different cron expression,
    // we must NOT carry the old slot forward — it might never align
    // with the new schedule. Recompute from now.
    await seedMissedTimer(storage, {
      timerKey: "user:edited",
      workspaceId: "user",
      signalId: "edited",
      schedule: "*/30 * * * *", // every 30 min
      nextExecutionAgoMs: 5 * 60 * 1000,
      onMissed: "coalesce",
    });

    // Re-register with a DIFFERENT schedule.
    await manager.registerTimer({
      workspaceId: "user",
      signalId: "edited",
      schedule: "0 * * * *", // hourly — different from above
      timezone: "UTC",
      onMissed: "coalesce",
    });

    // No make-up fire — schedule edit invalidates the missed slot
    // because it wouldn't have aligned with the new schedule anyway.
    await manager.start();

    expect(fired).toHaveLength(0);
    const timer = manager.listTimers()[0];
    expect(timer?.nextExecution.getTime()).toBeGreaterThan(Date.now());
  });
});
