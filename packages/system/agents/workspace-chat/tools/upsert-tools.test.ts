import { WorkspaceAgentConfigSchema } from "@atlas/config";
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
        draft: { items: { ":kind": { $post: mockDraftItemsPost } } },
        items: { ":kind": { $post: mockDirectItemsPost } },
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
  return { ok, status, json: () => Promise.resolve(body) } as Response;
}

describe("createUpsertTools", () => {
  it("returns placeholder tools that error without workspaceId", async () => {
    const tools = createUpsertTools(makeLogger());
    expect(tools).toHaveProperty("upsert_agent");
    expect(tools).toHaveProperty("upsert_signal");
    expect(tools).toHaveProperty("upsert_job");

    const result = await tools.upsert_agent!.execute!({ id: "a", config: {} }, TOOL_CALL_OPTS);
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
    expect(result).toEqual({ ok: true, diff: { type: { to: "llm" } }, structural_issues: null });
  });

  it("upsert_agent falls back to direct endpoint when no draft (409)", async () => {
    mockDraftItemsPost.mockResolvedValueOnce(
      makeResponse({ error: "No draft exists" }, 409, false),
    );
    mockDirectItemsPost.mockResolvedValueOnce(
      makeResponse({
        ok: true,
        diff: { type: { to: "llm" } },
        structuralIssues: null,
        runtimeReloaded: false,
      }),
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
    expect(result).toEqual({ ok: true, diff: { type: { to: "llm" } }, structural_issues: null });
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
    mockDraftItemsPost.mockResolvedValueOnce(
      makeResponse({ error: "No draft exists" }, 409, false),
    );
    mockDirectItemsPost.mockResolvedValueOnce(
      makeResponse({ error: "Direct upsert failed" }, 500, false),
    );

    const tools = createBoundUpsertTools(logger, "ws-1");
    const result = await tools.upsert_agent!.execute!({ id: "agent", config: {} }, TOOL_CALL_OPTS);

    expect(result).toEqual({
      ok: false,
      diff: {},
      structural_issues: null,
      error: "Direct upsert failed",
    });
  });

  it("preserves diff and structural_issues when direct endpoint returns 422", async () => {
    mockDraftItemsPost.mockResolvedValueOnce(
      makeResponse({ error: "No draft exists" }, 409, false),
    );
    mockDirectItemsPost.mockResolvedValueOnce(
      makeResponse(
        {
          ok: false,
          diff: { "config.tools": { added: ["google-gmail/search_gmail_messages"] } },
          structural_issues: [
            {
              code: "unknown_tool",
              path: "agents.email-triage.config.tools[0]",
              message: "unknown tool",
            },
          ],
        },
        422,
        false,
      ),
    );

    const tools = createBoundUpsertTools(logger, "ws-1");
    const result = await tools.upsert_agent!.execute!(
      { id: "email-triage", config: { type: "llm" } },
      TOOL_CALL_OPTS,
    );

    expect(result).toEqual({
      ok: false,
      diff: { "config.tools": { added: ["google-gmail/search_gmail_messages"] } },
      structural_issues: [
        {
          code: "unknown_tool",
          path: "agents.email-triage.config.tools[0]",
          message: "unknown tool",
        },
      ],
      error: "Validation failed",
    });
  });

  it("handles json body parsing failures gracefully", async () => {
    mockDraftItemsPost.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error("JSON parse error")),
    } as Response);

    const tools = createBoundUpsertTools(logger, "ws-1");
    const result = await tools.upsert_agent!.execute!({ id: "agent", config: {} }, TOOL_CALL_OPTS);

    expect(result).toEqual({
      ok: false,
      diff: {},
      structural_issues: null,
      error: "Draft agent upsert failed",
    });
  });
});

// ===========================================================================
// upsert_agent description: must teach the LLM all three authorable type
// shapes (llm | atlas | user). type: "system" is server-internal and must NOT
// be advertised. Snapshot guards against regressions that trim the description
// back to the llm-only shape or accidentally re-add the system row.
// ===========================================================================

describe("upsert_agent tool description", () => {
  function getDescription(): string {
    const tools = createBoundUpsertTools(makeLogger(), "ws-1");
    const description = tools.upsert_agent?.description;
    if (typeof description !== "string") {
      throw new Error("upsert_agent description must be a string");
    }
    return description;
  }

  it("enumerates all three authorable agent type shapes", () => {
    const description = getDescription();
    expect(description).toContain('type: "llm"');
    expect(description).toContain('type: "atlas"');
    expect(description).toContain('type: "user"');
  });

  it("references list_capabilities as the discovery surface", () => {
    expect(getDescription()).toContain("list_capabilities");
  });

  it('does not advertise type: "system" (server-internal only)', () => {
    const description = getDescription();
    expect(description).not.toContain('type: "system"');
    expect(description).not.toContain("type: system");
  });
});

// ===========================================================================
// WorkspaceAgentConfigSchema acceptance: the discriminated union accepts all
// four variants server-side. The chat-facing description only advertises three
// (llm | atlas | user); the server still parses type: "system" because it is
// used for platform-internal agents.
//
// Note: there is intentionally no `unknown_bundled_agent` validation case
// here. The bundled-agent-discovery design doc keeps server runtime unchanged
// (see § Module Boundaries) and lists registry-membership validation under
// § Out of Scope as the post-ship escalation path if telemetry shows the LLM
// still produces unknown atlas agent ids despite list_capabilities + the
// SKILL rewrite. Don't add registry-membership validation here without
// re-opening that decision.
// ===========================================================================

describe("WorkspaceAgentConfigSchema acceptance", () => {
  it('accepts type: "atlas" with agent: "web"', () => {
    const parsed = WorkspaceAgentConfigSchema.parse({
      type: "atlas",
      agent: "web",
      description: "Scrape headlines",
      prompt: "Fetch the top stories from Hacker News",
    });
    expect(parsed.type).toBe("atlas");
  });

  it('accepts type: "atlas" with legacy alias agent: "browser"', () => {
    const parsed = WorkspaceAgentConfigSchema.parse({
      type: "atlas",
      agent: "browser",
      description: "Legacy browser agent reference",
      prompt: "Render a page",
    });
    expect(parsed.type).toBe("atlas");
  });

  it('accepts type: "user" with a registered agent id', () => {
    const parsed = WorkspaceAgentConfigSchema.parse({
      type: "user",
      agent: "csv-parser",
      description: "Parse CSV input",
      prompt: "Map column A to field X",
    });
    expect(parsed.type).toBe("user");
  });

  it('accepts type: "system" server-side (not advertised in chat)', () => {
    const parsed = WorkspaceAgentConfigSchema.parse({
      type: "system",
      agent: "internal-router",
      description: "Platform-internal agent",
    });
    expect(parsed.type).toBe("system");
  });
});
