import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../types.ts";
import { registerChatSummarizeTool } from "./summarize.ts";

type Params = { workspace_id: string; chat_id: string; focus?: string };
type Handler = (params: Params) => Promise<CallToolResult>;

function captureHandler(): { handler: Handler; ctx: ToolContext } {
  let captured: Handler | undefined;
  const mockServer = {
    registerTool: vi.fn<(name: string, config: unknown, cb: Handler) => void>(
      (_name, _config, cb) => {
        captured = cb;
      },
    ),
  };
  const ctx: ToolContext = {
    daemonUrl: "http://localhost:8080",
    logger: {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn<(context: Record<string, unknown>) => ToolContext["logger"]>(),
    },
    server: mockServer as unknown as ToolContext["server"],
  };
  registerChatSummarizeTool(
    mockServer as unknown as Parameters<typeof registerChatSummarizeTool>[0],
    ctx,
  );
  if (!captured) throw new Error("registerChatSummarizeTool did not register a handler");
  return { handler: captured, ctx };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parseToolResult(result: CallToolResult): unknown {
  const block = result.content[0];
  if (!block || block.type !== "text") throw new Error("expected text content");
  return JSON.parse(block.text);
}

describe("registerChatSummarizeTool", () => {
  let handler: Handler;

  beforeEach(() => {
    handler = captureHandler().handler;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the summary payload on success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({
          summary: "Decisions: ship today.",
          messageCount: 42,
          modelId: "claude-haiku-4-5",
          generatedAt: "2026-05-22T00:00:00.000Z",
          cached: false,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await handler({ workspace_id: "ws-a", chat_id: "c1" });
    expect(result.isError).toBeFalsy();
    const data = parseToolResult(result) as {
      summary: string;
      messageCount: number;
      cached: boolean;
    };
    expect(data.summary).toContain("ship today");
    expect(data.messageCount).toBe(42);
    expect(data.cached).toBe(false);
  });

  it("flags cache hits via the cached field", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({
          summary: "from cache",
          messageCount: 4,
          modelId: "stub",
          generatedAt: "2026-05-20T00:00:00.000Z",
          cached: true,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await handler({ workspace_id: "ws-a", chat_id: "c1" });
    const data = parseToolResult(result) as { cached: boolean };
    expect(data.cached).toBe(true);
  });

  it("returns an error response when the daemon returns 503", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "Summarization failed" }, 503));
    vi.stubGlobal("fetch", fetchMock);

    const result = await handler({ workspace_id: "ws-a", chat_id: "c1" });
    expect(result.isError).toBe(true);
    const data = parseToolResult(result) as { error: string };
    expect(data.error).toBe("Failed to summarize chat");
  });
});
