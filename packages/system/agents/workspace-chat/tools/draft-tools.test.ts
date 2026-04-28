import type { Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBoundDraftTools, createDraftTools } from "./draft-tools.ts";

// ---------------------------------------------------------------------------
// Hoisted mocks for @atlas/client/v2
// ---------------------------------------------------------------------------

const mockDraftBeginPost = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockDraftPublishPost = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockDraftValidatePost = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockDraftDelete = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockLintPost = vi.hoisted(() => vi.fn<() => Promise<unknown>>());

function mockResponse(ok: boolean, status: number, body: unknown): unknown {
  return { ok, status, json: () => Promise.resolve(body) };
}

vi.mock("@atlas/client/v2", () => ({
  client: {
    workspace: {
      ":workspaceId": {
        draft: {
          begin: { $post: mockDraftBeginPost },
          publish: { $post: mockDraftPublishPost },
          validate: { $post: mockDraftValidatePost },
          $delete: mockDraftDelete,
        },
        lint: { $post: mockLintPost },
      },
    },
  },
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

describe("createDraftTools", () => {
  it("returns placeholder begin_draft that errors without workspaceId", async () => {
    const tools = createDraftTools(makeLogger());
    expect(tools).toHaveProperty("begin_draft");

    const result = await tools.begin_draft!.execute!({}, TOOL_CALL_OPTS);
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("begin_draft must be called"),
    });
  });

  it("returns placeholder publish_draft that errors without workspaceId", async () => {
    const tools = createDraftTools(makeLogger());
    expect(tools).toHaveProperty("publish_draft");

    const result = await tools.publish_draft!.execute!({}, TOOL_CALL_OPTS);
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("publish_draft must be called"),
    });
  });

  it("returns placeholder validate_workspace that errors without workspaceId", async () => {
    const tools = createDraftTools(makeLogger());
    expect(tools).toHaveProperty("validate_workspace");

    const result = await tools.validate_workspace!.execute!({}, TOOL_CALL_OPTS);
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("validate_workspace must be called"),
    });
  });

  it("returns placeholder discard_draft that errors without workspaceId", async () => {
    const tools = createDraftTools(makeLogger());
    expect(tools).toHaveProperty("discard_draft");

    const result = await tools.discard_draft!.execute!({}, TOOL_CALL_OPTS);
    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining("discard_draft must be called"),
    });
  });
});

