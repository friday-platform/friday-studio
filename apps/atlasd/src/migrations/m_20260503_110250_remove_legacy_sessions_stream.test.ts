/**
 * Integration test: legacy SESSIONS-stream retirement migration.
 *
 * Spins up a real NATS test server, primes a `SESSIONS` stream with
 * the pre-PR-#164 shape (subjects `sessions.*.events`), publishes a
 * handful of events, runs the migration, and asserts (a) the stream
 * is gone, (b) a JSONL backup file exists at the expected path with
 * one record per published event.
 */

import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import type { Logger } from "@atlas/logger";
import { createJetStreamFacade, enc } from "jetstream";
import { connect, type NatsConnection, RetentionPolicy, StorageType } from "nats";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migration } from "./m_20260503_110250_remove_legacy_sessions_stream.ts";

let server: TestNatsServer;
let nc: NatsConnection;
let tmpHome: string;
let originalHome: string | undefined;

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
  originalHome = process.env.FRIDAY_HOME;
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await server.stop();
  if (originalHome === undefined) delete process.env.FRIDAY_HOME;
  else process.env.FRIDAY_HOME = originalHome;
});

afterEach(async () => {
  // Tear down whatever the migration / a test left behind so each
  // case starts from a clean broker state.
  const facade = createJetStreamFacade(nc);
  await facade.stream.delete("SESSIONS");
  if (tmpHome) {
    await rm(tmpHome, { recursive: true, force: true });
  }
});

async function freshHome(): Promise<string> {
  tmpHome = await mkdtemp(join(tmpdir(), "atlas-legacy-sessions-"));
  process.env.FRIDAY_HOME = tmpHome;
  return tmpHome;
}

async function createLegacySessionsStream(): Promise<void> {
  const jsm = await nc.jetstreamManager();
  await jsm.streams.add({
    name: "SESSIONS",
    subjects: ["sessions.*.events"],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
  });
}

async function publishLegacy(sessionId: string, payload: unknown): Promise<void> {
  await nc
    .jetstream()
    .publish(`sessions.${sessionId}.events`, enc.encode(JSON.stringify(payload)));
}

describe("m_20260503_110250_remove_legacy_sessions_stream", () => {
  it("dumps messages to a JSONL backup, then deletes the stream", async () => {
    const home = await freshHome();
    await createLegacySessionsStream();
    await publishLegacy("alpha", { type: "session:start", sessionId: "alpha", n: 1 });
    await publishLegacy("alpha", { type: "step:start", sessionId: "alpha", n: 2 });
    await publishLegacy("beta", { type: "session:start", sessionId: "beta", n: 3 });

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });

    expect(await facade.stream.info("SESSIONS")).toBeNull();

    const isoDate = new Date().toISOString().slice(0, 10);
    const backupPath = join(home, `legacy-sessions-backup-${isoDate}.jsonl`);
    const body = await readFile(backupPath, "utf-8");
    const lines = body.trim().split("\n");
    expect(lines).toHaveLength(3);

    const records = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(records.map((r) => r.subject)).toEqual([
      "sessions.alpha.events",
      "sessions.alpha.events",
      "sessions.beta.events",
    ]);
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3]);
    for (const r of records) {
      expect(typeof r.data).toBe("string");
      expect(typeof r.time).toBe("string");
      expect(r.time).toMatch(/Z$/);
      expect(JSON.parse(r.data as string)).toMatchObject({ sessionId: expect.any(String) });
    }
  });

  it("is a no-op when SESSIONS does not exist", async () => {
    const home = await freshHome();
    const facade = createJetStreamFacade(nc);

    await expect(
      migration.run({ nc, js: facade, logger: noopLogger }),
    ).resolves.toBeUndefined();

    const isoDate = new Date().toISOString().slice(0, 10);
    const backupPath = join(home, `legacy-sessions-backup-${isoDate}.jsonl`);
    await expect(readFile(backupPath, "utf-8")).rejects.toThrow();
  });

  it("preserves an existing same-day backup file by suffixing the new one", async () => {
    const home = await freshHome();
    await createLegacySessionsStream();
    await publishLegacy("gamma", { type: "session:start", sessionId: "gamma", n: 1 });

    // Plant a prior backup at the canonical path — simulates a rerun
    // after a previous crash between backup-write and stream-delete.
    const isoDate = new Date().toISOString().slice(0, 10);
    const canonicalPath = join(home, `legacy-sessions-backup-${isoDate}.jsonl`);
    await writeFile(canonicalPath, "PRIOR_BACKUP\n", { encoding: "utf-8" });

    const facade = createJetStreamFacade(nc);
    await migration.run({ nc, js: facade, logger: noopLogger });

    // Prior file untouched.
    expect(await readFile(canonicalPath, "utf-8")).toBe("PRIOR_BACKUP\n");

    // A second backup file written with an epoch suffix.
    const files = await readdir(home);
    const suffixed = files.filter(
      (f) =>
        f.startsWith(`legacy-sessions-backup-${isoDate}-`) && f.endsWith(".jsonl"),
    );
    expect(suffixed).toHaveLength(1);

    expect(await facade.stream.info("SESSIONS")).toBeNull();
  });
});
