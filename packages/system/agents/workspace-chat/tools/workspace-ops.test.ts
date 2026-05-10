import type { Logger } from "@atlas/logger";
import type { Result } from "@atlas/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBoundWorkspaceOpsTools, createWorkspaceOpsTools } from "./workspace-ops.ts";

// ---------------------------------------------------------------------------
// Hoisted mocks for @atlas/client/v2
// ---------------------------------------------------------------------------

const mockWorkspaceCreatePost = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockWorkspaceDelete = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockItemsDelete = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockParseResult = vi.hoisted(() =>
  vi.fn<(promise: Promise<unknown>) => Promise<Result<unknown, unknown>>>(),
);

vi.mock("@atlas/client/v2", () => ({
  client: {
    workspace: {
      create: { $post: mockWorkspaceCreatePost },
      ":workspaceId": {
        $delete: mockWorkspaceDelete,
        items: { ":kind": { ":id": { $delete: mockItemsDelete } } },
      },
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
  // create_workspace
  // -------------------------------------------------------------------------

  it("registers create_workspace tool", () => {
    const tools = createWorkspaceOpsTools(logger);
    expect(tools).toHaveProperty("create_workspace");
    expect(tools.create_workspace).toBeDefined();
  });

  it("calls workspace create endpoint with minimal config", async () => {
    mockParseResult.mockResolvedValueOnce({
      ok: true,
      data: {
        workspace: { id: "ws-123", name: "Test Workspace" },
        workspacePath: "/tmp/workspaces/test-workspace",
      },
    });

    const tools = createWorkspaceOpsTools(logger);
    const result = await tools.create_workspace!.execute!(
      { name: "Test Workspace", description: "A test workspace" },
      TOOL_CALL_OPTS,
    );

    expect(mockWorkspaceCreatePost).toHaveBeenCalledWith({
      json: {
        config: {
          version: "1.0",
          workspace: { name: "Test Workspace", description: "A test workspace" },
        },
        workspaceName: undefined,
        ephemeral: false,
      },
    });
    expect(result).toEqual({
      success: true,
      workspace: { id: "ws-123", name: "Test Workspace", path: "/tmp/workspaces/test-workspace" },
    });
  });

  it("returns structured error when create_workspace fails", async () => {
    mockParseResult.mockResolvedValueOnce({ ok: false, error: "Validation failed" });

    const tools = createWorkspaceOpsTools(logger);
    const result = await tools.create_workspace!.execute!(
      { name: "Bad Workspace" },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({ success: false, error: "Validation failed" });
  });

  // -------------------------------------------------------------------------
  // delete_workspace
  // -------------------------------------------------------------------------

  it("registers delete_workspace tool", () => {
    const tools = createWorkspaceOpsTools(logger);
    expect(tools).toHaveProperty("delete_workspace");
    expect(tools.delete_workspace).toBeDefined();
  });

  it("calls DELETE /api/workspaces/:id directly without force query", async () => {
    mockParseResult.mockResolvedValueOnce({
      ok: true,
      data: { message: "Workspace ws-abc deleted" },
    });

    const tools = createWorkspaceOpsTools(logger);
    const result = await tools.delete_workspace!.execute!(
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
    const result = await tools.delete_workspace!.execute!(
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
    const result = await tools.delete_workspace!.execute!(
      { workspaceId: "missing-ws" },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({ success: false, error: "Workspace not found" });
  });
});

function mockResponse(ok: boolean, status: number, body: unknown): unknown {
  return { ok, status, json: () => Promise.resolve(body) };
}

describe("createBoundWorkspaceOpsTools", () => {
  const logger = makeLogger();

  beforeEach(() => {
    mockItemsDelete.mockReset();
  });

  // -------------------------------------------------------------------------
  // delete_agent / delete_signal / delete_job
  // -------------------------------------------------------------------------

  it("registers delete_agent / delete_signal / delete_job tools", () => {
    const tools = createBoundWorkspaceOpsTools(logger, "ws-1");
    expect(tools).toHaveProperty("delete_agent");
    expect(tools).toHaveProperty("delete_signal");
    expect(tools).toHaveProperty("delete_job");
  });

  it("calls DELETE /items/agent/:id and returns success", async () => {
    mockItemsDelete.mockResolvedValueOnce(
      mockResponse(true, 200, { ok: true, livePath: "/tmp/ws-1/workspace.yml" }),
    );

    const tools = createBoundWorkspaceOpsTools(logger, "ws-1");
    const result = await tools.delete_agent!.execute!({ id: "test-agent" }, TOOL_CALL_OPTS);

    expect(mockItemsDelete).toHaveBeenCalledWith({
      param: { workspaceId: "ws-1", kind: "agent", id: "test-agent" },
    });
    expect(result).toEqual({ ok: true, livePath: "/tmp/ws-1/workspace.yml" });
  });

  it("delete_signal calls DELETE /items/signal/:id", async () => {
    mockItemsDelete.mockResolvedValueOnce(mockResponse(true, 200, { ok: true }));

    const tools = createBoundWorkspaceOpsTools(logger, "ws-1");
    await tools.delete_signal!.execute!({ id: "my-signal" }, TOOL_CALL_OPTS);

    expect(mockItemsDelete).toHaveBeenCalledWith({
      param: { workspaceId: "ws-1", kind: "signal", id: "my-signal" },
    });
  });

  it("delete_job calls DELETE /items/job/:id", async () => {
    mockItemsDelete.mockResolvedValueOnce(mockResponse(true, 200, { ok: true }));

    const tools = createBoundWorkspaceOpsTools(logger, "ws-1");
    await tools.delete_job!.execute!({ id: "my-job" }, TOOL_CALL_OPTS);

    expect(mockItemsDelete).toHaveBeenCalledWith({
      param: { workspaceId: "ws-1", kind: "job", id: "my-job" },
    });
  });

  it("returns structured error when delete fails", async () => {
    mockItemsDelete.mockResolvedValueOnce(
      mockResponse(false, 422, {
        ok: false,
        error: { code: "referenced", dependents: ["test-job"] },
      }),
    );

    const tools = createBoundWorkspaceOpsTools(logger, "ws-1");
    const result = await tools.delete_agent!.execute!({ id: "test-agent" }, TOOL_CALL_OPTS);

    expect(result).toEqual({ ok: false, error: { code: "referenced", dependents: ["test-job"] } });
  });
});
