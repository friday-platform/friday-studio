import { NarrativeEntrySchema } from "@atlas/agent-sdk";
import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { Hono } from "hono";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { memoryNarrativeRoutes } from "./index.ts";

const EntryArraySchema = z.array(NarrativeEntrySchema);

let server: TestNatsServer;
let nc: NatsConnection;
let app: Hono;

beforeAll(async () => {
  server = await startNatsTestServer();
  nc = await connect({ servers: server.url });

  // Wrap memory routes in a tiny app that injects the bits of AppContext
  // these routes actually touch (daemon.getNatsConnection + exposeKernel +
  // getWorkspaceManager). This lets us test the route layer without
  // standing up the whole daemon.
  const minimalCtx = {
    exposeKernel: true,
    daemon: { getNatsConnection: () => nc },
    getWorkspaceManager: () => ({ getWorkspaceConfig: () => Promise.resolve(null) }),
  };

  app = new Hono();
  app.use("*", async (c, next) => {
    // Hono's typed Variables narrow `c.set` to specific keys; cast to any
    // here because this test uses a vanilla Hono instance without the
    // app's typed factory. The runtime behavior is identical.
    (c as unknown as { set: (key: string, value: unknown) => void }).set("app", minimalCtx);
    await next();
  });
  app.route("/", memoryNarrativeRoutes);
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await server.stop();
});

describe("GET /:workspaceId/narrative/:memoryName", () => {
  let workspaceId: string;

  beforeEach(() => {
    workspaceId = `ws-${crypto.randomUUID()}`;
  });

  it("returns 200 + NarrativeEntry[] for a populated store", async () => {
    await app.request(`/${workspaceId}/narrative/backlog`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "e1", text: "task one", createdAt: "2026-04-14T00:00:00Z" }),
    });

    const res = await app.request(`/${workspaceId}/narrative/backlog`);
    expect(res.status).toBe(200);

    const body = EntryArraySchema.parse(await res.json());
    expect(body).toHaveLength(1);
    expect(body[0]?.id).toBe("e1");
  });

  it("returns 200 + [] for nonexistent store", async () => {
    const res = await app.request(`/${workspaceId}/narrative/missing`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("forwards since and limit query params", async () => {
    for (const [id, createdAt, text] of [
      ["e1", "2026-04-14T00:00:00Z", "old"],
      ["e2", "2026-04-14T12:00:00Z", "new"],
    ] as const) {
      await app.request(`/${workspaceId}/narrative/backlog`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, text, createdAt }),
      });
    }

    const res = await app.request(
      `/${workspaceId}/narrative/backlog?since=2026-04-14T06:00:00Z&limit=10`,
    );
    const body = EntryArraySchema.parse(await res.json());
    expect(body).toHaveLength(1);
    expect(body[0]?.id).toBe("e2");
  });
});

describe("POST /:workspaceId/narrative/:memoryName", () => {
  it("appends entry with generated id and createdAt when only text provided", async () => {
    const wsId = `ws-${crypto.randomUUID()}`;
    const res = await app.request(`/${wsId}/narrative/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "remember this" }),
    });
    expect(res.status).toBe(200);

    const body = NarrativeEntrySchema.parse(await res.json());
    expect(body.text).toBe("remember this");
    expect(body.id.length).toBeGreaterThan(0);
    expect(body.createdAt.length).toBeGreaterThan(0);
  });

  it("preserves supplied id and createdAt", async () => {
    const wsId = `ws-${crypto.randomUUID()}`;
    const res = await app.request(`/${wsId}/narrative/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "custom-id",
        text: "explicit entry",
        createdAt: "2026-01-01T00:00:00Z",
      }),
    });
    expect(res.status).toBe(200);

    const body = NarrativeEntrySchema.parse(await res.json());
    expect(body.id).toBe("custom-id");
    expect(body.createdAt).toBe("2026-01-01T00:00:00Z");
  });

  it("returns 400 for invalid body (empty object)", async () => {
    const wsId = `ws-${crypto.randomUUID()}`;
    const res = await app.request(`/${wsId}/narrative/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /:workspaceId/narrative/:memoryName/:entryId", () => {
  it("returns 200 and tombstones the entry from subsequent reads", async () => {
    const wsId = `ws-${crypto.randomUUID()}`;
    for (const [id, text] of [
      ["e1", "hello"],
      ["e2", "keep me"],
    ] as const) {
      await app.request(`/${wsId}/narrative/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, text, createdAt: "2026-01-01T00:00:00Z" }),
      });
    }

    const del = await app.request(`/${wsId}/narrative/notes/e1`, { method: "DELETE" });
    expect(del.status).toBe(200);

    const getRes = await app.request(`/${wsId}/narrative/notes`);
    const body = EntryArraySchema.parse(await getRes.json());
    expect(body.map((e) => e.id)).toEqual(["e2"]);
  });

  it("returns 200 even when narrative does not exist yet", async () => {
    const wsId = `ws-${crypto.randomUUID()}`;
    const res = await app.request(`/${wsId}/narrative/notes/missing-id`, { method: "DELETE" });
    expect(res.status).toBe(200);
  });
});
