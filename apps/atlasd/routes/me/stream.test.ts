/**
 * Integration test for `/api/me/stream`. Covers the per-event authz
 * filter (workspace the user owns vs one they don't) and the
 * discriminated-union frame shape.
 *
 * Skips heartbeat timing — the interval is a guarded `setInterval`
 * that fires on its own clock; covering it would need fake timers
 * inside the SSE producer loop, which is more wiring than the
 * regression it protects.
 */

import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { Hono } from "hono";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext, AppVariables } from "../../src/factory.ts";
import { meStreamRoutes } from "./stream.ts";

interface WorkspaceLike {
  id: string;
  metadata?: { createdBy?: string };
}

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

const enc = new TextEncoder();

function makeApp(opts: { userId: string; workspaces: WorkspaceLike[] }): Hono<AppVariables> {
  const ctx = {
    daemon: { getNatsConnection: () => nc },
    getWorkspaceManager: () =>
      ({
        list: () => Promise.resolve(opts.workspaces),
      }) as unknown as AppContext["getWorkspaceManager"] extends () => infer R ? R : never,
  } as unknown as AppContext;

  return new Hono<AppVariables>()
    .use("*", async (c, next) => {
      c.set("app", ctx);
      c.set("userId", opts.userId);
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
  it("emits a tagged frame for an elicitation in an accessible workspace", async () => {
    const app = makeApp({
      userId: "user-A",
      workspaces: [{ id: "ws-mine", metadata: { createdBy: "user-A" } }],
    });

    const res = await app.request("/stream");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");

    // Publish AFTER subscribe-then-flush has completed inside the
    // handler. We rely on the controller having reached the for-await
    // loop by the time the test microtask yields — give it a beat.
    await new Promise((r) => setTimeout(r, 50));
    nc.publish(
      "elicitations.ws-mine.sess-1.elic-1",
      enc.encode(JSON.stringify({ id: "elic-1", workspaceId: "ws-mine", kind: "text" })),
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
    expect(parsed.workspaceId).toBe("ws-mine");
    expect(parsed.subject).toBe("elicitations.ws-mine.sess-1.elic-1");
    expect(parsed.payload).toMatchObject({ id: "elic-1", kind: "text" });
  });

  it("drops events from a workspace the user cannot access", async () => {
    const app = makeApp({
      userId: "user-A",
      workspaces: [{ id: "ws-mine", metadata: { createdBy: "user-A" } }],
    });

    const res = await app.request("/stream");
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));
    // Foreign workspace → must NOT reach the wire.
    nc.publish(
      "elicitations.ws-other.sess-1.elic-2",
      enc.encode(JSON.stringify({ id: "elic-2", workspaceId: "ws-other" })),
    );
    // Own workspace → MUST reach the wire. We use this to bound the
    // test instead of waiting for the timeout — once we see the own
    // frame, we know the daemon has finished processing the foreign
    // one too (Core NATS dispatches serially per subscription).
    nc.publish(
      "elicitations.ws-mine.sess-1.elic-3",
      enc.encode(JSON.stringify({ id: "elic-3", workspaceId: "ws-mine" })),
    );

    const frames = await collectFrames(res, (f) => f.length >= 1, 1500);
    expect(frames.length).toBe(1);
    const parsed = JSON.parse(frames[0] ?? "{}") as {
      kind?: string;
      workspaceId?: string;
      subject?: string;
      payload?: unknown;
    };
    expect(parsed.workspaceId).toBe("ws-mine");
  });

  it("emits instance events with no workspaceId scoping", async () => {
    const app = makeApp({ userId: "user-A", workspaces: [] });

    const res = await app.request("/stream");
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));
    nc.publish(
      "instance.cascade.queue_saturated",
      enc.encode(JSON.stringify({ type: "cascade.queue_saturated", at: "now" })),
    );

    const frames = await collectFrames(res, (f) => f.length >= 1, 1500);
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(frames[0] ?? "{}") as {
      kind?: string;
      workspaceId?: string;
      subject?: string;
      payload?: unknown;
    };
    expect(parsed.kind).toBe("instance");
    expect(parsed.workspaceId).toBeUndefined();
  });

  it("401s when no userId is set on the context", async () => {
    const ctx = {
      daemon: { getNatsConnection: () => nc },
      getWorkspaceManager: () =>
        ({
          list: () => Promise.resolve([]),
        }) as unknown as AppContext["getWorkspaceManager"] extends () => infer R ? R : never,
    } as unknown as AppContext;
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
