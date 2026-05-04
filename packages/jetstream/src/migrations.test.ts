/**
 * Lock + dry-run behavior of `runMigrations`. The runner is called by
 * both the daemon's startup hook and `atlas migrate`; this test covers
 * the mutual exclusion between them, plus the read-only carve-out for
 * `--dry-run`. Per-migration body correctness lives in each adapter's
 * own tests.
 */

import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import type { Logger } from "@atlas/logger";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJetStreamFacade } from "./facade.ts";
import { dec } from "./helpers.ts";
import {
  MIGRATIONS_BUCKET,
  type Migration,
  MigrationLockError,
  runMigrations,
} from "./migrations.ts";

let server: TestNatsServer;
let nc: NatsConnection;

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

beforeAll(async () => {
  server = await startNatsTestServer();
  nc = await connect({ servers: server.url });
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await server.stop();
});

/**
 * Each test gets a unique migration id so the audit trail in the
 * shared `_FRIDAY_MIGRATIONS` bucket doesn't bleed across tests.
 */
function uniqueMigration(body: () => Promise<void> = async () => {}): Migration {
  const id = `test_${crypto.randomUUID().replace(/-/g, "")}`;
  return { id, name: `test ${id}`, run: body };
}

async function clearLock(): Promise<void> {
  const js = createJetStreamFacade(nc);
  const kv = await js.kv.getOrCreate(MIGRATIONS_BUCKET, { history: 5 });
  try {
    await kv.delete("_lock");
  } catch {
    // ignore — already absent
  }
}

describe("runMigrations lock", () => {
  it("releases the lock after a successful run", async () => {
    await clearLock();
    const m = uniqueMigration();
    const result = await runMigrations(nc, [m], noopLogger, { runner: "test" });
    expect(result.ran).toEqual([m.id]);

    const js = createJetStreamFacade(nc);
    const kv = await js.kv.getOrCreate(MIGRATIONS_BUCKET, { history: 5 });
    const lock = await kv.get("_lock");
    expect(lock?.operation).not.toBe("PUT");
  });

  it("releases the lock after a failed migration", async () => {
    await clearLock();
    const m = uniqueMigration(() => Promise.reject(new Error("boom")));
    const result = await runMigrations(nc, [m], noopLogger, { runner: "test" });
    expect(result.failed).toEqual([m.id]);

    const js = createJetStreamFacade(nc);
    const kv = await js.kv.getOrCreate(MIGRATIONS_BUCKET, { history: 5 });
    const lock = await kv.get("_lock");
    expect(lock?.operation).not.toBe("PUT");
  });

  it("rejects a concurrent runner with MigrationLockError", async () => {
    await clearLock();
    let firstStarted = false;
    let release: () => void = () => {};
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = uniqueMigration(async () => {
      firstStarted = true;
      await block;
    });
    const fast = uniqueMigration();

    const slowRun = runMigrations(nc, [slow], noopLogger, { runner: "first" });
    // Wait for the slow runner to acquire the lock.
    while (!firstStarted) await new Promise((r) => setTimeout(r, 5));

    let caught: unknown;
    try {
      await runMigrations(nc, [fast], noopLogger, { runner: "second" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MigrationLockError);
    const err = caught as MigrationLockError;
    expect(err.holder).toContain("first/");
    expect(err.expiresAt).toMatch(/Z$/);

    release();
    const slowResult = await slowRun;
    expect(slowResult.ran).toEqual([slow.id]);
  });

  it("dry-run does not acquire the lock", async () => {
    await clearLock();
    const m = uniqueMigration();
    // Hold the lock manually via a stand-in concurrent runner — if dry
    // run took the lock, the parallel call below would deadlock or
    // throw. Instead we just check that two dry-runs in parallel both
    // succeed.
    const a = runMigrations(nc, [m], noopLogger, { runner: "a", dryRun: true });
    const b = runMigrations(nc, [m], noopLogger, { runner: "b", dryRun: true });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ran).toEqual([m.id]);
    expect(rb.ran).toEqual([m.id]);
  });

  it("takes over an expired lock", async () => {
    await clearLock();
    const js = createJetStreamFacade(nc);
    const kv = await js.kv.getOrCreate(MIGRATIONS_BUCKET, { history: 5 });
    // Plant an expired lock record by hand.
    const expired = JSON.stringify({
      holder: "ghost/0@nowhere",
      acquiredAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 30_000).toISOString(),
    });
    await kv.put("_lock", new TextEncoder().encode(expired));

    const m = uniqueMigration();
    const result = await runMigrations(nc, [m], noopLogger, { runner: "takeover" });
    expect(result.ran).toEqual([m.id]);

    // Lock released after run.
    const lock = await kv.get("_lock");
    expect(lock?.operation).not.toBe("PUT");
  });

  it("does not release a lock another holder owns", async () => {
    await clearLock();
    const js = createJetStreamFacade(nc);
    const kv = await js.kv.getOrCreate(MIGRATIONS_BUCKET, { history: 5 });

    // Plant a foreign, valid lock — the runner should refuse to acquire,
    // and crucially must NOT delete it on the way out.
    const foreign = JSON.stringify({
      holder: "other/9999@elsewhere",
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await kv.put("_lock", new TextEncoder().encode(foreign));

    const m = uniqueMigration();
    await expect(runMigrations(nc, [m], noopLogger, { runner: "intruder" })).rejects.toBeInstanceOf(
      MigrationLockError,
    );

    const lock = await kv.get("_lock");
    expect(lock?.operation).toBe("PUT");
    if (!lock) throw new Error("lock unexpectedly absent");
    const parsed = JSON.parse(dec.decode(lock.value)) as { holder: string };
    expect(parsed.holder).toBe("other/9999@elsewhere");

    // Cleanup so other tests start fresh.
    await kv.delete("_lock");
  });
});
