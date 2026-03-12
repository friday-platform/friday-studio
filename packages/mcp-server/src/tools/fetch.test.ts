import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerFetchTool } from "./fetch.ts";
import type { ToolContext } from "./types.ts";

/**
 * Captures the tool handler registered by `registerFetchTool` so we can invoke
 * it directly in tests without a real MCP server.
 */
type FetchParams = { url: string; format: "text" | "markdown" | "html"; timeout?: number };
type FetchHandler = (params: FetchParams) => Promise<CallToolResult>;

function captureFetchHandler(): { handler: FetchHandler; ctx: ToolContext } {
  let captured: FetchHandler | undefined;

  const mockServer = {
    registerTool: vi.fn<(name: string, config: unknown, cb: FetchHandler) => void>(
      (_name, _config, cb) => {
        captured = cb;
      },
    ),
  };

  const ctx: ToolContext = {
    daemonUrl: "http://localhost:8080",
    logger: {
      trace: vi.fn<(msg: string, context?: Record<string, unknown>) => void>(),
      debug: vi.fn<(msg: string, context?: Record<string, unknown>) => void>(),
      info: vi.fn<(msg: string, context?: Record<string, unknown>) => void>(),
      warn: vi.fn<(msg: string, context?: Record<string, unknown>) => void>(),
      error: vi.fn<(msg: string, context?: Record<string, unknown>) => void>(),
      fatal: vi.fn<(msg: string, context?: Record<string, unknown>) => void>(),
      child: vi.fn<(context: Record<string, unknown>) => ToolContext["logger"]>(),
    },
    // registerTool only reads `server` from the first arg, not from ctx
    server: mockServer as unknown as ToolContext["server"],
  };

  registerFetchTool(mockServer as unknown as Parameters<typeof registerFetchTool>[0], ctx);

  if (!captured) {
    throw new Error("registerFetchTool did not register a tool handler");
  }

  return { handler: captured, ctx };
}

describe("registerFetchTool error handling", () => {
  let handler: FetchHandler;
  let ctx: ToolContext;

  beforeEach(() => {
    const captured = captureFetchHandler();
    handler = captured.handler;
    ctx = captured.ctx;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns a clean error response for AbortError without logging", async () => {
    const abortError = new DOMException("The operation was aborted", "AbortError");
    vi.stubGlobal(
      "fetch",
      vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockRejectedValue(abortError),
    );

    const result = await handler({ url: "https://example.com", format: "markdown" });

    expect(result.isError).toBe(true);
    const text = result.content[0];
    expect(text).toBeDefined();
    if (text?.type === "text") {
      const parsed: unknown = JSON.parse(text.text);
      expect(parsed).toEqual({ error: "Request was aborted (timeout or cancellation)" });
    } else {
      throw new Error("Expected text content");
    }

    // AbortError must NOT trigger logger.error
    expect(ctx.logger.error).not.toHaveBeenCalled();
  });

  it("logs and returns a generic error response for non-AbortError exceptions", async () => {
    const networkError = new Error("ECONNREFUSED");
    vi.stubGlobal(
      "fetch",
      vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockRejectedValue(networkError),
    );

    const result = await handler({ url: "https://example.com", format: "text" });

    expect(result.isError).toBe(true);
    const text = result.content[0];
    expect(text).toBeDefined();
    if (text?.type === "text") {
      const parsed: unknown = JSON.parse(text.text);
      expect(parsed).toEqual({ error: "webfetch tool error: ECONNREFUSED" });
    } else {
      throw new Error("Expected text content");
    }

    // Non-AbortError should trigger logger.error
    expect(ctx.logger.error).toHaveBeenCalledOnce();
    expect(ctx.logger.error).toHaveBeenCalledWith("webfetch tool error", {
      error: networkError,
      params: { url: "https://example.com", format: "text" },
    });
  });

  it("treats a DOMException with a non-AbortError name as a regular error", async () => {
    const domError = new DOMException("something broke", "NotAllowedError");
    vi.stubGlobal(
      "fetch",
      vi
        .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
        .mockRejectedValue(domError),
    );

    const result = await handler({ url: "https://example.com", format: "html" });

    expect(result.isError).toBe(true);
    const text = result.content[0];
    expect(text).toBeDefined();
    if (text?.type === "text") {
      const parsed: unknown = JSON.parse(text.text);
      expect(parsed).toEqual({ error: "webfetch tool error: something broke" });
    } else {
      throw new Error("Expected text content");
    }

    // Non-AbortError DOMException should still log
    expect(ctx.logger.error).toHaveBeenCalledOnce();
  });
});
