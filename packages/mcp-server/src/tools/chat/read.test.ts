import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../types.ts";
import { registerChatReadTool } from "./read.ts";

type ReadChatParams = { workspace_id: string; chat_id: string; limit?: number };
type ReadChatHandler = (params: ReadChatParams) => Promise<CallToolResult>;

function captureHandler(): { handler: ReadChatHandler; ctx: ToolContext } {
  let captured: ReadChatHandler | undefined;
  const mockServer = {
    registerTool: vi.fn<(name: string, config: unknown, cb: ReadChatHandler) => void>(
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
  registerChatReadTool(mockServer as unknown as Parameters<typeof registerChatReadTool>[0], ctx);
  if (!captured) throw new Error("registerChatReadTool did not register a handler");
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

describe("registerChatReadTool", () => {
  let handler: ReadChatHandler;

  beforeEach(() => {
    handler = captureHandler().handler;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the chat title and messages on success", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        chat: { id: "c1", title: "Research notes", workspaceId: "ws-a", userId: "u" },
        messages: [
          { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
          { id: "m2", role: "assistant", parts: [{ type: "text", text: "hi" }] },
        ],
        systemPromptContext: null,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await handler({ workspace_id: "ws-a", chat_id: "c1" });
    expect(result.isError).toBeFalsy();
    const data = parseToolResult(result) as {
      chat: { id: string; title: string; workspaceId: string };
      messages: unknown[];
      count: number;
      truncated: boolean;
    };
    expect(data.chat).toEqual({ id: "c1", title: "Research notes", workspaceId: "ws-a" });
    expect(data.count).toBe(2);
    expect(data.truncated).toBe(false);
  });

  it("truncates to the requested limit (most recent kept)", async () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: `msg-${i}` }],
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({
          chat: { id: "c1", title: null, workspaceId: "ws-a", userId: "u" },
          messages,
          systemPromptContext: null,
          totalMessageCount: 5,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await handler({ workspace_id: "ws-a", chat_id: "c1", limit: 2 });
    const data = parseToolResult(result) as {
      messages: Array<{ id: string }>;
      count: number;
      truncated: boolean;
    };
    expect(data.count).toBe(2);
    expect(data.truncated).toBe(true);
    expect(data.messages.map((m) => m.id)).toEqual(["m3", "m4"]);
  });

  it("reports truncated when the route's slice undercounts the source chat (friday-studio-ns4)", async () => {
    // 5000-message chat; route trimmed to last 100; tool keeps all 100.
    // Without totalMessageCount the tool would conclude 100 > 100 → false.
    const last100 = Array.from({ length: 100 }, (_, i) => ({
      id: `m${4900 + i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: `msg-${4900 + i}` }],
    }));
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({
          chat: { id: "c1", title: null, workspaceId: "ws-a", userId: "u" },
          messages: last100,
          systemPromptContext: null,
          totalMessageCount: 5000,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await handler({ workspace_id: "ws-a", chat_id: "c1" });
    const data = parseToolResult(result) as {
      count: number;
      truncated: boolean;
      totalMessageCount: number;
    };
    expect(data.count).toBe(100);
    expect(data.totalMessageCount).toBe(5000);
    expect(data.truncated).toBe(true);
  });

  it("returns an error response when the chat is not found", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "Chat not found" }, 404));
    vi.stubGlobal("fetch", fetchMock);

    const result = await handler({ workspace_id: "ws-a", chat_id: "missing" });
    expect(result.isError).toBe(true);
    const data = parseToolResult(result) as { error: string };
    expect(data.error).toBe("Failed to read chat");
  });
});
