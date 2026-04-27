import type { Logger } from "@atlas/logger";
import type { Result } from "@atlas/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBoundDraftTools, createDraftTools } from "./draft-tools.ts";

// ---------------------------------------------------------------------------
// Hoisted mocks for @atlas/client/v2
// ---------------------------------------------------------------------------

const mockDraftBeginPost = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockDraftPublishPost = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockParseResult = vi.hoisted(() =>
  vi.fn<(promise: Promise<unknown>) => Promise<Result<unknown, unknown>>>(),
);

vi.mock("@atlas/client/v2", () => ({
  client: {
    workspace: {
      ":workspaceId": {
        draft: {
          begin: { $post: mockDraftBeginPost },
          publish: { $post: mockDraftPublishPost },
        },
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

describe("createDraftTools", () => {
  it("returns placeholder begin_draft that errors without workspaceId", async () => {
    const tools = createDraftTools(makeLogger());
    expect(tools).toHaveProperty("begin_draft");

    const result = await tools.begin_draft!.execute!({}, TOOL_CALL_OPTS);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("begin_draft must be called") });
  });

  it("returns placeholder publish_draft that errors without workspaceId", async () => {
    const tools = createDraftTools(makeLogger());
    expect(tools).toHaveProperty("publish_draft");

    const result = await tools.publish_draft!.execute!({}, TOOL_CALL_OPTS);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("publish_draft must be called") });
  });
});

describe("createBoundDraftTools", () => {
  const logger = makeLogger();

  beforeEach(() => {
    mockDraftBeginPost.mockReset();
    mockDraftPublishPost.mockReset();
    mockParseResult.mockReset();
  });

  it("includes begin_draft tool in bound tool set", () => {
    const tools = createBoundDraftTools(logger, "ws-1");
    expect(tools).toHaveProperty("begin_draft");
  });

  it("includes publish_draft tool in bound tool set", () => {
    const tools = createBoundDraftTools(logger, "ws-1");
    expect(tools).toHaveProperty("publish_draft");
  });

  it("begin_draft description mentions idempotency and safe staging", () => {
    const tools = createBoundDraftTools(logger, "ws-1");
    const desc = tools.begin_draft!.description;
    expect(desc.toLowerCase()).toContain("idempotent");
    expect(desc).toContain("draft");
  });

  it("begin_draft calls the draft begin endpoint", async () => {
    mockParseResult.mockResolvedValueOnce({
      ok: true,
      data: { draftPath: "/tmp/ws-1/workspace.yml.draft" },
    });

    const tools = createBoundDraftTools(logger, "ws-1");
    const result = await tools.begin_draft!.execute!({}, TOOL_CALL_OPTS);

    expect(mockDraftBeginPost).toHaveBeenCalledWith({ param: { workspaceId: "ws-1" } });
    expect(result).toEqual({ success: true, draftPath: "/tmp/ws-1/workspace.yml.draft" });
  });

  it("publish_draft calls the draft publish endpoint", async () => {
    mockParseResult.mockResolvedValueOnce({
      ok: true,
      data: { livePath: "/tmp/ws-1/workspace.yml", runtimeReloaded: false },
    });

    const tools = createBoundDraftTools(logger, "ws-1");
    const result = await tools.publish_draft!.execute!({}, TOOL_CALL_OPTS);

    expect(mockDraftPublishPost).toHaveBeenCalledWith({ param: { workspaceId: "ws-1" } });
    expect(result).toEqual({
      success: true,
      livePath: "/tmp/ws-1/workspace.yml",
      runtimeReloaded: false,
    });
  });

  it("begin_draft returns structured error on failure", async () => {
    mockParseResult.mockResolvedValueOnce({ ok: false, error: "Draft already exists" });

    const tools = createBoundDraftTools(logger, "ws-1");
    const result = await tools.begin_draft!.execute!({}, TOOL_CALL_OPTS);

    expect(result).toEqual({ success: false, error: "Draft already exists" });
  });

  it("publish_draft returns structured error on failure", async () => {
    mockParseResult.mockResolvedValueOnce({ ok: false, error: "Validation failed" });

    const tools = createBoundDraftTools(logger, "ws-1");
    const result = await tools.publish_draft!.execute!({}, TOOL_CALL_OPTS);

    expect(result).toEqual({ success: false, error: "Validation failed" });
  });
});
