import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../types.ts";
import { waitForTerminalElicitation } from "./wait.ts";

const mockState = vi.hoisted(() => ({
  status: "pending" as "pending" | "answered",
  expireCalls: 0,
  getCalls: 0,
  answerOnGetCall: undefined as number | undefined,
  missingUntilGetCall: 0,
  reset() {
    this.status = "pending";
    this.expireCalls = 0;
    this.getCalls = 0;
    this.answerOnGetCall = undefined;
    this.missingUntilGetCall = 0;
  },
}));

vi.mock("@atlas/core/elicitations", () => ({
  ElicitationStorage: {
    get: () => {
      mockState.getCalls++;
      if (mockState.getCalls <= mockState.missingUntilGetCall) {
        return Promise.resolve({ ok: true, data: null });
      }
      if (
        mockState.answerOnGetCall !== undefined &&
        mockState.getCalls >= mockState.answerOnGetCall
      ) {
        mockState.status = "answered";
      }
      return Promise.resolve({
        ok: true,
        data: {
          id: "elc-1",
          workspaceId: "ws-1",
          sessionId: "sess-1",
          kind: "open-question",
          question: "Proceed?",
          status: mockState.status,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          ...(mockState.status === "answered"
            ? { answer: { value: "yes", answeredAt: new Date().toISOString() } }
            : {}),
        },
      });
    },
    expirePending: () => {
      mockState.expireCalls++;
      return Promise.resolve({
        ok: true,
        data: { scanned: 0, expired: [], skipped: [], errors: 0 },
      });
    },
  },
}));

function makeCtxWithNats(
  options: { answerOnFlush?: boolean } = { answerOnFlush: true },
): ToolContext {
  const sub = {
    unsubscribe: vi.fn(),
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<{ data: Uint8Array }>>(() => {}),
    }),
  };
  return {
    daemonUrl: "http://localhost:8080",
    logger: {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(),
    } as unknown as ToolContext["logger"],
    server: {} as ToolContext["server"],
    natsConnection: {
      subscribe: vi.fn(() => sub),
      flush: vi.fn(() => {
        if (options.answerOnFlush) mockState.status = "answered";
        return Promise.resolve();
      }),
    } as unknown as ToolContext["natsConnection"],
  };
}

describe("waitForTerminalElicitation", () => {
  beforeEach(() => mockState.reset());

  it("re-reads status after subscribe flush so fast answers are not missed", async () => {
    const terminal = await waitForTerminalElicitation(makeCtxWithNats(), {
      id: "elc-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(terminal).toEqual({ status: "answered", value: "yes" });
    expect(mockState.expireCalls).toBe(0);
  });

  it("polls KV while subscribed so a missed stream publish does not wedge the waiter", async () => {
    mockState.answerOnGetCall = 2;
    const terminal = await waitForTerminalElicitation(makeCtxWithNats({ answerOnFlush: false }), {
      id: "elc-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
      expiresAt: new Date(Date.now() + 2_000).toISOString(),
    });

    expect(terminal).toEqual({ status: "answered", value: "yes" });
    expect(mockState.expireCalls).toBe(0);
  });

  it("keeps waiting when an initial KV read misses the elicitation", async () => {
    mockState.missingUntilGetCall = 1;
    mockState.answerOnGetCall = 3;

    const terminal = await waitForTerminalElicitation(makeCtxWithNats({ answerOnFlush: false }), {
      id: "elc-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
      expiresAt: new Date(Date.now() + 2_000).toISOString(),
    });

    expect(terminal).toEqual({ status: "answered", value: "yes" });
    expect(mockState.expireCalls).toBe(0);
  });

  it("rejects immediately with AbortError when signal is already aborted at entry", async () => {
    const controller = new AbortController();
    controller.abort();

    const ctx: ToolContext = {
      daemonUrl: "http://localhost:8080",
      logger: {
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(),
      } as unknown as ToolContext["logger"],
      server: {} as ToolContext["server"],
    };

    await expect(
      waitForTerminalElicitation(ctx, {
        id: "elc-1",
        workspaceId: "ws-1",
        sessionId: "sess-1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    // No NATS subscription or KV polling before the abort check.
    expect(mockState.getCalls).toBe(0);
    expect(mockState.expireCalls).toBe(0);
  });

  it("rejects with AbortError within one poll interval when signal aborts mid-wait", async () => {
    const controller = new AbortController();
    const ctx: ToolContext = {
      daemonUrl: "http://localhost:8080",
      logger: {
        trace: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        child: vi.fn(),
      } as unknown as ToolContext["logger"],
      server: {} as ToolContext["server"],
    };

    // Stays pending so the KV-only polling loop keeps spinning.
    mockState.status = "pending";

    const waitPromise = waitForTerminalElicitation(ctx, {
      id: "elc-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      signal: controller.signal,
    });

    // Abort after the first poll has started; the next poll iteration
    // checks signal.aborted within WAIT_POLL_MS (~250ms).
    const abortAt = Date.now() + 50;
    setTimeout(() => controller.abort(), 50);

    await expect(waitPromise).rejects.toMatchObject({ name: "AbortError" });

    // One poll interval is ~250ms; budget 750ms for CI jitter.
    expect(Date.now() - abortAt).toBeLessThan(750);
    // Sweeper must not run on abort — only on expiry.
    expect(mockState.expireCalls).toBe(0);
  });
});
