/**
 * Handler-level tests for `friday migrate`.
 *
 *   - Legacy JetStream relocation runs BEFORE connectOrSpawn (so the
 *     ephemeral nats-server boots against the canonical store, not
 *     $TMPDIR).
 *   - --dry-run skips the relocation (dry-run must not mutate disk).
 *   - --json failure mode emits exactly one line to stdout and exits
 *     nonzero (the installer keys on exit code; a JSON-mode silent
 *     success on a real failure would render every error as ✓).
 *   - A relocation failure surfaces as a friendly Err and exits 1.
 *
 * Mocks: jetstream's `connectOrSpawn` / `runMigrations` and the
 * relocate helper. Everything else runs for real against tempdirs.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  fridayHome: "" as string,
  relocateInvocations: 0,
  /** Snapshot of relocateInvocations the instant connectOrSpawn fires. */
  relocateBeforeConnect: -1,
  /** Drive the relocate stub: "ok" returns a fake result; "throw" rejects. */
  relocateBehavior: "ok" as "ok" | "throw",
  postNatsBehavior: "throw" as "throw" | "succeed",
  runMigrationsResult: { ran: [] as string[], skipped: [] as string[], failed: [] as string[] },
  capturedStdout: [] as string[],
}));

vi.mock("./relocate-jetstream-store.ts", () => ({
  relocateJetStreamStore: vi.fn(() => {
    mockState.relocateInvocations += 1;
    if (mockState.relocateBehavior === "throw") {
      return Promise.reject(new Error("simulated relocate failure"));
    }
    return Promise.resolve({
      legacyPath: "/tmp/legacy",
      targetPath: "/tmp/target",
      moved: false,
      streamsMoved: 0,
    });
  }),
}));

vi.mock("@atlas/atlasd/migrations", () => ({ getAllMigrations: () => Promise.resolve([]) }));

vi.mock("jetstream", async () => {
  const actual = await vi.importActual<typeof import("jetstream")>("jetstream");
  return {
    ...actual,
    connectOrSpawn: vi.fn(() => {
      mockState.relocateBeforeConnect = mockState.relocateInvocations;
      if (mockState.postNatsBehavior === "throw") {
        return Promise.reject(new Error("test-marker: connectOrSpawn invoked"));
      }
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
  // Definitely-closed port so the daemon-alive probe returns false.
  process.env.FRIDAY_PORT_FRIDAY = "59998";

  mockState.relocateInvocations = 0;
  mockState.relocateBeforeConnect = -1;
  mockState.relocateBehavior = "ok";
  mockState.postNatsBehavior = "throw";
  mockState.runMigrationsResult = { ran: [], skipped: [], failed: [] };
  mockState.capturedStdout = [];

  exitCalls = [];
  exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
    const numeric = typeof code === "number" ? code : 0;
    exitCalls.push(numeric);
    throw new Error(`__test_exit__:${numeric}`);
  });
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

describe("migrate handler", () => {
  it("relocates legacy data before connecting to NATS", async () => {
    // The relocation MUST run first, otherwise the ephemeral
    // nats-server boots against $TMPDIR data and the move would be
    // racing with a live broker.
    const { handler } = await import("./migrate.ts");
    await expect(handler({ json: true })).rejects.toThrow(/__test_exit__:1/);
    expect(mockState.relocateInvocations).toBe(1);
    expect(mockState.relocateBeforeConnect).toBe(1); // relocate had run before connect
  });

  it("skips relocation on --dry-run (no disk mutation)", async () => {
    const { handler } = await import("./migrate.ts");
    await expect(handler({ dryRun: true, json: true })).rejects.toThrow(/__test_exit__:1/);
    expect(mockState.relocateInvocations).toBe(0);
  });

  it("relocate failure exits 1 with a helpful message", async () => {
    mockState.relocateBehavior = "throw";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { handler } = await import("./migrate.ts");
    await expect(handler({ json: true })).rejects.toThrow(/__test_exit__:1/);

    // connectOrSpawn must NOT have been reached.
    expect(mockState.relocateBeforeConnect).toBe(-1);
    // The handler reported the failure on stderr before exiting.
    const allStderr = errSpy.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(allStderr).toMatch(/relocate JetStream store/);
    expect(exitCalls).toContain(1);
    errSpy.mockRestore();
  });

  it("post-NATS failure in --json mode emits single-line JSON and exits 1", async () => {
    // A regression dropping `process.exit(1)` from the post-NATS-failed
    // JSON branch would render every customer's failed migration as a
    // green ✓ in the installer UI. This test catches that.
    mockState.postNatsBehavior = "succeed";
    mockState.runMigrationsResult = {
      ran: [],
      skipped: [],
      failed: ["m_20260501_120000_chat_to_jetstream"],
    };

    const { handler } = await import("./migrate.ts");
    await expect(handler({ json: true })).rejects.toThrow(/__test_exit__:1/);

    // Relocate must STILL run before connectOrSpawn even when the
    // post-NATS phase eventually proceeds successfully — guards against
    // a regression that only reorders the relocate call in the success
    // branch.
    expect(mockState.relocateBeforeConnect).toBe(1);

    // Exactly one stdout line — the JSON outcome.
    expect(mockState.capturedStdout).toHaveLength(1);
    const jsonLine = mockState.capturedStdout[0];
    expect(jsonLine).not.toContain("\n");
    const parsed = JSON.parse(jsonLine ?? "");
    expect(parsed).toMatchObject({
      ran: [],
      skipped: [],
      failed: ["m_20260501_120000_chat_to_jetstream"],
    });
    expect(exitCalls).toContain(1);
  });
});
