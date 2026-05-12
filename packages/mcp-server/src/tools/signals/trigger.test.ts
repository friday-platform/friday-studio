/**
 * Regression test for the MCP `workspace_signal_trigger` tool.
 *
 * Locks down the wiring that forwards `extra.signal` (fired by the MCP SDK
 * when the external client sends `notifications/cancelled`) into the
 * downstream `client.workspace[...].signals[...].$post` call's `init` bag.
 * Without this, a cancelled MCP request would let the daemon keep running
 * the spawned signal session.
 *
 * End-to-end cancel-frame propagation (init.signal abort → daemon
 * `onClientAbort` → `signals.cancel.<correlationId>` publish) is covered
 * in `apps/atlasd/routes/workspaces/index.test.ts` and the e2e suite in
 * task #26. This test isolates the mcp-server-side contract: the parent
 * `extra.signal` becomes the downstream `init.signal`.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ZodRawShape } from "zod";

const mockState = vi.hoisted(() => ({
  signalPost: vi.fn(),
  workspaceGet: vi.fn(),
  parseResult: vi.fn(),
}));

vi.mock("@atlas/client/v2", () => ({
  client: {
    workspace: new Proxy(
      {},
      {
        get: (_t, _wsKey) =>
          new Proxy(
            {},
            {
              get: (_t2, prop) => {
                if (prop === "$get") return mockState.workspaceGet;
                if (prop === "signals") {
                  return new Proxy(
                    {},
                    { get: () => ({ $post: mockState.signalPost }) },
                  );
                }
                return undefined;
              },
            },
          ),
      },
    ),
    artifactsStorage: { index: { $get: vi.fn() } },
  },
  parseResult: (...args: unknown[]) => mockState.parseResult(...args),
}));

import type { ToolContext } from "../types.ts";
import { registerSignalTriggerTool } from "./trigger.ts";

type HandlerArgs = {
  workspaceId: string;
  signalId: string;
  payload?: Record<string, unknown>;
  _sessionContext?: Record<string, unknown>;
};
type RegisteredHandler = (
  args: HandlerArgs,
  extra: { signal: AbortSignal },
) => Promise<CallToolResult>;

function makeCtx(): ToolContext {
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
  };
}

function captureHandler(): RegisteredHandler {
  let captured: RegisteredHandler | null = null;
  const server = {
    registerTool: (
      _name: string,
      _config: { inputSchema?: ZodRawShape },
      handler: RegisteredHandler,
    ) => {
      captured = handler;
    },
  };
  registerSignalTriggerTool(server as unknown as ToolContext["server"], makeCtx());
  if (!captured) throw new Error("registerTool was not called");
  return captured;
}

beforeEach(() => {
  mockState.signalPost.mockReset();
  mockState.workspaceGet.mockReset();
  mockState.parseResult.mockReset();
});

describe("workspace_signal_trigger — extra.signal forwarding", () => {
  it("forwards extra.signal as init.signal on the downstream $post", async () => {
    mockState.signalPost.mockResolvedValueOnce({ sessionId: "sess-1" });
    // First parseResult call is the workspace $get (validation path);
    // second is the trigger $post. The handler's catch-block treats both
    // throws and `{ok: false}` returns as transient — only the success
    // branch reaches the surface assertion below.
    mockState.parseResult
      .mockResolvedValueOnce({ ok: true, data: { config: { signals: {} } } })
      .mockResolvedValueOnce({ ok: true, data: { sessionId: "sess-1" } });

    const handler = captureHandler();
    const controller = new AbortController();

    const result = await handler(
      { workspaceId: "ws-1", signalId: "sig-1", payload: { foo: "bar" } },
      { signal: controller.signal },
    );

    // The contract this task adds: the second arg to $post carries the
    // parent extra.signal. A regression that drops this back to a single
    // arg (or undefined init) fails here loudly.
    expect(mockState.signalPost).toHaveBeenCalledWith(
      {
        param: { workspaceId: "ws-1", signalId: "sig-1" },
        json: { payload: { foo: "bar" } },
      },
      { init: { signal: controller.signal } },
    );
    expect(result.isError).toBeFalsy();
  });
});
