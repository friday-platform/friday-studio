import type { Logger } from "@atlas/logger";
import type { Result } from "@atlas/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkspaceOpsTools } from "./workspace-ops.ts";

// ---------------------------------------------------------------------------
// Hoisted mocks for @atlas/client/v2
// ---------------------------------------------------------------------------

const mockWorkspaceCreatePost = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockWorkspaceDelete = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockParseResult = vi.hoisted(() =>
  vi.fn<(promise: Promise<unknown>) => Promise<Result<unknown, unknown>>>(),
);

vi.mock("@atlas/client/v2", () => ({
  client: {
    workspace: {
      create: { $post: mockWorkspaceCreatePost },
      ":workspaceId": { $delete: mockWorkspaceDelete },
    },
  },
  parseResult: mockParseResult,
}));

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

const TOOL_CALL_OPTS = { toolCallId: "test-call", messages: [] as never[] };

describe("createWorkspaceOpsTools", () => {
  const logger = makeLogger();

  beforeEach(() => {
    mockWorkspaceCreatePost.mockReset();
    mockWorkspaceDelete.mockReset();
    mockParseResult.mockReset();
  });

  // -------------------------------------------------------------------------
  // workspace_create
  // -------------------------------------------------------------------------

  it("registers workspace_create tool", () => {
    const tools = createWorkspaceOpsTools(logger);
    expect(tools).toHaveProperty("workspace_create");
    expect(tools.workspace_create).toBeDefined();
  });

  it("calls workspace create endpoint with config and workspaceName", async () => {
    mockParseResult.mockResolvedValueOnce({
      ok: true,
      data: { id: "ws-123", name: "Test Workspace" },
    });

    const tools = createWorkspaceOpsTools(logger);
    const result = await tools.workspace_create!.execute!(
      {
        config: { version: "1.0", workspace: { name: "Test" } },
        workspaceName: "test-ws",
      },
      TOOL_CALL_OPTS,
    );

    expect(mockWorkspaceCreatePost).toHaveBeenCalledWith({
      json: { config: { version: "1.0", workspace: { name: "Test" } }, workspaceName: "test-ws", ephemeral: false },
    });
    expect(result).toEqual({ success: true, result: { id: "ws-123", name: "Test Workspace" } });
  });

  it("returns structured error when workspace create fails", async () => {
    mockParseResult.mockResolvedValueOnce({ ok: false, error: "Validation failed" });

    const tools = createWorkspaceOpsTools(logger);
    const result = await tools.workspace_create!.execute!(
      { config: { invalid: true } },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({ success: false, error: "Validation failed" });
  });

  // -------------------------------------------------------------------------
  // workspace_delete
  // -------------------------------------------------------------------------

  it("registers workspace_delete tool", () => {
    const tools = createWorkspaceOpsTools(logger);
    expect(tools).toHaveProperty("workspace_delete");
    expect(tools.workspace_delete).toBeDefined();
  });

  it("calls DELETE /api/workspaces/:id directly without force query", async () => {
    mockParseResult.mockResolvedValueOnce({
      ok: true,
      data: { message: "Workspace ws-abc deleted" },
    });

    const tools = createWorkspaceOpsTools(logger);
    const result = await tools.workspace_delete!.execute!(
      { workspaceId: "ws-abc" },
      TOOL_CALL_OPTS,
    );

    expect(mockWorkspaceDelete).toHaveBeenCalledWith({
      param: { workspaceId: "ws-abc" },
      query: {},
    });
    expect(result).toEqual({ success: true, message: "Workspace ws-abc deleted" });
  });

  it("calls DELETE /api/workspaces/:id with force=true query when force is set", async () => {
    mockParseResult.mockResolvedValueOnce({
      ok: true,
      data: { message: "Workspace ws-def deleted" },
    });

    const tools = createWorkspaceOpsTools(logger);
    const result = await tools.workspace_delete!.execute!(
      { workspaceId: "ws-def", force: true },
      TOOL_CALL_OPTS,
    );

    expect(mockWorkspaceDelete).toHaveBeenCalledWith({
      param: { workspaceId: "ws-def" },
      query: { force: "true" },
    });
    expect(result).toEqual({ success: true, message: "Workspace ws-def deleted" });
  });

  it("returns structured error when workspace delete fails", async () => {
    mockParseResult.mockResolvedValueOnce({ ok: false, error: "Workspace not found" });

    const tools = createWorkspaceOpsTools(logger);
    const result = await tools.workspace_delete!.execute!(
      { workspaceId: "missing-ws" },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({ success: false, error: "Workspace not found" });
  });
});
