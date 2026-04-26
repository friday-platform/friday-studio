import type { Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDisableMcpServerTool } from "./disable-mcp-server.ts";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mockDelete = vi.hoisted(() => vi.fn());

vi.mock("@atlas/client/v2", () => ({
  client: { workspaceMcp: () => ({ ":serverId": { $delete: mockDelete } }) },
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

describe("createDisableMcpServerTool", () => {
  const logger = makeLogger();

  beforeEach(() => {
    mockDelete.mockReset();
  });

  it("returns object with disable_mcp_server key", () => {
    const tools = createDisableMcpServerTool("ws-1", logger);
    expect(tools).toHaveProperty("disable_mcp_server");
    expect(tools.disable_mcp_server).toBeDefined();
  });

  it("returns success on 200", async () => {
    mockDelete.mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({ removed: "github" }),
    });

    const tools = createDisableMcpServerTool("ws-1", logger);
    const result = await tools.disable_mcp_server!.execute({ serverId: "github" }, TOOL_CALL_OPTS);

    expect(result).toEqual({
      success: true,
      removed: "github",
      message: "MCP server 'github' has been disabled from this workspace.",
    });
  });

  it("passes force=true as query param", async () => {
    mockDelete.mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({ removed: "github" }),
    });

    const tools = createDisableMcpServerTool("ws-1", logger);
    await tools.disable_mcp_server!.execute({ serverId: "github", force: true }, TOOL_CALL_OPTS);

    expect(mockDelete).toHaveBeenCalledWith(
      expect.objectContaining({ param: { serverId: "github" }, query: { force: "true" } }),
    );
  });

  it("passes force=false without query param", async () => {
    mockDelete.mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({ removed: "github" }),
    });

    const tools = createDisableMcpServerTool("ws-1", logger);
    await tools.disable_mcp_server!.execute({ serverId: "github", force: false }, TOOL_CALL_OPTS);

    expect(mockDelete).toHaveBeenCalledWith(
      expect.objectContaining({ param: { serverId: "github" }, query: undefined }),
    );
  });

  it("returns error on 404", async () => {
    mockDelete.mockResolvedValueOnce({
      status: 404,
      json: () => Promise.resolve({ message: 'Server "github" is not enabled in this workspace.' }),
    });

    const tools = createDisableMcpServerTool("ws-1", logger);
    const result = await tools.disable_mcp_server!.execute({ serverId: "github" }, TOOL_CALL_OPTS);

    expect(result).toEqual({
      success: false,
      error: 'Server "github" is not enabled in this workspace.',
    });
  });

  it("returns conflict on 409 with willUnlinkFrom", async () => {
    mockDelete.mockResolvedValueOnce({
      status: 409,
      json: () =>
        Promise.resolve({
          message: "Server is referenced by 2 entities.",
          willUnlinkFrom: [
            { type: "agent", id: "agent-1" },
            { type: "job", id: "job-1" },
          ],
        }),
    });

    const tools = createDisableMcpServerTool("ws-1", logger);
    const result = await tools.disable_mcp_server!.execute({ serverId: "github" }, TOOL_CALL_OPTS);

    expect(result).toEqual({
      success: false,
      error: "Server is referenced by 2 entities.",
      willUnlinkFrom: [
        { type: "agent", id: "agent-1" },
        { type: "job", id: "job-1" },
      ],
    });
  });

  it("returns error on 422 blueprint", async () => {
    mockDelete.mockResolvedValueOnce({
      status: 422,
      json: () =>
        Promise.resolve({
          message: "This workspace uses a blueprint — direct config mutations are not supported.",
        }),
    });

    const tools = createDisableMcpServerTool("ws-1", logger);
    const result = await tools.disable_mcp_server!.execute({ serverId: "github" }, TOOL_CALL_OPTS);

    expect(result).toEqual({
      success: false,
      error: "This workspace uses a blueprint — direct config mutations are not supported.",
    });
  });

  it("returns error on unexpected status", async () => {
    mockDelete.mockResolvedValueOnce({
      status: 500,
      json: () => Promise.resolve({ message: "Internal server error" }),
    });

    const tools = createDisableMcpServerTool("ws-1", logger);
    const result = await tools.disable_mcp_server!.execute({ serverId: "github" }, TOOL_CALL_OPTS);

    expect(result).toEqual({ success: false, error: "Internal server error" });
  });

  it("returns error when fetch throws", async () => {
    mockDelete.mockRejectedValueOnce(new Error("Network failure"));

    const tools = createDisableMcpServerTool("ws-1", logger);
    const result = await tools.disable_mcp_server!.execute({ serverId: "github" }, TOOL_CALL_OPTS);

    expect(result).toEqual({ success: false, error: "Disable failed: Network failure" });
    expect(logger.warn).toHaveBeenCalledWith(
      "disable_mcp_server threw",
      expect.objectContaining({
        workspaceId: "ws-1",
        serverId: "github",
        error: "Network failure",
      }),
    );
  });
});
