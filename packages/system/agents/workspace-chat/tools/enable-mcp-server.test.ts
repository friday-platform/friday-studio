import type { Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEnableMcpServerTool } from "./enable-mcp-server.ts";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockPut = vi.hoisted(() => vi.fn());
const mockWorkspaceMcp = vi.hoisted(() => vi.fn());

vi.mock("@atlas/client/v2", () => ({
  client: { workspaceMcp: mockWorkspaceMcp },
}));

function setupMock(workspaceId: string) {
  mockWorkspaceMcp.mockReturnValue({
    ":serverId": { $put: mockPut },
  });
}

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

describe("createEnableMcpServerTool", () => {
  const logger = makeLogger();

  beforeEach(() => {
    mockPut.mockReset();
    mockWorkspaceMcp.mockReset();
  });

  it("returns object with enable_mcp_server key", () => {
    const tools = createEnableMcpServerTool("ws-1", logger);
    expect(tools).toHaveProperty("enable_mcp_server");
    expect(tools.enable_mcp_server).toBeDefined();
  });

  it("returns success on 200 with server info", async () => {
    setupMock("ws-1");
    mockPut.mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({ server: { id: "github", name: "GitHub" } }),
    });

    const tools = createEnableMcpServerTool("ws-1", logger);
    const result = await tools.enable_mcp_server!.execute({ serverId: "github" }, TOOL_CALL_OPTS);

    expect(result).toEqual({
      success: true,
      server: { id: "github", name: "GitHub" },
      message: "MCP server 'GitHub' is now enabled in this workspace.",
    });
    expect(mockWorkspaceMcp).toHaveBeenCalledWith("ws-1");
    expect(mockPut).toHaveBeenCalledWith({ param: { serverId: "github" } });
  });

  it("returns success on 200 without server info fallback", async () => {
    setupMock("ws-1");
    mockPut.mockResolvedValueOnce({ status: 200, json: () => Promise.resolve({}) });

    const tools = createEnableMcpServerTool("ws-1", logger);
    const result = await tools.enable_mcp_server!.execute({ serverId: "github" }, TOOL_CALL_OPTS);

    expect(result).toEqual({
      success: true,
      server: { id: "github", name: "github" },
      message: "MCP server 'github' is now enabled in this workspace.",
    });
  });

  it("returns error on 404", async () => {
    setupMock("ws-1");
    mockPut.mockResolvedValueOnce({
      status: 404,
      json: () => Promise.resolve({ message: 'Server "github" not found in catalog.' }),
    });

    const tools = createEnableMcpServerTool("ws-1", logger);
    const result = await tools.enable_mcp_server!.execute({ serverId: "github" }, TOOL_CALL_OPTS);

    expect(result).toEqual({ success: false, error: 'Server "github" not found in catalog.' });
  });

  it("returns error on 422 blueprint", async () => {
    setupMock("ws-1");
    mockPut.mockResolvedValueOnce({
      status: 422,
      json: () =>
        Promise.resolve({
          message: "This workspace uses a blueprint — direct config mutations are not supported.",
        }),
    });

    const tools = createEnableMcpServerTool("ws-1", logger);
    const result = await tools.enable_mcp_server!.execute({ serverId: "github" }, TOOL_CALL_OPTS);

    expect(result).toEqual({
      success: false,
      error: "This workspace uses a blueprint — direct config mutations are not supported.",
    });
  });

  it("returns error on unexpected status", async () => {
    setupMock("ws-1");
    mockPut.mockResolvedValueOnce({
      status: 500,
      json: () => Promise.resolve({ message: "Internal server error" }),
    });

    const tools = createEnableMcpServerTool("ws-1", logger);
    const result = await tools.enable_mcp_server!.execute({ serverId: "github" }, TOOL_CALL_OPTS);

    expect(result).toEqual({ success: false, error: "Internal server error" });
  });

  it("returns error when fetch throws", async () => {
    setupMock("ws-1");
    mockPut.mockRejectedValueOnce(new Error("Network failure"));

    const tools = createEnableMcpServerTool("ws-1", logger);
    const result = await tools.enable_mcp_server!.execute({ serverId: "github" }, TOOL_CALL_OPTS);

    expect(result).toEqual({ success: false, error: "Enable failed: Network failure" });
    expect(logger.warn).toHaveBeenCalledWith(
      "enable_mcp_server threw",
      expect.objectContaining({
        workspaceId: "ws-1",
        serverId: "github",
        error: "Network failure",
      }),
    );
  });

  it("uses provided workspaceId instead of bound workspaceId", async () => {
    setupMock("ws-other");
    mockPut.mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({ server: { id: "github", name: "GitHub" } }),
    });

    const tools = createEnableMcpServerTool("ws-1", logger);
    const result = await tools.enable_mcp_server!.execute(
      { serverId: "github", workspaceId: "ws-other" },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({
      success: true,
      server: { id: "github", name: "GitHub" },
      message: "MCP server 'GitHub' is now enabled in this workspace.",
    });
    expect(mockWorkspaceMcp).toHaveBeenCalledWith("ws-other");
    expect(mockPut).toHaveBeenCalledWith({ param: { serverId: "github" } });
  });
});
