import type { Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createListMcpToolsTool } from "./list-mcp-tools.ts";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockGet = vi.hoisted(() => vi.fn());

vi.mock("@atlas/client/v2", () => ({
  client: { mcpRegistry: { ":id": { tools: { $get: mockGet } } } },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  } satisfies Record<keyof Logger, unknown>;
}

const TOOL_CALL_OPTS = {
  toolCallId: "tc-1",
  messages: [] as never[],
  abortSignal: new AbortController().signal,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createListMcpToolsTool", () => {
  const logger = makeLogger();

  beforeEach(() => {
    mockGet.mockReset();
  });

  it("returns object with list_mcp_tools key", () => {
    const tools = createListMcpToolsTool(logger);
    expect(tools).toHaveProperty("list_mcp_tools");
    expect(tools.list_mcp_tools).toBeDefined();
  });

  it("returns success on 200 with tools array", async () => {
    mockGet.mockResolvedValueOnce({
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          tools: [
            { name: "gmail_list_messages", description: "List Gmail messages" },
            { name: "gmail_get_message", description: "Get a Gmail message" },
          ],
        }),
    });

    const tools = createListMcpToolsTool(logger);
    const result = await tools.list_mcp_tools!.execute(
      { serverId: "google-gmail" },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({
      ok: true,
      tools: [
        { name: "google-gmail/gmail_list_messages", description: "List Gmail messages" },
        { name: "google-gmail/gmail_get_message", description: "Get a Gmail message" },
      ],
    });
    expect(mockGet).toHaveBeenCalledWith({ param: { id: "google-gmail" } });
    expect(logger.info).toHaveBeenCalledWith(
      "list_mcp_tools succeeded",
      expect.objectContaining({ serverId: "google-gmail", toolCount: 2 }),
    );
  });

  it("returns success on 200 with empty tools array", async () => {
    mockGet.mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({ ok: true, tools: [] }),
    });

    const tools = createListMcpToolsTool(logger);
    const result = await tools.list_mcp_tools!.execute(
      { serverId: "minimal-server" },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({ ok: true, tools: [] });
  });

  it("returns error on unexpected success shape", async () => {
    mockGet.mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({ ok: true, tools: "not-an-array" }),
    });

    const tools = createListMcpToolsTool(logger);
    const result = await tools.list_mcp_tools!.execute(
      { serverId: "google-gmail" },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({
      ok: false,
      error: "Unexpected response shape from MCP registry",
      phase: "tools",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "list_mcp_tools: unexpected success shape",
      expect.objectContaining({ serverId: "google-gmail" }),
    );
  });

  it("returns error on 404", async () => {
    mockGet.mockResolvedValueOnce({
      status: 404,
      json: () => Promise.resolve({ error: "not found" }),
    });

    const tools = createListMcpToolsTool(logger);
    const result = await tools.list_mcp_tools!.execute(
      { serverId: "nonexistent" },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({
      ok: false,
      error: 'MCP server "nonexistent" not found in catalog. Use search_mcp_servers or list_mcp_servers to find valid IDs.',
      phase: "connect",
    });
  });

  it("returns error on non-200 with error body", async () => {
    mockGet.mockResolvedValueOnce({
      status: 500,
      json: () => Promise.resolve({ error: "Registry timeout" }),
    });

    const tools = createListMcpToolsTool(logger);
    const result = await tools.list_mcp_tools!.execute(
      { serverId: "google-gmail" },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({
      ok: false,
      error: "Registry timeout",
      phase: "tools",
    });
  });

  it("returns error when fetch throws", async () => {
    mockGet.mockRejectedValueOnce(new Error("Network failure"));

    const tools = createListMcpToolsTool(logger);
    const result = await tools.list_mcp_tools!.execute(
      { serverId: "google-gmail" },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({
      ok: false,
      error: "Probe failed: Network failure",
      phase: "tools",
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "list_mcp_tools threw",
      expect.objectContaining({
        serverId: "google-gmail",
        error: "Network failure",
      }),
    );
  });
});
