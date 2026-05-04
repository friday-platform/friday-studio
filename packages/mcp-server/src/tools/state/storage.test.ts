/**
 * Tests for the workspace-state JetStream KV facade. Covers:
 *  - append + count + ttl prune
 *  - lookup by top-level + dotted-path field
 *  - filter returns only unprocessed values
 *  - per-workspace isolation (two workspaces, same table name → no leak)
 *  - re-init resets module state for tests
 */

import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  _resetWorkspaceStateStorageForTest,
  appendStateEntry,
  filterStateValues,
  initWorkspaceStateStorage,
  lookupStateEntry,
} from "./storage.ts";

let server: TestNatsServer;
let nc: NatsConnection;

beforeAll(async () => {
  server = await startNatsTestServer();
  nc = await connect({ servers: server.url });
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await server.stop();
});

beforeEach(() => {
  _resetWorkspaceStateStorageForTest();
  initWorkspaceStateStorage(nc);
});

describe("workspace state storage", () => {
  it("appends and counts entries", async () => {
    const ws = `ws-${crypto.randomUUID()}`;
    const a = await appendStateEntry(ws, "items", { id: "a", v: 1 });
    expect(a).toEqual({ count: 1, pruned: 0 });
    const b = await appendStateEntry(ws, "items", { id: "b", v: 2 });
    expect(b).toEqual({ count: 2, pruned: 0 });
  });

  it("ttl prune removes expired entries", async () => {
    const ws = `ws-${crypto.randomUUID()}`;
    await appendStateEntry(ws, "items", { id: "old" });
    // Bump system clock by inserting an old entry directly is tricky; instead
    // append with a very large ttl_hours that collects nothing, then 0-ttl
    // (would prune everything). Use a tiny ttl after a small wait.
    await new Promise((r) => setTimeout(r, 30));
    const result = await appendStateEntry(ws, "items", { id: "new" }, 0.000001);
    // The 'old' entry is older than ~3.6ms cutoff; both fall outside.
    expect(result.pruned).toBeGreaterThanOrEqual(1);
  });

  it("lookup finds matching top-level field", async () => {
    const ws = `ws-${crypto.randomUUID()}`;
    await appendStateEntry(ws, "items", { id: "x", label: "alpha" });
    await appendStateEntry(ws, "items", { id: "y", label: "beta" });
    const found = await lookupStateEntry(ws, "items", "label", "beta");
    expect(found).not.toBeNull();
    expect(found?.id).toBe("y");
  });

  it("lookup follows dotted path", async () => {
    const ws = `ws-${crypto.randomUUID()}`;
    await appendStateEntry(ws, "items", { meta: { id: "deep" } });
    const found = await lookupStateEntry(ws, "items", "meta.id", "deep");
    expect(found).not.toBeNull();
  });

  it("lookup returns null when nothing matches", async () => {
    const ws = `ws-${crypto.randomUUID()}`;
    await appendStateEntry(ws, "items", { id: "a" });
    const found = await lookupStateEntry(ws, "items", "id", "missing");
    expect(found).toBeNull();
  });

  it("filter returns only unprocessed values", async () => {
    const ws = `ws-${crypto.randomUUID()}`;
    await appendStateEntry(ws, "items", { id: "a" });
    await appendStateEntry(ws, "items", { id: "b" });
    const result = await filterStateValues(ws, "items", "id", ["a", "b", "c", "d"]);
    expect(result.unprocessed.sort()).toEqual(["c", "d"]);
    expect(result.total).toBe(4);
    expect(result.filtered).toBe(2);
  });

  it("per-workspace isolation: same table name does not leak across workspaces", async () => {
    const ws1 = `ws-${crypto.randomUUID()}`;
    const ws2 = `ws-${crypto.randomUUID()}`;
    await appendStateEntry(ws1, "items", { id: "shared" });
    const found = await lookupStateEntry(ws2, "items", "id", "shared");
    expect(found).toBeNull();
  });

  it("workspace IDs with unsafe chars are sanitized", async () => {
    const ws = "user:test/with-unsafe@chars";
    const result = await appendStateEntry(ws, "items", { id: "ok" });
    expect(result.count).toBe(1);
  });

  it("throws when called before init", async () => {
    _resetWorkspaceStateStorageForTest();
    await expect(appendStateEntry("ws-x", "items", { id: "a" })).rejects.toThrow(/not initialized/);
  });
});
