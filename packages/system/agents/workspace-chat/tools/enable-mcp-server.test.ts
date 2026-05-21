import type { Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEnableMcpServerTool } from "./enable-mcp-server.ts";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockPut = vi.hoisted(() => vi.fn());
const mockWorkspaceMcp = vi.hoisted(() => vi.fn());
const mockInvalidateBlock2 = vi.hoisted(() => vi.fn<(workspaceId: string) => void>());

vi.mock("@atlas/client/v2", () => ({ client: { workspaceMcp: mockWorkspaceMcp } }));
vi.mock("../block2-cache.ts", () => ({ invalidateBlock2: mockInvalidateBlock2 }));

function setupMock(_workspaceId: string) {
  mockWorkspaceMcp.mockReturnValue({ ":serverId": { $put: mockPut } });
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
    mockInvalidateBlock2.mockReset();
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
    const result = await tools.enable_mcp_server?.execute?.({ serverId: "github" }, TOOL_CALL_OPTS);

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
    const result = await tools.enable_mcp_server?.execute?.({ serverId: "github" }, TOOL_CALL_OPTS);

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
    const result = await tools.enable_mcp_server?.execute?.({ serverId: "github" }, TOOL_CALL_OPTS);

    expect(result).toEqual({ success: false, error: 'Server "github" not found in catalog.' });
  });

  // The server-side handler at apps/atlasd/routes/workspaces/mcp.ts:282 returns
  // `{ success: false, error: "needs_manual_config", serverId }` with NO `message`
  // field. Reading only `errorBody.message` collapses it to the generic
  // "Conflict enabling MCP server." string — exactly the misleading wording that
  // sent Friday hunting for a credential-binding fix during the Notion incident.
  it("returns server's structured error code on 409 when no message field", async () => {
    setupMock("ws-1");
    mockPut.mockResolvedValueOnce({
      status: 409,
      json: () =>
        Promise.resolve({
          success: false,
          error: "needs_manual_config",
          serverId: "com-notion-mcp",
        }),
    });

    const tools = createEnableMcpServerTool("ws-1", logger);
    const result = await tools.enable_mcp_server?.execute?.(
      { serverId: "com-notion-mcp" },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({ success: false, error: "needs_manual_config" });
  });

  it("prefers server's message field on 409 when both are present", async () => {
    setupMock("ws-1");
    mockPut.mockResolvedValueOnce({
      status: 409,
      json: () =>
        Promise.resolve({
          success: false,
          error: "conflict",
          message: "Operation conflicts with existing entity",
        }),
    });

    const tools = createEnableMcpServerTool("ws-1", logger);
    const result = await tools.enable_mcp_server?.execute?.({ serverId: "github" }, TOOL_CALL_OPTS);

    expect(result).toEqual({ success: false, error: "Operation conflicts with existing entity" });
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
    const result = await tools.enable_mcp_server?.execute?.({ serverId: "github" }, TOOL_CALL_OPTS);

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
    const result = await tools.enable_mcp_server?.execute?.({ serverId: "github" }, TOOL_CALL_OPTS);

    expect(result).toEqual({ success: false, error: "Internal server error" });
  });

  // Gateways (502/504) and misconfigured proxies routinely return HTML or
  // empty bodies. Before, `res.json()` threw and bubbled to the outer catch,
  // producing "Enable failed: Unexpected non-whitespace character..." — useless
  // to the agent. Now the per-status default reaches the caller.
  it("falls back to per-status default when body is not JSON", async () => {
    setupMock("ws-1");
    mockPut.mockResolvedValueOnce({
      status: 502,
      json: () => Promise.reject(new SyntaxError("Unexpected token '<' at position 0")),
    });

    const tools = createEnableMcpServerTool("ws-1", logger);
    const result = await tools.enable_mcp_server?.execute?.({ serverId: "github" }, TOOL_CALL_OPTS);

    expect(result).toEqual({ success: false, error: "Enable failed: 502" });
  });

  it("falls back to status-specific default on 409 with non-JSON body", async () => {
    setupMock("ws-1");
    mockPut.mockResolvedValueOnce({
      status: 409,
      json: () => Promise.reject(new SyntaxError("Unexpected end of JSON input")),
    });

    const tools = createEnableMcpServerTool("ws-1", logger);
    const result = await tools.enable_mcp_server?.execute?.({ serverId: "github" }, TOOL_CALL_OPTS);

    expect(result).toEqual({ success: false, error: "Conflict enabling MCP server." });
  });

  it("returns error when fetch throws", async () => {
    setupMock("ws-1");
    mockPut.mockRejectedValueOnce(new Error("Network failure"));

    const tools = createEnableMcpServerTool("ws-1", logger);
    const result = await tools.enable_mcp_server?.execute?.({ serverId: "github" }, TOOL_CALL_OPTS);

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
    const result = await tools.enable_mcp_server?.execute?.(
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

  // Enabling a server mutates the workspace's MCP list — the chat's
  // Block 2 cache must be dropped or the `<workspace>` section stays
  // stale for up to the cache TTL.
  it("invalidates the workspace cache on success, scoped to the target workspace", async () => {
    setupMock("ws-other");
    mockPut.mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({ server: { id: "github", name: "GitHub" } }),
    });

    const tools = createEnableMcpServerTool("ws-1", logger);
    await tools.enable_mcp_server?.execute?.(
      { serverId: "github", workspaceId: "ws-other" },
      TOOL_CALL_OPTS,
    );

    expect(mockInvalidateBlock2).toHaveBeenCalledWith("ws-other");
  });

  it("does not invalidate the cache when enable fails", async () => {
    setupMock("ws-1");
    mockPut.mockResolvedValueOnce({
      status: 404,
      json: () => Promise.resolve({ message: 'Server "github" not found in catalog.' }),
    });

    const tools = createEnableMcpServerTool("ws-1", logger);
    await tools.enable_mcp_server?.execute?.({ serverId: "github" }, TOOL_CALL_OPTS);

    expect(mockInvalidateBlock2).not.toHaveBeenCalled();
  });
});
