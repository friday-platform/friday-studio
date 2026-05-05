import type { ConcurrencyPolicy } from "@atlas/config";
import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CascadeConsumer,
  cascadeSubject,
  ensureCascadesStream,
  publishCascade,
} from "./cascade-stream.ts";
import { ensureInstanceEventsStream, listInstanceEvents } from "./instance-events.ts";
import {
  awaitSignalCompletion,
  type SignalEnvelope,
  signalStreamSubject,
} from "./signal-stream.ts";

let server: TestNatsServer;
let nc: NatsConnection;

beforeAll(async () => {
  server = await startNatsTestServer();
  nc = await connect({ servers: server.url });
  await ensureInstanceEventsStream(nc);
}, 30_000);

beforeEach(async () => {
  // Tear down + recreate CASCADES so each test starts clean: no
  // leftover messages, no leftover durable consumers. WorkQueue
  // retention rejects multiple non-filtered consumers, so a fresh
  // stream per test is the simplest isolation strategy.
  const jsm = await nc.jetstreamManager();
  try {
    await jsm.streams.delete("CASCADES");
  } catch {
    // already gone
  }
  await ensureCascadesStream(nc);
});

afterAll(async () => {
  await nc.drain();
  await server.stop();
});

function envelope(
  workspaceId: string,
  signalId: string,
  extras: Partial<SignalEnvelope> = {},
): SignalEnvelope {
  return { workspaceId, signalId, publishedAt: new Date().toISOString(), ...extras };
}

describe("cascadeSubject", () => {
  it("formats workspaceId/signalId into the canonical subject", () => {
    expect(cascadeSubject("ws-1", "do-the-thing")).toBe("cascades.ws-1.do-the-thing");
  });
  it("sanitizes unsafe chars to underscores", () => {
    expect(cascadeSubject("ws/with/slashes", "weird signal")).toBe(
      "cascades.ws_with_slashes.weird_signal",
    );
  });
});

