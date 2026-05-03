import { startNatsTestServer, type TestNatsServer } from "@atlas/core/test-utils/nats-test-server";
import { connect, type NatsConnection } from "nats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callTool, registerToolWorker, toolCallSubject } from "./tool-dispatch.ts";

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

const ctx = { workspaceId: "ws-test", sessionId: "sess-1", callerAgentId: "agent-x" };

describe("toolCallSubject", () => {
  it("formats toolId into the canonical subject", () => {
    expect(toolCallSubject("bash")).toBe("tools.bash.call");
  });

  it("sanitizes unsafe chars to underscores", () => {
    expect(toolCallSubject("google-gmail/send_message")).toBe(
      "tools.google-gmail_send_message.call",
    );
  });
});

describe("callTool + registerToolWorker", () => {
  it("round-trips a successful call", async () => {
    const worker = registerToolWorker(nc, "echo", (req) => Promise.resolve({ echoed: req.args }));
    try {
      const reply = await callTool(nc, "echo", { hello: "world" }, ctx);
      expect(reply.ok).toBe(true);
      if (reply.ok) {
        expect(reply.result).toEqual({ echoed: { hello: "world" } });
        expect(reply.durationMs).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await worker.stop();
    }
  });

  it("surfaces a worker exception as a structured error envelope", async () => {
    const worker = registerToolWorker(nc, "boom", () =>
      Promise.reject(new Error("intentional failure")),
    );
    try {
      const reply = await callTool(nc, "boom", null, ctx);
      expect(reply.ok).toBe(false);
      if (!reply.ok) {
        expect(reply.error.code).toBe("TOOL_ERROR");
        expect(reply.error.message).toContain("intentional failure");
      }
    } finally {
      await worker.stop();
    }
  });

  it("propagates a custom error code from the worker", async () => {
    const worker = registerToolWorker(nc, "rate-limited", () => {
      const err = new Error("over quota") as Error & { code: string };
      err.code = "RATE_LIMITED";
      return Promise.reject(err);
    });
    try {
      const reply = await callTool(nc, "rate-limited", {}, ctx);
      expect(reply.ok).toBe(false);
      if (!reply.ok) expect(reply.error.code).toBe("RATE_LIMITED");
    } finally {
      await worker.stop();
    }
  });

  it("times out when no worker handles the subject", async () => {
    await expect(
      callTool(nc, "nonexistent-tool", {}, { ...ctx, timeoutMs: 250 }),
    ).rejects.toThrow();
  });

  it("propagates caller abort to worker via cancel subject", async () => {
    let aborted = false;
    const worker = registerToolWorker(nc, "slow", async (_req, hctx) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 10_000);
        hctx.abortSignal.addEventListener("abort", () => {
          clearTimeout(t);
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
      return "should-not-arrive";
    });
    try {
      const controller = new AbortController();
      const callP = callTool(nc, "slow", {}, { ...ctx, abortSignal: controller.signal });
      await new Promise((r) => setTimeout(r, 100));
      controller.abort();
      await expect(callP).rejects.toThrow();
      // Give the cancel subject a tick to fire.
      await new Promise((r) => setTimeout(r, 100));
      expect(aborted).toBe(true);
    } finally {
      await worker.stop();
    }
  });

  it("queue groups the subject — at most one of N workers handles each call", async () => {
    let aCount = 0;
    let bCount = 0;
    const a = registerToolWorker(nc, "load-balanced", () => {
      aCount++;
      return Promise.resolve("from-a");
    });
    const b = registerToolWorker(nc, "load-balanced", () => {
      bCount++;
      return Promise.resolve("from-b");
    });
    try {
      // Wait for both queue-group subscriptions to be registered
      // server-side before dispatching, otherwise the broker can route
      // every message to whichever worker registered first.
      await Promise.all([a.ready, b.ready]);
      const replies = await Promise.all(
        Array.from({ length: 10 }, () => callTool(nc, "load-balanced", {}, ctx)),
      );
      const oks = replies.filter((r) => r.ok).length;
      expect(oks).toBe(10);
      expect(aCount + bCount).toBe(10);
      // Both workers should have processed at least one call (queue group
      // distributes; with 10 calls the odds of one worker getting all are
      // ~0.2% so this is essentially deterministic).
      expect(aCount).toBeGreaterThan(0);
      expect(bCount).toBeGreaterThan(0);
    } finally {
      await a.stop();
      await b.stop();
    }
  });
});
