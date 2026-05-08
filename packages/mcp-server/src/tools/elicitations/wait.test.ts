import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../types.ts";
import { waitForTerminalElicitation } from "./wait.ts";

const mockState = vi.hoisted(() => ({
  status: "pending" as "pending" | "answered",
  expireCalls: 0,
  reset() {
    this.status = "pending";
    this.expireCalls = 0;
  },
}));

vi.mock("@atlas/core/elicitations", () => ({
  ElicitationStorage: {
    get: () =>
      Promise.resolve({
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
      }),
    expirePending: () => {
      mockState.expireCalls++;
      return Promise.resolve({
        ok: true,
        data: { scanned: 0, expired: [], skipped: [], errors: 0 },
      });
    },
  },
}));

function makeCtxWithNats(): ToolContext {
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
        mockState.status = "answered";
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
});