describe("CascadeConsumer concurrency policies", () => {
  it("default skip — drops a duplicate while a cascade is in-flight", async () => {
    let activeCount = 0;
    const dispatched: string[] = [];
    const consumer = new CascadeConsumer(
      nc,
      async (env) => {
        activeCount++;
        try {
          await new Promise((r) => setTimeout(r, 200));
          dispatched.push(env.signalId);
          return { sessionId: `s-${env.signalId}`, output: [] };
        } finally {
          activeCount--;
        }
      },
      () => Promise.resolve("skip" as ConcurrencyPolicy),
      { expiresMs: 1000 },
    );
    await consumer.start();

    await publishCascade(nc, envelope("ws", "tick"));
    await waitFor(() => activeCount === 1, 2000);
    await publishCascade(
      nc,
      envelope("ws", "tick", { publishedAt: new Date(Date.now() + 1).toISOString() }),
    );
    await new Promise((r) => setTimeout(r, 100));
    await waitFor(() => activeCount === 0 && dispatched.length === 1, 3000);
    await consumer.destroy();
    expect(dispatched).toEqual(["tick"]);
  });

  it("concurrent — runs duplicates in parallel and the registry tracks every one", async () => {
    // Regression: when the inFlight registry was a single-slot map per
    // key, `concurrent` dispatches for the same (workspace, signal)
    // overwrote each other in the slot. inFlight.size stayed at 1 even
    // with N actually-running cascades — saturation accounting
    // undercounted, the orphaned cascades' finally-block guard
    // (`get(key) === self`) failed so they never deregistered, and the
    // drained event could miss firing. Assert both the dispatcher
    // invocation count AND the registry's reported inFlight track the
    // real cardinality.
    let peak = 0;
    let active = 0;
    let registryPeak = 0;
    const consumer = new CascadeConsumer(
      nc,
      async (env) => {
        active++;
        peak = Math.max(peak, active);
        registryPeak = Math.max(registryPeak, consumer.getStats().inFlight);
        try {
          await new Promise((r) => setTimeout(r, 150));
          return { sessionId: `s-${env.signalId}`, output: [] };
        } finally {
          active--;
        }
      },
      () => Promise.resolve("concurrent" as ConcurrencyPolicy),
      { expiresMs: 1000 },
    );
    await consumer.start();

    for (let i = 0; i < 3; i++) {
      await publishCascade(
        nc,
        envelope("ws", "tick", { publishedAt: new Date(Date.now() + i).toISOString() }),
      );
    }
    await waitFor(() => peak >= 3, 3000);
    await waitFor(() => active === 0, 3000);
    expect(peak).toBe(3);
    expect(registryPeak).toBe(3);
    // Once everything settles, the registry must drain to zero — a
    // missed deregistration would leave a phantom in-flight count.
    expect(consumer.getStats().inFlight).toBe(0);
    await consumer.destroy();
  });

  it("queue — serializes per (workspace, signal)", async () => {
    const order: string[] = [];
    const consumer = new CascadeConsumer(
      nc,
      async (env) => {
        const tag = (env.payload as { tag: string }).tag;
        order.push(`start:${tag}`);
        await new Promise((r) => setTimeout(r, 100));
        order.push(`end:${tag}`);
        return { sessionId: `s-${env.signalId}`, output: [] };
      },
      () => Promise.resolve("queue" as ConcurrencyPolicy),
      { expiresMs: 1000 },
    );
    await consumer.start();

    for (const tag of ["a", "b", "c"]) {
      await publishCascade(
        nc,
        envelope("ws", "tick", {
          publishedAt: new Date(Date.now() + tag.charCodeAt(0)).toISOString(),
          payload: { tag },
        }),
      );
    }

    await waitFor(() => order.length === 6, 5000);
    await consumer.destroy();
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
  });

  it("replace — aborts in-flight on new envelope", async () => {
    const aborts: string[] = [];
    const completions: string[] = [];
    const consumer = new CascadeConsumer(
      nc,
      async (env, ctx) => {
        const tag = (env.payload as { tag: string }).tag;
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 800);
          ctx.abortSignal.addEventListener("abort", () => {
            clearTimeout(t);
            aborts.push(tag);
            reject(new Error("aborted"));
          });
        });
        completions.push(tag);
        return { sessionId: `s-${tag}`, output: [] };
      },
      () => Promise.resolve("replace" as ConcurrencyPolicy),
      { expiresMs: 1000 },
    );
    await consumer.start();

    await publishCascade(nc, envelope("ws", "tick", { payload: { tag: "first" } }));
    await new Promise((r) => setTimeout(r, 150));
    await publishCascade(
      nc,
      envelope("ws", "tick", {
        publishedAt: new Date(Date.now() + 1).toISOString(),
        payload: { tag: "second" },
      }),
    );

    await waitFor(() => completions.length === 1, 3000);
    await consumer.destroy();
    expect(aborts).toEqual(["first"]);
    expect(completions).toEqual(["second"]);
  });

  it("queue_timeout — terminates envelopes older than queueTimeoutMs", async () => {
    const dispatched: string[] = [];
    const consumer = new CascadeConsumer(
      nc,
      (env) => {
        dispatched.push(env.signalId);
        return Promise.resolve({ sessionId: `s-${env.signalId}`, output: [] });
      },
      () => Promise.resolve("skip" as ConcurrencyPolicy),
      { expiresMs: 1000, queueTimeoutMs: 50 },
    );
    await consumer.start();
    await publishCascade(
      nc,
      envelope("ws", "tick", { publishedAt: new Date(Date.now() - 5000).toISOString() }),
    );
    await new Promise((r) => setTimeout(r, 500));
    await consumer.destroy();
    expect(dispatched).toEqual([]);
    const events = await listInstanceEvents(nc, { typeFilter: "cascade.queue_timeout" });
    expect(events.some((e) => e.type === "cascade.queue_timeout")).toBe(true);
  });
});

