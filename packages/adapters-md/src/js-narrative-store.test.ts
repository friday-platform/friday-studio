import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JetStreamMemoryAdapter } from "./js-memory-adapter.ts";
import { JetStreamNarrativeStore } from "./js-narrative-store.ts";

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

const makeStore = (workspaceId: string, name: string) =>
  new JetStreamNarrativeStore({ nc, workspaceId, name });

const makeEntry = (overrides: Partial<{ id: string; text: string; createdAt: string }> = {}) => ({
  id: overrides.id ?? crypto.randomUUID(),
  text: overrides.text ?? "hello",
  createdAt: overrides.createdAt ?? new Date().toISOString(),
});

describe("JetStreamNarrativeStore", () => {
  it("append + read round-trips a single entry", async () => {
    const store = makeStore(`ws-${crypto.randomUUID()}`, "notes");
    const entry = makeEntry({ text: "first" });
    const appended = await store.append(entry);
    expect(appended.id).toBe(entry.id);

    const entries = await store.read();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe("first");
  });

  it("read returns empty for a never-written narrative", async () => {
    const store = makeStore(`ws-${crypto.randomUUID()}`, "fresh");
    expect(await store.read()).toEqual([]);
  });

  it("append is FIFO per (workspace, name)", async () => {
    const store = makeStore(`ws-${crypto.randomUUID()}`, "log");
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const e = makeEntry({ text: `msg-${i}` });
      ids.push(e.id);
      await store.append(e);
    }
    const entries = await store.read();
    expect(entries.map((e) => e.id)).toEqual(ids);
  });

  it("forget tombstones the entry on subsequent reads", async () => {
    const store = makeStore(`ws-${crypto.randomUUID()}`, "todos");
    const a = makeEntry({ text: "a" });
    const b = makeEntry({ text: "b" });
    const c = makeEntry({ text: "c" });
    await store.append(a);
    await store.append(b);
    await store.append(c);

    await store.forget(b.id);

    const entries = await store.read();
    expect(entries.map((e) => e.text)).toEqual(["a", "c"]);
  });

  it("forget on a non-existent id is a no-op", async () => {
    const store = makeStore(`ws-${crypto.randomUUID()}`, "todos");
    await store.append(makeEntry({ text: "a" }));
    await store.forget("nonexistent");
    const entries = await store.read();
    expect(entries).toHaveLength(1);
  });

  it("read filters by `since`", async () => {
    const store = makeStore(`ws-${crypto.randomUUID()}`, "log");
    await store.append(makeEntry({ text: "old", createdAt: "2026-01-01T00:00:00Z" }));
    await store.append(makeEntry({ text: "new", createdAt: "2026-05-01T00:00:00Z" }));
    const entries = await store.read({ since: "2026-04-01T00:00:00Z" });
    expect(entries.map((e) => e.text)).toEqual(["new"]);
  });

  it("read respects `limit`", async () => {
    const store = makeStore(`ws-${crypto.randomUUID()}`, "log");
    for (let i = 0; i < 5; i++) await store.append(makeEntry({ text: `m${i}` }));
    const entries = await store.read({ limit: 2 });
    expect(entries).toHaveLength(2);
  });

  it("render produces markdown bullets", async () => {
    const store = makeStore(`ws-${crypto.randomUUID()}`, "preferences");
    await store.append(
      makeEntry({ id: "abc", text: "use snake_case", createdAt: "2026-05-01T00:00:00.000Z" }),
    );
    const rendered = await store.render();
    expect(rendered).toContain("use snake_case");
    expect(rendered).toContain("(id: abc)");
  });

  it("idempotent dedup: same id appended twice stored once", async () => {
    const store = makeStore(`ws-${crypto.randomUUID()}`, "dedupe");
    const e = makeEntry({ text: "once" });
    await store.append(e);
    await store.append(e);
    const entries = await store.read();
    expect(entries).toHaveLength(1);
  });
});

describe("JetStreamMemoryAdapter", () => {
  it("ensureRoot creates a discoverable index entry", async () => {
    const wsId = `ws-${crypto.randomUUID()}`;
    const adapter = new JetStreamMemoryAdapter({ nc });
    await adapter.ensureRoot(wsId, "notes");
    const stores = await adapter.list(wsId);
    expect(stores.map((s) => s.name)).toContain("notes");
  });

  it("list returns only narrative stores for the requested workspace", async () => {
    const a = `ws-${crypto.randomUUID()}`;
    const b = `ws-${crypto.randomUUID()}`;
    const adapter = new JetStreamMemoryAdapter({ nc });
    const sa = await adapter.store(a, "alpha");
    const sb1 = await adapter.store(b, "beta-1");
    const sb2 = await adapter.store(b, "beta-2");
    await sa.append(makeEntry({ text: "x" }));
    await sb1.append(makeEntry({ text: "x" }));
    await sb2.append(makeEntry({ text: "x" }));

    const ofB = await adapter.list(b);
    const names = ofB.map((s) => s.name).sort();
    expect(names).toEqual(["beta-1", "beta-2"]);
  });

  it("bootstrap concatenates all narrative renders for the workspace", async () => {
    const wsId = `ws-${crypto.randomUUID()}`;
    const adapter = new JetStreamMemoryAdapter({ nc });
    const a = await adapter.store(wsId, "notes");
    const b = await adapter.store(wsId, "decisions");
    await a.append(makeEntry({ text: "note1" }));
    await b.append(makeEntry({ text: "decision1" }));

    const block = await adapter.bootstrap(wsId, "agent-x");
    expect(block).toContain("note1");
    expect(block).toContain("decision1");
  });
});
