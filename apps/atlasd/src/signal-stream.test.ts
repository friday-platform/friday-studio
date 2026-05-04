import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  awaitSignalCompletion,
  ensureSignalsStream,
  publishSignal,
  SignalConsumer,
  type SignalEnvelope,
  signalSubject,
} from "./signal-stream.ts";

let server: TestNatsServer;
let nc: NatsConnection;

beforeAll(async () => {
  server = await startNatsTestServer();
  nc = await connect({ servers: server.url });
  await ensureSignalsStream(nc);
}, 30_000);

afterAll(async () => {
  await nc.drain();
  await server.stop();
});

describe("signalSubject", () => {
  it("formats workspaceId/signalId into the canonical subject", () => {
    expect(signalSubject("ws-1", "do-the-thing")).toBe("workspaces.ws-1.signals.do-the-thing");
  });

  it("sanitizes unsafe chars to underscores", () => {
    expect(signalSubject("ws/with/slashes", "weird signal")).toBe(
      "workspaces.ws_with_slashes.signals.weird_signal",
    );
  });
});

describe("publishSignal + SignalConsumer", () => {
  it("publishes an envelope and the consumer dispatches it once", async () => {
    const received: SignalEnvelope[] = [];
    const consumer = new SignalConsumer(
      nc,
      (envelope) => {
        received.push(envelope);
        return Promise.resolve();
      },
      { name: `test-${crypto.randomUUID()}`, expiresMs: 1000 },
    );
    await consumer.start();

    await publishSignal(nc, {
      workspaceId: "ws-publish",
      signalId: "my-signal",
      payload: { hello: "world" },
    });

    await waitFor(() => received.length === 1, 5000);
    await consumer.destroy();

    expect(received).toHaveLength(1);
    expect(received[0]?.workspaceId).toBe("ws-publish");
    expect(received[0]?.signalId).toBe("my-signal");
    expect(received[0]?.payload).toEqual({ hello: "world" });
    expect(received[0]?.publishedAt).toBeDefined();
  });

  it("redelivers on dispatch failure up to maxDeliver, then dead-letters", async () => {
    let attempts = 0;
    const consumer = new SignalConsumer(
      nc,
      () => {
        attempts++;
        return Promise.reject(new Error("boom"));
      },
      { name: `test-${crypto.randomUUID()}`, expiresMs: 1000, maxDeliver: 3 },
    );
    await consumer.start();

    await publishSignal(nc, { workspaceId: "ws-redeliver", signalId: "fail-signal" });

    await waitFor(() => attempts >= 3, 10_000);
    await consumer.destroy();

    expect(attempts).toBeGreaterThanOrEqual(3);
  });

  it("dedups identical dedupId within the duplicate_window", async () => {
    const dispatched: string[] = [];
    const consumer = new SignalConsumer(
      nc,
      (env) => {
        dispatched.push(env.signalId);
        return Promise.resolve();
      },
      { name: `test-${crypto.randomUUID()}`, expiresMs: 1000 },
    );
    await consumer.start();

    const dedupId = `dedup-${crypto.randomUUID()}`;
    await publishSignal(nc, { workspaceId: "ws-dedup", signalId: "once", dedupId });
    await publishSignal(nc, { workspaceId: "ws-dedup", signalId: "once", dedupId });
    await publishSignal(nc, { workspaceId: "ws-dedup", signalId: "once", dedupId });

    await waitFor(() => dispatched.length >= 1, 3000);
    // Give the broker a moment to redeliver if dedup somehow misses.
    await new Promise((r) => setTimeout(r, 500));
    await consumer.destroy();

    expect(dispatched).toEqual(["once"]);
  });

  it("forwards onStreamEvent chunks to signals.stream.<correlationId>", async () => {
    const correlationId = crypto.randomUUID();
    const seenChunks: unknown[] = [];

    // Subscribe BEFORE publishing.
    const streamSub = nc.subscribe(`signals.stream.${correlationId}`);
    const reader = (async () => {
      for await (const msg of streamSub) {
        seenChunks.push(JSON.parse(new TextDecoder().decode(msg.data)));
        if (seenChunks.length >= 3) break;
      }
    })();

    const consumer = new SignalConsumer(
      nc,
      (_envelope, c) => {
        c.onStreamEvent?.({ type: "delta", text: "a" } as never);
        c.onStreamEvent?.({ type: "delta", text: "b" } as never);
        c.onStreamEvent?.({ type: "delta", text: "c" } as never);
        return Promise.resolve({ done: true });
      },
      { name: `test-${crypto.randomUUID()}`, expiresMs: 1000 },
    );
    await consumer.start();

    const responsePromise = awaitSignalCompletion(nc, correlationId, 5000);
    await publishSignal(nc, { workspaceId: "ws-stream", signalId: "stream-test", correlationId });
    const reply = await responsePromise;
    await reader;
    streamSub.unsubscribe();
    await consumer.destroy();

    expect(seenChunks).toHaveLength(3);
    expect(reply.ok).toBe(true);
  });

  it("publishes the dispatch result to the response subject for correlated requests", async () => {
    const consumer = new SignalConsumer(nc, (env) => Promise.resolve({ echoed: env.payload }), {
      name: `test-${crypto.randomUUID()}`,
      expiresMs: 1000,
    });
    await consumer.start();

    const correlationId = crypto.randomUUID();
    const responsePromise = awaitSignalCompletion(nc, correlationId, 5000);
    await publishSignal(nc, {
      workspaceId: "ws-correl",
      signalId: "ping",
      payload: { hello: "world" },
      correlationId,
    });
    const reply = await responsePromise;
    await consumer.destroy();

    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.result).toEqual({ echoed: { hello: "world" } });
    }
  });

  it("publishes ok=false to the response subject for a failing correlated request", async () => {
    const consumer = new SignalConsumer(nc, () => Promise.reject(new Error("dispatch boom")), {
      name: `test-${crypto.randomUUID()}`,
      expiresMs: 1000,
    });
    await consumer.start();

    const correlationId = crypto.randomUUID();
    const responsePromise = awaitSignalCompletion(nc, correlationId, 5000);
    await publishSignal(nc, { workspaceId: "ws-correl-fail", signalId: "fail", correlationId });
    const reply = await responsePromise;
    await consumer.destroy();

    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error).toContain("dispatch boom");
  });

  it("awaitSignalCompletion times out when the consumer never replies", async () => {
    const correlationId = crypto.randomUUID();
    await expect(awaitSignalCompletion(nc, correlationId, 200)).rejects.toThrow(/timeout/);
  });

  it("processes a burst of published signals in arrival order", async () => {
    const seen: string[] = [];
    const consumer = new SignalConsumer(
      nc,
      (env) => {
        seen.push(env.signalId);
        return Promise.resolve();
      },
      { name: `test-${crypto.randomUUID()}`, expiresMs: 1000 },
    );
    await consumer.start();

    for (let i = 0; i < 6; i++) {
      await publishSignal(nc, { workspaceId: "ws-burst", signalId: `s-${i}` });
    }

    await waitFor(() => seen.length === 6, 5000);
    await consumer.destroy();

    expect(seen).toEqual(["s-0", "s-1", "s-2", "s-3", "s-4", "s-5"]);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
