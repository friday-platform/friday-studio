/**
 * Integration test for `/api/me/stream`. Covers the per-event authz
 * filter (workspaces the user is a member of vs ones they aren't),
 * the discriminated-union frame shape, and live membership updates
 * propagating via the WORKSPACE_MEMBERS KV watch.
 *
 * Skips heartbeat timing — the interval is a guarded `setInterval`
 * that fires on its own clock; covering it would need fake timers
 * inside the SSE producer loop, which is more wiring than the
 * regression it protects.
 */

import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import {
  ensureWorkspaceMembersKVBucket,
  initWorkspaceMemberStorage,
  resetWorkspaceMemberStorageForTests,
  WorkspaceMemberStorage,
} from "@atlas/core/workspace-members/storage";
import { Hono } from "hono";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext, AppVariables } from "../../src/factory.ts";
import { meStreamRoutes } from "./stream.ts";

let server: TestNatsServer;
let nc: NatsConnection;

beforeAll(async () => {
  server = await startNatsTestServer();
  nc = await connect({ servers: server.url });
  initWorkspaceMemberStorage(nc);
  await ensureWorkspaceMembersKVBucket(nc);
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await server.stop();
  resetWorkspaceMemberStorageForTests();
});

const enc = new TextEncoder();

/** Distinct userId per test so KV state doesn't bleed across cases. */
const uid = () => `u_${crypto.randomUUID().slice(0, 8)}`;

async function grantMembership(userId: string, wsId: string): Promise<void> {
  const res = await WorkspaceMemberStorage.put({
    userId,
    wsId,
    role: "owner",
    addedAt: new Date().toISOString(),
  });
  if (!res.ok) throw new Error(`grantMembership failed: ${res.error}`);
}

function makeApp(userId: string): Hono<AppVariables> {
  const ctx = { daemon: { getNatsConnection: () => nc } } as unknown as AppContext;

  return new Hono<AppVariables>()
    .use("*", async (c, next) => {
      c.set("app", ctx);
      c.set("userId", userId);
      await next();
    })
    .route("/", meStreamRoutes);
}

/**
 * Read SSE frames from the response body until `predicate` returns
 * true or `timeoutMs` elapses. Returns the collected `data:` payloads
 * (one entry per frame, comment-prefix lines stripped).
 */
async function collectFrames(
  res: Response,
  predicate: (frames: string[]) => boolean,
  timeoutMs = 2000,
): Promise<string[]> {
  if (!res.body) throw new Error("no body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const frames: string[] = [];
  let buf = "";
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const readPromise = reader.read();
    const result = await Promise.race([
      readPromise,
      new Promise<{ value: undefined; done: true } | undefined>((resolve) =>
        setTimeout(() => resolve(undefined), remaining),
      ),
    ]);
    if (!result) break;
    if (result.done) break;
    buf += decoder.decode(result.value as Uint8Array, { stream: true });
    const lines = buf.split("\n\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data: ")) frames.push(line.slice(6));
    }
    if (predicate(frames)) break;
  }
  await reader.cancel();
  return frames;
}

