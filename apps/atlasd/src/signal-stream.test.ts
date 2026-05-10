import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  awaitSignalCompletion,
  ensureSignalsStream,
  publishSignal,
  SignalConsumer,
  type SignalEnvelope,
  signalResponseSubject,
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
  // SignalConsumer is now a thin forwarder: it parses the envelope, hands
  // it to the injected dispatcher (production wiring is `publishCascade`),
  // and acks. Cascade execution + per-signal concurrency policy + correlated
  // response/stream forwarding all live in CascadeConsumer
  // (cascade-stream.ts) — those tests live there.

  it("publishes an envelope and the consumer forwards it once", async () => {
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
  }, 15_000);

  it("redelivers on forward failure up to maxDeliver, then dead-letters", async () => {
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
  }, 20_000);

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
    await new Promise((r) => setTimeout(r, 500));
    await consumer.destroy();

    expect(dispatched).toEqual(["once"]);
  }, 15_000);

  it("awaitSignalCompletion times out when nobody publishes a response", async () => {
    const correlationId = crypto.randomUUID();
    await expect(awaitSignalCompletion(nc, correlationId, 200)).rejects.toThrow(/timeout/);
  });

  it("awaitSignalCompletion unsubscribes promptly when aborted", async () => {
    const correlationId = crypto.randomUUID();
    const unsubscribe = vi.fn();
    const pendingNext = new Promise<IteratorResult<unknown>>(() => {});
    const subscription = {
      unsubscribe,
      [Symbol.asyncIterator]: () => ({ next: () => pendingNext }),
    };
    const subscribe = vi.fn(() => subscription);
    const fakeNc = { subscribe } as unknown as NatsConnection;
    const controller = new AbortController();

    const responsePromise = awaitSignalCompletion(fakeNc, correlationId, 60_000, controller.signal);
    controller.abort();

    await expect(responsePromise).rejects.toThrow(/aborted/);
    expect(subscribe).toHaveBeenCalledWith(signalResponseSubject(correlationId), { max: 1 });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("forwards a burst of published signals in arrival order", async () => {
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
  }, 15_000);
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
