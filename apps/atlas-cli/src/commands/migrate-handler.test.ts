/**
 * Handler-level call-order tests for `friday migrate`.
 *
 * The unit tests in `migrate.test.ts` and `../pre-nats-migrations/*.test.ts`
 * cover the building blocks; this file pins the load-bearing ORDERING
 * contract documented in the v6 design doc:
 *
 *   1. Pre-NATS migrations run BEFORE `connectOrSpawn`.
 *   2. The PID lock is RELEASED before `connectOrSpawn` (KV lock owns
 *      the post-NATS phase; the file lock's scope ends with pre-NATS).
 *   3. When pre-NATS aborts (first-failure-aborts-queue), `connectOrSpawn`
 *      is NOT invoked — the post-NATS phase is skipped entirely.
 *
 * A regression in any of these would deadlock or silently corrupt the
 * KV lock, but unit-level tests of the runner alone wouldn't catch it.
 *
 * Mocks: only the module boundaries we need to observe (jetstream's
 * connectOrSpawn, the pre-NATS runner). `acquirePreNatsLock` runs for
 * real against a tempdir so we can assert on the actual on-disk lock
 * file's existence at the moment connectOrSpawn is invoked.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted state — shared between the vi.mock factories (which run before
// any test code) and the test bodies. Accessing `currentFridayHome`
// inside the connectOrSpawn mock requires this indirection because
// vi.mock factories execute at module-evaluation time.
const mockState = vi.hoisted(() => ({
  fridayHome: "" as string,
  preNatsResult: null as { outcomes: unknown[]; aborted: boolean } | null,
  connectOrSpawnInvocations: 0,
  // Snapshot of `existsSync(<fridayHome>/.pre-nats-migrate.lock)` taken
  // the instant connectOrSpawn fires — proves the lock was released
  // BEFORE post-NATS started.
  lockFileWhenConnectInvoked: null as boolean | null,
}));

vi.mock("../pre-nats-migrations/index.ts", () => ({
  runPreNatsMigrations: vi.fn(() => {
    if (!mockState.preNatsResult) {
      return Promise.reject(new Error("test setup error: preNatsResult not configured"));
    }
    return Promise.resolve(mockState.preNatsResult);
  }),
  listPreNatsEntries: () => [],
  preNatsMigrations: [{ id: "stub", name: "stub", description: "" }],
}));

vi.mock("jetstream", async () => {
  const actual = await vi.importActual<typeof import("jetstream")>("jetstream");
  return {
    ...actual,
    connectOrSpawn: vi.fn(() => {
      mockState.connectOrSpawnInvocations += 1;
      mockState.lockFileWhenConnectInvoked = existsSync(
        join(mockState.fridayHome, ".pre-nats-migrate.lock"),
      );
      // Throw to short-circuit the post-NATS phase — we don't need to
      // exercise runMigrations here, just observe that connectOrSpawn
      // was called (and at what point).
      return Promise.reject(new Error("test-marker: connectOrSpawn invoked"));
    }),
  };
});

let savedFridayHome: string | undefined;
let savedFridayPort: string | undefined;
let exitCalls: number[];
let exitSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  mockState.fridayHome = await mkdtemp(join(tmpdir(), "migrate-handler-test-"));
  savedFridayHome = process.env.FRIDAY_HOME;
  savedFridayPort = process.env.FRIDAY_PORT_FRIDAY;
  process.env.FRIDAY_HOME = mockState.fridayHome;
  // A definitely-closed port so the daemon-alive probe returns false
  // and the handler reaches the pre-NATS phase.
  process.env.FRIDAY_PORT_FRIDAY = "59998";

  mockState.preNatsResult = null;
  mockState.connectOrSpawnInvocations = 0;
  mockState.lockFileWhenConnectInvoked = null;

  // Replace process.exit so the test runner doesn't actually exit.
  // We capture the codes for assertions and throw a sentinel so the
  // handler unwinds the same way it does in production (via the
  // never-returning exit). vi.spyOn handles the typed-replacement
  // dance cleanly so we don't need an `any` cast.
  exitCalls = [];
  exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
    const numeric = typeof code === "number" ? code : 0;
    exitCalls.push(numeric);
    throw new Error(`__test_exit__:${numeric}`);
  });
});

afterEach(async () => {
  exitSpy.mockRestore();
  if (savedFridayHome === undefined) delete process.env.FRIDAY_HOME;
  else process.env.FRIDAY_HOME = savedFridayHome;
  if (savedFridayPort === undefined) delete process.env.FRIDAY_PORT_FRIDAY;
  else process.env.FRIDAY_PORT_FRIDAY = savedFridayPort;
  await rm(mockState.fridayHome, { recursive: true, force: true }).catch(() => {});
  vi.clearAllMocks();
});

describe("handler call-order contract", () => {
  it("pre-NATS runs and PID lock is released before connectOrSpawn", async () => {
    // Pre-NATS succeeds (empty outcomes, not aborted) → handler proceeds
    // to the post-NATS phase, which is when connectOrSpawn fires.
    mockState.preNatsResult = { outcomes: [], aborted: false };

    const { handler } = await import("./migrate.ts");

    // Handler will throw via the mocked process.exit / connectOrSpawn.
    // We don't care about the exception — only what state it left behind.
    await expect(handler({ json: true })).rejects.toThrow();

    expect(mockState.connectOrSpawnInvocations).toBe(1);
    expect(mockState.lockFileWhenConnectInvoked).toBe(false);
    // And after the handler returns, the lock file is also gone
    // (defensive — `release()` is the producer of this state).
    expect(existsSync(join(mockState.fridayHome, ".pre-nats-migrate.lock"))).toBe(false);
  });

  it("connectOrSpawn is NOT invoked when pre-NATS aborts", async () => {
    // Mimic a registry-level abort: the runner returns aborted=true with
    // an error outcome. The handler should emit JSON, exit nonzero, and
    // never reach connectOrSpawn.
    mockState.preNatsResult = {
      outcomes: [
        {
          id: "stub",
          status: "error",
          legacy_path: "",
          target_path: "",
          target_source: "default",
          duration_ms: 0,
          error: { kind: "unknown", message: "simulated failure" },
        },
      ],
      aborted: true,
    };

    const { handler } = await import("./migrate.ts");

    await expect(handler({ json: true })).rejects.toThrow(/__test_exit__:1/);

    expect(mockState.connectOrSpawnInvocations).toBe(0);
    // process.exit(1) is the contract on abort.
    expect(exitCalls).toContain(1);
    // Lock was released by the finally block before the abort branch.
    expect(existsSync(join(mockState.fridayHome, ".pre-nats-migrate.lock"))).toBe(false);
  });
});
