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
 *   4. In `--json` mode, post-NATS failures still exit nonzero — the
 *      Tauri command keys on exit code, so silent JSON-mode success on a
 *      real failure would render every migration error as ✓ in the
 *      installer UI.
 *
 * Mocks: only the module boundaries we need to observe (jetstream's
 * connectOrSpawn / runMigrations / getAllMigrations + the pre-NATS
 * runner). `acquirePreNatsLock` runs for real against a tempdir so we
 * can assert on the actual on-disk lock file's existence at the moment
 * connectOrSpawn is invoked.
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
  // Behavior knob for the post-NATS phase. "throw" short-circuits via
  // connectOrSpawn rejection (the default — most tests don't care
  // about runMigrations). "succeed" returns a fake handle so the
  // handler proceeds into runMigrations, which then returns
  // `runMigrationsResult` (use that to drive failure outcomes).
  postNatsBehavior: "throw" as "throw" | "succeed",
  runMigrationsResult: { ran: [] as string[], skipped: [] as string[], failed: [] as string[] },
  // Captured stdout writes — populated by a console.log spy. Used to
  // assert the single-line JSON contract in failure-mode tests.
  capturedStdout: [] as string[],
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

vi.mock("@atlas/atlasd/migrations", () => ({
  // Empty post-NATS registry — runMigrations is mocked anyway, so this
  // never runs. Just satisfies the import.
  getAllMigrations: () => Promise.resolve([]),
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
      if (mockState.postNatsBehavior === "throw") {
        // Short-circuit: most call-order tests don't need the post-NATS
        // phase to actually proceed — they just observe that
        // connectOrSpawn was called (and at what point).
        return Promise.reject(new Error("test-marker: connectOrSpawn invoked"));
      }
      // Success path: return a minimal handle so the handler proceeds
      // into runMigrations. `nc` doesn't matter — runMigrations is mocked.
      return Promise.resolve({
        nc: {} as unknown as import("jetstream").ConnectionHandle["nc"],
        cleanup: () => Promise.resolve(),
      });
    }),
    runMigrations: vi.fn(() => Promise.resolve(mockState.runMigrationsResult)),
  };
});

let savedFridayHome: string | undefined;
let savedFridayPort: string | undefined;
let exitCalls: number[];
let exitSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

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
  mockState.postNatsBehavior = "throw";
  mockState.runMigrationsResult = { ran: [], skipped: [], failed: [] };
  mockState.capturedStdout = [];

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

  // Capture console.log for the JSON-mode assertions. Cast to string
  // covers the typed-args contract; non-string args (Buffers etc.)
  // shouldn't occur in this codepath.
  logSpy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
    mockState.capturedStdout.push(typeof line === "string" ? line : String(line));
  });
});

afterEach(async () => {
  exitSpy.mockRestore();
  logSpy.mockRestore();
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
    // to the post-NATS phase, which is when connectOrSpawn fires. The
    // mock rejects, the handler's catch block calls process.exit(1)
    // which throws `__test_exit__:1` — matching that prefix proves we
    // traversed the production exit path (not just the raw mock error).
    mockState.preNatsResult = { outcomes: [], aborted: false };

    const { handler } = await import("./migrate.ts");

    await expect(handler({ json: true })).rejects.toThrow(/__test_exit__:1/);

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

  it("post-NATS failure in --json mode emits single-line JSON and exits 1", async () => {
    // The fix-commit invariant: when `runMigrations` returns
    // `failed.length > 0` in --json mode, the handler must
    // (a) emit a single-line JSON to stdout (so the Tauri scanner can
    //     parse it line-by-line — pretty-printed output would never
    //     match the expected shape), and
    // (b) exit nonzero (so callers like the Tauri command, which key on
    //     the exit code, surface the failure to Svelte).
    //
    // A regression dropping `process.exit(1)` from the post-NATS-failed
    // JSON branch would render every customer's failed migration as a
    // green ✓ in the installer UI. This test catches that.
    mockState.preNatsResult = { outcomes: [], aborted: false };
    mockState.postNatsBehavior = "succeed";
    mockState.runMigrationsResult = {
      ran: [],
      skipped: [],
      failed: ["m_20260501_120000_chat_to_jetstream"],
    };

    const { handler } = await import("./migrate.ts");

    await expect(handler({ json: true })).rejects.toThrow(/__test_exit__:1/);

    // Exactly one stdout line — the JSON outcome. Anything more would
    // mean we leaked log output to stdout, breaking the Tauri scanner.
    expect(mockState.capturedStdout).toHaveLength(1);
    const jsonLine = mockState.capturedStdout[0];
    // It must be valid single-line JSON (no embedded newlines).
    expect(jsonLine).not.toContain("\n");
    const parsed = JSON.parse(jsonLine ?? "");
    expect(parsed).toMatchObject({
      preNats: [],
      ran: [],
      skipped: [],
      failed: ["m_20260501_120000_chat_to_jetstream"],
    });
    expect(exitCalls).toContain(1);
  });
});
