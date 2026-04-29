import type { Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpDependenciesTool } from "./mcp-dependencies.ts";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockFetch = vi.hoisted(() => vi.fn());

vi.mock("@atlas/client/v2", () => ({
  client: { workspaceMcp: () => ({ index: { $get: mockFetch } }) },
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

describe("createMcpDependenciesTool", () => {
  const logger = makeLogger();

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns object with get_mcp_dependencies key", () => {
    const tools = createMcpDependenciesTool("ws-1", logger);
    expect(tools).toHaveProperty("get_mcp_dependencies");
    expect(tools.get_mcp_dependencies).toBeDefined();
  });

  it("returns enabled and available partition on success", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          enabled: [
            {
              id: "github",
              name: "GitHub",
              source: "static",
              configured: true,
              agentIds: ["agent-1"],
            },
          ],
          available: [{ id: "slack", name: "Slack", source: "registry", configured: false }],
        }),
    });

    const tools = createMcpDependenciesTool("ws-1", logger);
    const result = await tools.get_mcp_dependencies!.execute!({}, TOOL_CALL_OPTS);

    expect(result).toEqual({
      enabled: [
        { id: "github", name: "GitHub", source: "static", configured: true, agentIds: ["agent-1"] },
      ],
      available: [{ id: "slack", name: "Slack", source: "registry", configured: false }],
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("returns error when endpoint returns non-ok", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ message: "Internal server error" }),
    });

    const tools = createMcpDependenciesTool("ws-1", logger);
    const result = await tools.get_mcp_dependencies!.execute!({}, TOOL_CALL_OPTS);

    expect(result).toEqual({ error: "Internal server error" });
  });

  it("returns error on unexpected response shape", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ unexpected: "shape" }),
    });

    const tools = createMcpDependenciesTool("ws-1", logger);
    const result = await tools.get_mcp_dependencies!.execute!({}, TOOL_CALL_OPTS);

    expect(result).toEqual({
      error: "Unexpected response shape from workspace MCP status endpoint.",
    });
  });

  it("returns error when fetch throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network failure"));

    const tools = createMcpDependenciesTool("ws-1", logger);
    const result = await tools.get_mcp_dependencies!.execute!({}, TOOL_CALL_OPTS);

    expect(result).toEqual({ error: "Failed to get MCP dependencies: Network failure" });
    expect(logger.warn).toHaveBeenCalledWith(
      "get_mcp_dependencies threw",
      expect.objectContaining({ workspaceId: "ws-1", error: "Network failure" }),
    );
  });
});