describe("GET /api/me/stream", () => {
  it("emits a tagged frame for an elicitation in a workspace the user is a member of", async () => {
    const userId = uid();
    const wsId = `ws_${crypto.randomUUID().slice(0, 8)}`;
    await grantMembership(userId, wsId);

    const app = makeApp(userId);
    const res = await app.request("/stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    // Publish AFTER subscribe-then-flush has completed inside the
    // handler. We rely on the controller having reached the for-await
    // loop by the time the test microtask yields — give it a beat.
    await new Promise((r) => setTimeout(r, 50));
    nc.publish(
      `elicitations.${wsId}.sess-1.elic-1`,
      enc.encode(JSON.stringify({ id: "elic-1", workspaceId: wsId, kind: "text" })),
    );

    const frames = await collectFrames(res, (f) => f.length >= 1, 1500);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(frames[0] ?? "{}") as {
      kind?: string;
      workspaceId?: string;
      subject?: string;
      payload?: unknown;
    };
    expect(parsed.kind).toBe("elicitation");
    expect(parsed.workspaceId).toBe(wsId);
    expect(parsed.subject).toBe(`elicitations.${wsId}.sess-1.elic-1`);
    expect(parsed.payload).toMatchObject({ id: "elic-1", kind: "text" });
  });

  it("drops events from a workspace the user is not a member of", async () => {
    const userId = uid();
    const mine = `ws_${crypto.randomUUID().slice(0, 8)}`;
    const foreign = `ws_${crypto.randomUUID().slice(0, 8)}`;
    await grantMembership(userId, mine);

    const app = makeApp(userId);
    const res = await app.request("/stream");
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));
    // Foreign workspace → must NOT reach the wire.
    nc.publish(
      `elicitations.${foreign}.sess-1.elic-2`,
      enc.encode(JSON.stringify({ id: "elic-2", workspaceId: foreign })),
    );
    // Own workspace → MUST reach the wire. We use this to bound the
    // test instead of waiting for the timeout — once we see the own
    // frame, the daemon has dispatched the foreign one too (Core
    // NATS serializes per-subscription delivery).
    nc.publish(
      `elicitations.${mine}.sess-1.elic-3`,
      enc.encode(JSON.stringify({ id: "elic-3", workspaceId: mine })),
    );

    const frames = await collectFrames(res, (f) => f.length >= 1, 1500);
    expect(frames.length).toBe(1);
    const parsed = JSON.parse(frames[0] ?? "{}") as { workspaceId?: string };
    expect(parsed.workspaceId).toBe(mine);
  });

  it("propagates a newly-stamped membership row live (no reconnect)", async () => {
    const userId = uid();
    const futureWs = `ws_${crypto.randomUUID().slice(0, 8)}`;
    // No initial membership — the user starts with an empty set.

    const app = makeApp(userId);
    const res = await app.request("/stream");
    expect(res.status).toBe(200);

    // Let the handshake settle.
    await new Promise((r) => setTimeout(r, 50));

    // An event published before membership lands MUST be dropped.
    nc.publish(
      `elicitations.${futureWs}.sess-pre.elic-pre`,
      enc.encode(JSON.stringify({ id: "elic-pre" })),
    );

    // Grant membership while the stream is open.
    await grantMembership(userId, futureWs);

    // Give the KV watch a moment to deliver the PUT into the
    // accessible set.
    await new Promise((r) => setTimeout(r, 150));

    nc.publish(
      `elicitations.${futureWs}.sess-post.elic-post`,
      enc.encode(JSON.stringify({ id: "elic-post" })),
    );

    const frames = await collectFrames(res, (f) => f.length >= 1, 2000);
    expect(frames.length).toBe(1);
    const parsed = JSON.parse(frames[0] ?? "{}") as { payload?: { id?: string } };
    expect(parsed.payload?.id).toBe("elic-post");
  });

  it("emits instance events with no workspaceId scoping", async () => {
    const app = makeApp(uid());
    const res = await app.request("/stream");
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));
    nc.publish(
      "instance.cascade.queue_saturated",
      enc.encode(JSON.stringify({ type: "cascade.queue_saturated", at: "now" })),
    );

    const frames = await collectFrames(res, (f) => f.length >= 1, 1500);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(frames[0] ?? "{}") as { kind?: string; workspaceId?: string };
    expect(parsed.kind).toBe("instance");
    expect(parsed.workspaceId).toBeUndefined();
  });

  it("401s when no userId is set on the context", async () => {
    const ctx = { daemon: { getNatsConnection: () => nc } } as unknown as AppContext;
    const app = new Hono<AppVariables>()
      .use("*", async (c, next) => {
        c.set("app", ctx);
        await next();
      })
      .route("/", meStreamRoutes);

    const res = await app.request("/stream");
    expect(res.status).toBe(401);
  });
});
