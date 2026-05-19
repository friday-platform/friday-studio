import { Buffer } from "node:buffer";
import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  awaitSignalCompletion,
  ensureSignalsStream,
  envelopeToWebhookContext,
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

  // Webhook envelope fields — closes the cross-layer plumbing gap that
  // only the live E2E catches today. Asserts that webhookBody (base64) +
  // webhookHeaders (lowercased dict) round-trip through publish → consumer
  // → SignalEnvelopeSchema.parse intact. If a schema field is renamed or
  // its optional-handling drifts (e.g. `body: undefined` vs missing key),
  // this test fails instead of letting the byte-for-byte invariant silently
  // break for HMAC-verifying agents.
  it("round-trips webhookBody + webhookHeaders through publishSignal → consumer", async () => {
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

    const githubBytes = `{"action":"opened","pull_request":{"number":42}}`;
    const githubBase64 = Buffer.from(githubBytes, "utf-8").toString("base64");
    const githubHeaders = {
      "x-github-event": "pull_request",
      "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      "x-hub-signature-256": "sha256=abc123deadbeef",
      "content-type": "application/json",
    };

    await publishSignal(nc, {
      workspaceId: "ws-webhook",
      signalId: "gh-pr-comment",
      payload: { action: "opened" },
      webhookBody: githubBase64,
      webhookHeaders: githubHeaders,
    });

    await waitFor(() => received.length === 1, 5000);
    await consumer.destroy();

    expect(received).toHaveLength(1);
    expect(received[0]?.webhookBody).toBe(githubBase64);
    expect(received[0]?.webhookHeaders).toEqual(githubHeaders);
    // The base64 → bytes round-trip preserves the exact upstream-signed
    // bytes — this is what makes the agent's HMAC verification possible.
    const decoded = Buffer.from(received[0]?.webhookBody ?? "", "base64").toString("utf-8");
    expect(decoded).toBe(githubBytes);
  }, 15_000);

  it("publishes an envelope WITHOUT webhook fields (non-webhook triggers)", async () => {
    // Locks the "webhook fields are webhook-only" contract: a CLI / cron /
    // chat-fired signal must not have webhookBody/webhookHeaders set on
    // the envelope — otherwise the agent's ctx.input.raw["body"] /
    // ["headers"] would be polluted by non-HTTP triggers.
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
      workspaceId: "ws-non-webhook",
      signalId: "cron-tick",
      payload: { tick: 1 },
    });
    await waitFor(() => received.length === 1, 5000);
    await consumer.destroy();

    expect(received[0]?.webhookBody).toBeUndefined();
    expect(received[0]?.webhookHeaders).toBeUndefined();
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

  it("breaks the in-flight batch iterator on stop(signal) — synchronous close path", async () => {
    // Without `currentBatch?.close()` in stop(), the for-await waits up to
    // `expiresMs` for the batch to fill naturally before the runLoop returns.
    const consumerName = `test-stop-abort-${crypto.randomUUID()}`;
    let handlerResolve: (() => void) | undefined;
    const handlerCalled = new Promise<void>((r) => {
      handlerResolve = r;
    });

    const consumer = new SignalConsumer(
      nc,
      () => {
        handlerResolve?.();
        return Promise.resolve();
      },
      { name: consumerName, expiresMs: 1000, batchSize: 16 },
    );
    await consumer.start();
    await publishSignal(nc, { workspaceId: "ws-stop-abort", signalId: "msg-1" });

    await handlerCalled;

    const controller = new AbortController();
    controller.abort();

    const start = Date.now();
    await consumer.stop(controller.signal);
    const elapsed = Date.now() - start;

    // 500ms bound: well above the ~50ms close path, below the 1000ms
    // expiresMs that would elapse if the iterator-close regressed.
    expect(elapsed).toBeLessThan(500);

    // SIGNALS isn't reset between tests in this file (unlike CASCADES);
    // delete the durable so the next test's consumer doesn't collide on
    // the workqueue stream.
    await consumer.destroy();
  }, 15_000);

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

describe("envelopeToWebhookContext", () => {
  // Pass-4 review #4. CascadeConsumer's dispatcher closure in
  // atlas-daemon.ts used to inline this mapping, which meant the only way
  // to verify it was a live JetStream+Hono+workspace E2E (CI-flaky and
  // slow). Extracting the helper lets us cover all four envelope shapes
  // in a pure unit test — and locks the runtime contract:
  //
  //   webhookContext.body === envelope.webhookBody (no transcoding)
  //   webhookContext.headers === envelope.webhookHeaders (no lower-casing,
  //     no rename) — the receiver layer already normalized them
  //
  // Returning `undefined` (not `{}`) for non-webhook envelopes is what
  // keeps `WorkspaceRuntimeSignal.body`/`.headers` undefined so the agent
  // SDK doesn't surface `ctx.input.raw["body"] === ""` for cron/CLI/chat
  // triggers.
  const baseEnvelope: SignalEnvelope = {
    workspaceId: "ws-1",
    signalId: "sig-1",
    payload: {},
    publishedAt: "2026-05-18T00:00:00Z",
  };

  it("returns undefined when neither webhookBody nor webhookHeaders is set", () => {
    expect(envelopeToWebhookContext(baseEnvelope)).toBeUndefined();
  });

  it("returns { body, headers } when both fields are set", () => {
    const body = Buffer.from(`{"action":"opened"}`, "utf-8").toString("base64");
    const headers = { "x-github-event": "pull_request", "x-hub-signature-256": "sha256=abc" };
    expect(
      envelopeToWebhookContext({ ...baseEnvelope, webhookBody: body, webhookHeaders: headers }),
    ).toEqual({ body, headers });
  });

  it("returns context with only body when only webhookBody is set", () => {
    const body = "ZGVhZGJlZWY=";
    const result = envelopeToWebhookContext({ ...baseEnvelope, webhookBody: body });
    expect(result).toEqual({ body, headers: undefined });
  });

  it("returns context with only headers when only webhookHeaders is set", () => {
    const headers = { "x-trace-id": "t1" };
    const result = envelopeToWebhookContext({ ...baseEnvelope, webhookHeaders: headers });
    expect(result).toEqual({ body: undefined, headers });
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