describe("CascadeConsumer correlated callers", () => {
  it("publishes ok=true on signals.responses.<corrId> for a successful cascade", async () => {
    const consumer = new CascadeConsumer(
      nc,
      (env) => Promise.resolve({ sessionId: `s-${env.signalId}`, output: [] }),
      () => Promise.resolve("concurrent" as ConcurrencyPolicy),
      { expiresMs: 1000 },
    );
    await consumer.start();

    const correlationId = crypto.randomUUID();
    const responsePromise = awaitSignalCompletion(nc, correlationId, 5000);
    await publishCascade(nc, envelope("ws", "ping", { correlationId }));
    const reply = await responsePromise;
    await consumer.destroy();
    expect(reply.ok).toBe(true);
  });

  it("publishes ok=false on a skipped duplicate so HTTP callers don't hang", async () => {
    const consumer = new CascadeConsumer(
      nc,
      async (env) => {
        await new Promise((r) => setTimeout(r, 200));
        return { sessionId: `s-${env.signalId}`, output: [] };
      },
      () => Promise.resolve("skip" as ConcurrencyPolicy),
      { expiresMs: 1000 },
    );
    await consumer.start();

    await publishCascade(nc, envelope("ws", "ping"));
    await new Promise((r) => setTimeout(r, 50));

    const correlationId = crypto.randomUUID();
    const responsePromise = awaitSignalCompletion(nc, correlationId, 2000);
    await publishCascade(
      nc,
      envelope("ws", "ping", {
        correlationId,
        publishedAt: new Date(Date.now() + 1).toISOString(),
      }),
    );
    const reply = await responsePromise;
    await consumer.destroy();
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error).toContain("skipped-duplicate");
  });

  it("forwards onStreamEvent chunks to signals.stream.<corrId>", async () => {
    const correlationId = crypto.randomUUID();
    const seenChunks: unknown[] = [];
    const sub = nc.subscribe(signalStreamSubject(correlationId));
    const reader = (async () => {
      for await (const msg of sub) {
        seenChunks.push(JSON.parse(new TextDecoder().decode(msg.data)));
        if (seenChunks.length >= 3) break;
      }
    })();

    const consumer = new CascadeConsumer(
      nc,
      (_env, ctx) => {
        ctx.onStreamEvent?.({ type: "delta", text: "a" } as never);
        ctx.onStreamEvent?.({ type: "delta", text: "b" } as never);
        ctx.onStreamEvent?.({ type: "delta", text: "c" } as never);
        return Promise.resolve({ sessionId: "s-stream", output: [] });
      },
      () => Promise.resolve("concurrent" as ConcurrencyPolicy),
      { expiresMs: 1000 },
    );
    await consumer.start();

    const responsePromise = awaitSignalCompletion(nc, correlationId, 5000);
    await publishCascade(nc, envelope("ws", "stream-test", { correlationId }));
    const reply = await responsePromise;
    await reader;
    sub.unsubscribe();
    await consumer.destroy();

    expect(seenChunks).toHaveLength(3);
    expect(reply.ok).toBe(true);
  });
});

describe("CascadeConsumer head-of-line decoupling", () => {
  it("a slow cascade on workspace A does NOT block workspace B", async () => {
    const finishedAt = new Map<string, number>();
    const consumer = new CascadeConsumer(
      nc,
      async (env) => {
        const key = `${env.workspaceId}:${env.signalId}`;
        const slow = env.workspaceId === "slow";
        await new Promise((r) => setTimeout(r, slow ? 1500 : 5));
        finishedAt.set(key, Date.now());
        return { sessionId: `s-${key}`, output: [] };
      },
      () => Promise.resolve("concurrent" as ConcurrencyPolicy),
      { expiresMs: 1000 },
    );
    await consumer.start();

    const t0 = Date.now();
    await publishCascade(nc, envelope("slow", "tick"));
    await new Promise((r) => setTimeout(r, 50));
    await publishCascade(
      nc,
      envelope("fast", "tick", { publishedAt: new Date(Date.now() + 1).toISOString() }),
    );

    await waitFor(() => finishedAt.has("fast:tick"), 1000);
    const fastFinished = finishedAt.get("fast:tick") as number;
    await consumer.destroy();

    // Without decoupling, fast had to wait ~1500ms for slow first.
    // With decoupling, fast finishes within ~200ms of t0.
    const fastLatency = fastFinished - t0;
    expect(fastLatency).toBeLessThan(500);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
