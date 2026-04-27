import type { Logger } from "@atlas/logger";
import type { Result } from "@atlas/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBoundUpsertTools, createUpsertTools } from "./upsert-tools.ts";

// ---------------------------------------------------------------------------
// Hoisted mocks for @atlas/client/v2
// ---------------------------------------------------------------------------

const mockDraftItemsPost = vi.hoisted(() => vi.fn<() => Promise<Response>>());
const mockDirectItemsPost = vi.hoisted(() => vi.fn<() => Promise<Response>>());
const mockParseResult = vi.hoisted(() =>
  vi.fn<(promise: Promise<unknown>) => Promise<Result<unknown, unknown>>>(),
);

vi.mock("@atlas/client/v2", () => ({
  client: {
    workspace: {
      ":workspaceId": {
        draft: {
          items: {
            ":kind": { $post: mockDraftItemsPost },
          },
        },
        items: {
          ":kind": { $post: mockDirectItemsPost },
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

function makeResponse(body: unknown, status = 200, ok = true): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

describe("createUpsertTools", () => {
  it("returns placeholder tools that error without workspaceId", async () => {
    const tools = createUpsertTools(makeLogger());
    expect(tools).toHaveProperty("upsert_agent");
    expect(tools).toHaveProperty("upsert_signal");
    expect(tools).toHaveProperty("upsert_job");

    const result = await tools.upsert_agent!.execute!(
      { id: "a", config: {} },
      TOOL_CALL_OPTS,
    );
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("upsert_agent must be called"),
    });
  });
});

describe("createBoundUpsertTools", () => {
  const logger = makeLogger();

  beforeEach(() => {
    mockDraftItemsPost.mockReset();
    mockDirectItemsPost.mockReset();
    mockParseResult.mockReset();
  });

  it("includes all three upsert tools in bound set", () => {
    const tools = createBoundUpsertTools(logger, "ws-1");
    expect(tools).toHaveProperty("upsert_agent");
    expect(tools).toHaveProperty("upsert_signal");
    expect(tools).toHaveProperty("upsert_job");
  });

  it("upsert_agent calls draft endpoint when draft exists", async () => {
    mockDraftItemsPost.mockResolvedValueOnce(
      makeResponse({ ok: true, diff: { type: { to: "llm" } }, structuralIssues: null }),
    );

    const tools = createBoundUpsertTools(logger, "ws-1");
    const result = await tools.upsert_agent!.execute!(
      { id: "email-triager", config: { type: "llm" } },
      TOOL_CALL_OPTS,
    );

    expect(mockDraftItemsPost).toHaveBeenCalledWith({
      param: { workspaceId: "ws-1", kind: "agent" },
      json: { id: "email-triager", config: { type: "llm" } },
    });
    expect(result).toEqual({
      ok: true,
      diff: { type: { to: "llm" } },
      structural_issues: null,
    });
  });

  it("upsert_agent falls back to direct endpoint when no draft (409)", async () => {
    mockDraftItemsPost.mockResolvedValueOnce(makeResponse({ error: "No draft exists" }, 409, false));
    mockDirectItemsPost.mockResolvedValueOnce(
      makeResponse({ ok: true, diff: { type: { to: "llm" } }, structuralIssues: null, runtimeReloaded: false }),
    );

    const tools = createBoundUpsertTools(logger, "ws-1");
    const result = await tools.upsert_agent!.execute!(
      { id: "email-triager", config: { type: "llm" } },
      TOOL_CALL_OPTS,
    );

    expect(mockDraftItemsPost).toHaveBeenCalledWith({
      param: { workspaceId: "ws-1", kind: "agent" },
      json: { id: "email-triager", config: { type: "llm" } },
    });
    expect(mockDirectItemsPost).toHaveBeenCalledWith({
      param: { workspaceId: "ws-1", kind: "agent" },
      json: { id: "email-triager", config: { type: "llm" } },
    });
    expect(result).toEqual({
      ok: true,
      diff: { type: { to: "llm" } },
      structural_issues: null,
    });
  });

  it("upsert_signal calls draft endpoint with correct kind", async () => {
    mockDraftItemsPost.mockResolvedValueOnce(
      makeResponse({ ok: true, diff: { provider: { to: "http" } }, structuralIssues: null }),
    );

    const tools = createBoundUpsertTools(logger, "ws-1");
    const result = await tools.upsert_signal!.execute!(
      { id: "webhook", config: { provider: "http" } },
      TOOL_CALL_OPTS,
    );

    expect(mockDraftItemsPost).toHaveBeenCalledWith({
      param: { workspaceId: "ws-1", kind: "signal" },
      json: { id: "webhook", config: { provider: "http" } },
    });
    expect(result).toEqual({
      ok: true,
      diff: { provider: { to: "http" } },
      structural_issues: null,
    });
  });

  it("upsert_job calls draft endpoint with correct kind", async () => {
    mockDraftItemsPost.mockResolvedValueOnce(
      makeResponse({ ok: true, diff: { description: { to: "Test job" } }, structuralIssues: null }),
    );

    const tools = createBoundUpsertTools(logger, "ws-1");
    const result = await tools.upsert_job!.execute!(
      { id: "test-job", config: { description: "Test job" } },
      TOOL_CALL_OPTS,
    );

    expect(mockDraftItemsPost).toHaveBeenCalledWith({
      param: { workspaceId: "ws-1", kind: "job" },
      json: { id: "test-job", config: { description: "Test job" } },
    });
    expect(result).toEqual({
      ok: true,
      diff: { description: { to: "Test job" } },
      structural_issues: null,
    });
  });

  it("returns structured error when draft endpoint fails for non-409 reason", async () => {
    mockDraftItemsPost.mockResolvedValueOnce(
      makeResponse({ error: "Invalid agent config" }, 400, false),
    );

    const tools = createBoundUpsertTools(logger, "ws-1");
    const result = await tools.upsert_agent!.execute!(
      { id: "bad-agent", config: { invalid: true } },
      TOOL_CALL_OPTS,
    );

    expect(mockDirectItemsPost).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      diff: {},
      structural_issues: null,
      error: "Invalid agent config",
    });
  });

  it("returns structured error when direct endpoint fails", async () => {
    mockDraftItemsPost.mockResolvedValueOnce(makeResponse({ error: "No draft exists" }, 409, false));
    mockDirectItemsPost.mockResolvedValueOnce(
      makeResponse({ error: "Direct upsert failed" }, 500, false),
    );

    const tools = createBoundUpsertTools(logger, "ws-1");
    const result = await tools.upsert_agent!.execute!(
      { id: "agent", config: {} },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({
      ok: false,
      diff: {},
      structural_issues: null,
      error: "Direct upsert failed",
    });
  });

  it("handles json body parsing failures gracefully", async () => {
    mockDraftItemsPost.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("JSON parse error");
      },
    } as Response);

    const tools = createBoundUpsertTools(logger, "ws-1");
    const result = await tools.upsert_agent!.execute!(
      { id: "agent", config: {} },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({
      ok: false,
      diff: {},
      structural_issues: null,
      error: "Draft agent upsert failed",
    });
  });
});
