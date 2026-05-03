/**
 * Smoke tests for `JetStreamDocumentStore`. Mirrors the contract
 * exercised by `FileSystemDocumentStore` — write / read / exists /
 * list / delete / saveState / loadState — at workspace and session
 * scopes, plus per-workspace bucket isolation.
 */

import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { JetStreamDocumentStore } from "./jetstream-document-store.ts";

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

const Doc = z.object({ name: z.string(), count: z.number() });

describe("JetStreamDocumentStore", () => {
  it("writes + reads a workspace-scoped document", async () => {
    const store = new JetStreamDocumentStore(nc);
    const ws = `ws-${crypto.randomUUID()}`;
    const written = await store.write(
      { workspaceId: ws },
      "items",
      "a",
      { name: "foo", count: 1 },
      Doc,
    );
    expect.assert(written.ok === true);
    expect(written.data.data).toEqual({ name: "foo", count: 1 });

    const got = await store.read({ workspaceId: ws }, "items", "a", Doc);
    expect.assert(got.ok === true);
    expect(got.data?.data).toEqual({ name: "foo", count: 1 });
  });

  it("preserves createdAt across overwrites", async () => {
    const store = new JetStreamDocumentStore(nc);
    const ws = `ws-${crypto.randomUUID()}`;
    const first = await store.write({ workspaceId: ws }, "t", "x", { name: "v1", count: 1 }, Doc);
    expect.assert(first.ok === true);
    const createdAt = first.data.createdAt;

    await new Promise((r) => setTimeout(r, 5));
    const second = await store.write({ workspaceId: ws }, "t", "x", { name: "v2", count: 2 }, Doc);
    expect.assert(second.ok === true);
    expect(second.data.createdAt).toBe(createdAt);
    expect(second.data.updatedAt).not.toBe(createdAt);
  });

  it("session-scoped reads are isolated from workspace scope", async () => {
    const store = new JetStreamDocumentStore(nc);
    const ws = `ws-${crypto.randomUUID()}`;
    await store.write({ workspaceId: ws }, "t", "x", { name: "ws", count: 1 }, Doc);
    await store.write(
      { workspaceId: ws, sessionId: "s1" },
      "t",
      "x",
      { name: "session", count: 2 },
      Doc,
    );

    const wsRead = await store.read({ workspaceId: ws }, "t", "x", Doc);
    const sessionRead = await store.read({ workspaceId: ws, sessionId: "s1" }, "t", "x", Doc);
    expect.assert(wsRead.ok === true);
    expect.assert(sessionRead.ok === true);
    expect(wsRead.data?.data.name).toBe("ws");
    expect(sessionRead.data?.data.name).toBe("session");
  });

  it("exists + delete + list", async () => {
    const store = new JetStreamDocumentStore(nc);
    const ws = `ws-${crypto.randomUUID()}`;
    await store.write({ workspaceId: ws }, "t", "a", { name: "a", count: 1 }, Doc);
    await store.write({ workspaceId: ws }, "t", "b", { name: "b", count: 2 }, Doc);

    expect(await store.exists({ workspaceId: ws }, "t", "a")).toBe(true);
    expect(await store.exists({ workspaceId: ws }, "t", "missing")).toBe(false);

    const ids = await store.list({ workspaceId: ws }, "t");
    expect(ids.sort()).toEqual(["a", "b"]);

    expect(await store.delete({ workspaceId: ws }, "t", "a")).toBe(true);
    expect(await store.delete({ workspaceId: ws }, "t", "a")).toBe(false);
    expect(await store.exists({ workspaceId: ws }, "t", "a")).toBe(false);
  });

  it("saveState / loadState round-trip", async () => {
    const store = new JetStreamDocumentStore(nc);
    const ws = `ws-${crypto.randomUUID()}`;
    const ok = await store.saveState({ workspaceId: ws }, "ckpt", { step: 7 });
    expect.assert(ok.ok === true);
    const got = await store.loadState({ workspaceId: ws }, "ckpt");
    expect.assert(got.ok === true);
    expect(got.data).toEqual({ step: 7 });
  });

  it("two workspaces with the same type/id do not leak", async () => {
    const store = new JetStreamDocumentStore(nc);
    const ws1 = `ws-${crypto.randomUUID()}`;
    const ws2 = `ws-${crypto.randomUUID()}`;
    await store.write({ workspaceId: ws1 }, "t", "x", { name: "a", count: 1 }, Doc);
    const got = await store.read({ workspaceId: ws2 }, "t", "x", Doc);
    expect.assert(got.ok === true);
    expect(got.data).toBeNull();
  });

  it("workspaceIds with unsafe chars are sanitized into a valid bucket name", async () => {
    const store = new JetStreamDocumentStore(nc);
    const ws = "user:test/with-unsafe@chars";
    const ok = await store.write({ workspaceId: ws }, "t", "x", { name: "ok", count: 1 }, Doc);
    expect.assert(ok.ok === true);
  });
});
