import { describe, expect, it } from "vitest";
import { JobScheduler } from "./job-scheduler.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("JobScheduler.serialize", () => {
  it("runs callers in arrival order with at most one in flight", async () => {
    const scheduler = new JobScheduler<string>();
    const events: string[] = [];

    const make = (id: string, delay: number) => () =>
      wait(delay).then(() => {
        events.push(`done:${id}`);
        return id;
      });

    const p1 = scheduler.serialize("job", undefined, make("a", 50));
    const p2 = scheduler.serialize("job", undefined, make("b", 10));
    const p3 = scheduler.serialize("job", undefined, make("c", 5));

    const results = await Promise.all([p1, p2, p3]);
    expect(results).toEqual(["a", "b", "c"]);
    expect(events).toEqual(["done:a", "done:b", "done:c"]);
  });

  it("isolates jobs by name — different jobs run in parallel", async () => {
    const scheduler = new JobScheduler<string>();
    const startedAt: Record<string, number> = {};

    const make = (id: string, delay: number) => () => {
      startedAt[id] = Date.now();
      return wait(delay).then(() => id);
    };

    const start = Date.now();
    const [a, b] = await Promise.all([
      scheduler.serialize("job-a", undefined, make("a", 30)),
      scheduler.serialize("job-b", undefined, make("b", 30)),
    ]);
    expect(a).toBe("a");
    expect(b).toBe("b");
    // Both should have started near t=0 (parallel), not staggered.
    expect(startedAt.a! - start).toBeLessThan(20);
    expect(startedAt.b! - start).toBeLessThan(20);
  });

  it("propagates rejection without breaking subsequent callers", async () => {
    const scheduler = new JobScheduler<string>();

    const failing = scheduler.serialize("job", undefined, () => Promise.reject(new Error("boom")));
    const ok = scheduler.serialize("job", undefined, () => Promise.resolve("after"));

    await expect(failing).rejects.toThrow("boom");
    await expect(ok).resolves.toBe("after");
  });

  it("throws on max_queued overflow", async () => {
    const scheduler = new JobScheduler<string>();

    // Active + 2 queued = 3 pending. max=2 → 4th throws.
    const _running = scheduler.serialize("job", 2, () => wait(50).then(() => "running"));
    const _q1 = scheduler.serialize("job", 2, () => Promise.resolve("q1"));
    expect(() => scheduler.serialize("job", 2, () => Promise.resolve("q2"))).toThrow(/max_queued/);

    // Drain.
    await _running;
    await _q1;
  });

  it("does not count completed callers against max_queued", async () => {
    const scheduler = new JobScheduler<string>();

    await scheduler.serialize("job", 1, () => Promise.resolve("first"));
    // After first completes, slot is free again.
    await scheduler.serialize("job", 1, () => Promise.resolve("second"));
    // Both succeeded — implicit assertion (no throw).
  });
});

describe("JobScheduler.coalesce", () => {
  it("collapses a burst of callers into one execution; everyone gets the same result", async () => {
    const scheduler = new JobScheduler<string>();
    let runCount = 0;

    // Block the chain so callers stack up before any of them runs.
    let releaseFirst: () => void;
    const firstDone = new Promise<void>((r) => {
      releaseFirst = r;
    });

    const blocking = scheduler.coalesce("job", () => firstDone.then(() => "first"));

    // Now while "first" is still in flight, queue 3 more — they should all
    // share the same eventual coalesced run.
    const a = scheduler.coalesce("job", () => {
      runCount++;
      return Promise.resolve("a");
    });
    const b = scheduler.coalesce("job", () => {
      runCount++;
      return Promise.resolve("b");
    });
    const c = scheduler.coalesce("job", () => {
      runCount++;
      return Promise.resolve("c");
    });

    releaseFirst!();
    const [first, ra, rb, rc] = await Promise.all([blocking, a, b, c]);

    expect(first).toBe("first");
    expect([ra, rb, rc]).toEqual(["c", "c", "c"]); // latest wins
    expect(runCount).toBe(1); // only the latest's runner actually executed
  });

  it("propagates rejection to all coalesce waiters", async () => {
    const scheduler = new JobScheduler<string>();

    let release: () => void;
    const firstDone = new Promise<void>((r) => {
      release = r;
    });
    const blocking = scheduler.coalesce("job", () => firstDone.then(() => "first"));

    const a = scheduler.coalesce("job", () => Promise.reject(new Error("nope")));
    const b = scheduler.coalesce("job", () => Promise.reject(new Error("nope")));

    release!();
    await blocking;
    await expect(a).rejects.toThrow("nope");
    await expect(b).rejects.toThrow("nope");
  });

  it("isolates jobs by name", async () => {
    const scheduler = new JobScheduler<string>();
    const a = await scheduler.coalesce("job-a", () => Promise.resolve("a"));
    const b = await scheduler.coalesce("job-b", () => Promise.resolve("b"));
    expect(a).toBe("a");
    expect(b).toBe("b");
  });
});

describe("JobScheduler.shutdown", () => {
  it("rejects pending coalesce waiters with the given reason", async () => {
    const scheduler = new JobScheduler<string>();

    let release: () => void;
    const firstDone = new Promise<void>((r) => {
      release = r;
    });
    const blocking = scheduler.coalesce("job", () => firstDone.then(() => "first"));

    const pending = scheduler.coalesce("job", () => Promise.resolve("pending"));

    scheduler.shutdown("test stop");
    await expect(pending).rejects.toThrow("test stop");

    release!();
    await blocking;
  });
});