describe("createBoundDraftTools", () => {
  const logger = makeLogger();

  beforeEach(() => {
    mockDraftBeginPost.mockReset();
    mockDraftPublishPost.mockReset();
    mockDraftValidatePost.mockReset();
    mockDraftDelete.mockReset();
    mockLintPost.mockReset();
  });

  it("includes begin_draft tool in bound tool set", () => {
    const tools = createBoundDraftTools(logger, "ws-1");
    expect(tools).toHaveProperty("begin_draft");
  });

  it("includes publish_draft tool in bound tool set", () => {
    const tools = createBoundDraftTools(logger, "ws-1");
    expect(tools).toHaveProperty("publish_draft");
  });

  it("includes validate_workspace tool in bound tool set", () => {
    const tools = createBoundDraftTools(logger, "ws-1");
    expect(tools).toHaveProperty("validate_workspace");
  });

  it("includes discard_draft tool in bound tool set", () => {
    const tools = createBoundDraftTools(logger, "ws-1");
    expect(tools).toHaveProperty("discard_draft");
  });

  it("begin_draft description mentions idempotency and safe staging", () => {
    const tools = createBoundDraftTools(logger, "ws-1");
    const desc = tools.begin_draft!.description;
    expect(desc?.toLowerCase()).toContain("idempotent");
    expect(desc).toContain("draft");
  });

  it("begin_draft calls the draft begin endpoint", async () => {
    mockDraftBeginPost.mockResolvedValueOnce(
      mockResponse(true, 200, { success: true, draftPath: "/tmp/ws-1/workspace.yml.draft" }),
    );

    const tools = createBoundDraftTools(logger, "ws-1");
    const result = await tools.begin_draft!.execute!({}, TOOL_CALL_OPTS);

    expect(mockDraftBeginPost).toHaveBeenCalledWith({ param: { workspaceId: "ws-1" } });
    expect(result).toEqual({ success: true, draftPath: "/tmp/ws-1/workspace.yml.draft" });
  });

  it("publish_draft calls the draft publish endpoint", async () => {
    mockDraftPublishPost.mockResolvedValueOnce(
      mockResponse(true, 200, {
        success: true,
        livePath: "/tmp/ws-1/workspace.yml",
      }),
    );

    const tools = createBoundDraftTools(logger, "ws-1");
    const result = await tools.publish_draft!.execute!({}, TOOL_CALL_OPTS);

    expect(mockDraftPublishPost).toHaveBeenCalledWith({ param: { workspaceId: "ws-1" } });
    expect(result).toEqual({
      success: true,
      livePath: "/tmp/ws-1/workspace.yml",
    });
  });

  it("publish_draft returns report on validation failure", async () => {
    const report = {
      status: "error",
      errors: [{ code: "unknown_agent_id", path: "jobs.test.fsm", message: "Missing agent" }],
      warnings: [],
    };
    mockDraftPublishPost.mockResolvedValueOnce(
      mockResponse(false, 422, { success: false, error: "Validation failed", report }),
    );

    const tools = createBoundDraftTools(logger, "ws-1");
    const result = await tools.publish_draft!.execute!({}, TOOL_CALL_OPTS);

    expect(result).toEqual({ success: false, error: "Validation failed", report });
  });

  it("begin_draft returns structured error on failure", async () => {
    mockDraftBeginPost.mockResolvedValueOnce(
      mockResponse(false, 400, { success: false, error: "Draft already exists" }),
    );

    const tools = createBoundDraftTools(logger, "ws-1");
    const result = await tools.begin_draft!.execute!({}, TOOL_CALL_OPTS);

    expect(result).toEqual({ success: false, error: "Draft already exists" });
  });

  it("publish_draft returns structured error on failure", async () => {
    mockDraftPublishPost.mockResolvedValueOnce(
      mockResponse(false, 409, { success: false, error: "No draft to publish" }),
    );

    const tools = createBoundDraftTools(logger, "ws-1");
    const result = await tools.publish_draft!.execute!({}, TOOL_CALL_OPTS);

    expect(result).toEqual({ success: false, error: "No draft to publish" });
  });

  it("validate_workspace returns draft report when draft exists", async () => {
    const report = { status: "ok", errors: [], warnings: [] };
    mockDraftValidatePost.mockResolvedValueOnce(mockResponse(true, 200, { success: true, report }));

    const tools = createBoundDraftTools(logger, "ws-1");
    const result = await tools.validate_workspace!.execute!({}, TOOL_CALL_OPTS);

    expect(mockDraftValidatePost).toHaveBeenCalledWith({ param: { workspaceId: "ws-1" } });
    expect(result).toEqual(report);
  });

  it("validate_workspace falls back to lint when no draft exists", async () => {
    const report = { status: "ok", errors: [], warnings: [] };
    mockDraftValidatePost.mockResolvedValueOnce(
      mockResponse(false, 409, { success: false, error: "No draft exists" }),
    );
    mockLintPost.mockResolvedValueOnce(mockResponse(true, 200, { report }));

    const tools = createBoundDraftTools(logger, "ws-1");
    const result = await tools.validate_workspace!.execute!({}, TOOL_CALL_OPTS);

    expect(mockLintPost).toHaveBeenCalledWith({ param: { workspaceId: "ws-1" } });
    expect(result).toEqual(report);
  });

  it("validate_workspace returns error when both draft and lint fail", async () => {
    mockDraftValidatePost.mockResolvedValueOnce(
      mockResponse(false, 500, { success: false, error: "Server error" }),
    );

    const tools = createBoundDraftTools(logger, "ws-1");
    const result = await tools.validate_workspace!.execute!({}, TOOL_CALL_OPTS);

    expect(result).toEqual({ success: false, error: "Server error" });
  });

  it("discard_draft succeeds when draft is deleted", async () => {
    mockDraftDelete.mockResolvedValueOnce(mockResponse(true, 200, { success: true }));

    const tools = createBoundDraftTools(logger, "ws-1");
    const result = await tools.discard_draft!.execute!({}, TOOL_CALL_OPTS);

    expect(mockDraftDelete).toHaveBeenCalledWith({ param: { workspaceId: "ws-1" } });
    expect(result).toEqual({ success: true, noOp: false });
  });

  it("discard_draft no-op when no draft exists", async () => {
    mockDraftDelete.mockResolvedValueOnce(
      mockResponse(false, 409, { success: false, error: "No draft to discard" }),
    );

    const tools = createBoundDraftTools(logger, "ws-1");
    const result = await tools.discard_draft!.execute!({}, TOOL_CALL_OPTS);

    expect(result).toEqual({ success: true, noOp: true });
  });

  it("discard_draft returns error on unexpected failure", async () => {
    mockDraftDelete.mockResolvedValueOnce(
      mockResponse(false, 500, { success: false, error: "Server error" }),
    );

    const tools = createBoundDraftTools(logger, "ws-1");
    const result = await tools.discard_draft!.execute!({}, TOOL_CALL_OPTS);

    expect(result).toEqual({ success: false, error: "Server error" });
  });
});
