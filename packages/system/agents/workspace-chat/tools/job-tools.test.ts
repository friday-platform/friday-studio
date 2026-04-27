import type { JobSpecification, WorkspaceSignalConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import type { Result } from "@atlas/utils";
import { asSchema } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createJobTools } from "./job-tools.ts";

// ---------------------------------------------------------------------------
// Hoisted mocks for @atlas/client/v2
// ---------------------------------------------------------------------------

const mockSignalPost = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
const mockParseResult = vi.hoisted(() =>
  vi.fn<(promise: Promise<unknown>) => Promise<Result<unknown, unknown>>>(),
);

// Match the runtime DetailedError shape so `instanceof DetailedError` checks
// in the unit-under-test succeed against test fixtures. Wrapped in
// `vi.hoisted` because `vi.mock` is hoisted to the top of the module.
const MockDetailedError = vi.hoisted(() => {
  return class extends Error {
    override readonly name = "DetailedError";
    detail?: unknown;
    statusCode?: number;
    constructor(
      message: string,
      options: { detail?: unknown; statusCode?: number } = {},
    ) {
      super(message);
      this.detail = options.detail;
      this.statusCode = options.statusCode;
    }
  };
});

vi.mock("@atlas/client/v2", () => ({
  client: {
    workspace: { ":workspaceId": { signals: { ":signalId": { $post: mockSignalPost } } } },
  },
  parseResult: mockParseResult,
  DetailedError: MockDetailedError,
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

/** Minimal job spec that satisfies the `execution` requirement */
function makeJob(overrides: Partial<JobSpecification> = {}): JobSpecification {
  return {
    execution: { strategy: "sequential", agents: ["test-agent"] },
    ...overrides,
  } satisfies JobSpecification;
}

describe("createJobTools", () => {
  const logger = makeLogger();
  const noSignals: Record<string, WorkspaceSignalConfig> = {};

  it("includes a job with a trigger signal and uses its description", () => {
    const tools = createJobTools(
      "ws-test",
      {
        "deploy-app": makeJob({
          description: "Deploy the application",
          triggers: [{ signal: "deploy-signal" }],
        }),
      },
      noSignals,
      logger,
    );

    expect(Object.keys(tools)).toContain("deploy-app");
    const tool = tools["deploy-app"];
    expect(tool).toBeDefined();
    expect(tool?.description).toBe("Deploy the application");
  });

  it("skips a job without triggers", () => {
    const tools = createJobTools(
      "ws-test",
      { "no-trigger-job": makeJob({ description: "No triggers here" }) },
      noSignals,
      logger,
    );

    expect(Object.keys(tools)).not.toContain("no-trigger-job");
  });

  it("excludes handle-chat job", () => {
    const tools = createJobTools(
      "ws-test",
      { "handle-chat": makeJob({ triggers: [{ signal: "chat-signal" }] }) },
      noSignals,
      logger,
    );

    expect(Object.keys(tools)).not.toContain("handle-chat");
  });

  it("uses DEFAULT_INPUT_SCHEMA when job has no inputs and no signal schema", () => {
    const tools = createJobTools(
      "ws-test",
      { "simple-job": makeJob({ triggers: [{ signal: "simple-signal" }] }) },
      noSignals,
      logger,
    );

    const tool = tools["simple-job"];
    expect(tool).toBeDefined();
    expect(asSchema(tool?.inputSchema).jsonSchema).toEqual({
      type: "object",
      properties: { prompt: { type: "string", description: "What you want this job to do" } },
      required: ["prompt"],
    });
  });

  it("falls back to trigger signal schema when job has no inputs", () => {
    const signals: Record<string, WorkspaceSignalConfig> = {
      "add-item": {
        provider: "http",
        description: "Add an item",
        config: { path: "/webhook/add-item" },
        schema: {
          type: "object",
          properties: {
            item: { type: "string", description: "Item name" },
            quantity: { type: "number" },
          },
          required: ["item"],
        },
      },
    };

    const tools = createJobTools(
      "ws-test",
      { "add-item-job": makeJob({ triggers: [{ signal: "add-item" }] }) },
      signals,
      logger,
    );

    const tool = tools["add-item-job"];
    expect(tool).toBeDefined();
    const signal = signals["add-item"];
    expect(signal).toBeDefined();
    expect(asSchema(tool?.inputSchema).jsonSchema).toEqual(signal?.schema);
  });

  it("prefers job inputs over signal schema", () => {
    const jobInputs = {
      type: "object" as const,
      properties: { name: { type: "string" as const } },
      required: ["name"],
    };

    const signals: Record<string, WorkspaceSignalConfig> = {
      "my-signal": {
        provider: "http",
        description: "A signal",
        config: { path: "/webhook/my-signal" },
        schema: { type: "object", properties: { different: { type: "string" } } },
      },
    };

    const tools = createJobTools(
      "ws-test",
      { "my-job": makeJob({ triggers: [{ signal: "my-signal" }], inputs: jobInputs }) },
      signals,
      logger,
    );

    const tool = tools["my-job"];
    expect(asSchema(tool?.inputSchema).jsonSchema).toEqual(jobInputs);
  });

  it("uses custom inputs schema when provided", () => {
    const customSchema = {
      type: "object" as const,
      properties: {
        target: { type: "string" as const, description: "Deployment target" },
        force: { type: "boolean" as const },
      },
      required: ["target"],
    };

    const tools = createJobTools(
      "ws-test",
      { "custom-job": makeJob({ triggers: [{ signal: "custom-signal" }], inputs: customSchema }) },
      noSignals,
      logger,
    );

    const tool = tools["custom-job"];
    expect(tool).toBeDefined();
    expect(asSchema(tool?.inputSchema).jsonSchema).toEqual(customSchema);
  });
});

// ---------------------------------------------------------------------------
// Execute callback tests
// ---------------------------------------------------------------------------

/** Stub options satisfying ToolExecutionOptions for direct execute calls in tests. */
const TOOL_CALL_OPTS = { toolCallId: "test-call", messages: [] as never[] };

describe("createJobTools execute", () => {
  const noSignals: Record<string, WorkspaceSignalConfig> = {};

  beforeEach(() => {
    mockSignalPost.mockReset();
    mockParseResult.mockReset();
  });

  /** Helper: build tools with a single job and return the tool + a fresh logger. */
  function buildTool(jobName = "deploy-app", signalId = "deploy-signal") {
    const logger = makeLogger();
    const tools = createJobTools(
      "ws-test",
      { [jobName]: makeJob({ description: "Deploy", triggers: [{ signal: signalId }] }) },
      noSignals,
      logger,
    );
    const t = tools[jobName];
    if (!t?.execute) throw new Error(`tool ${jobName} has no execute`);
    return { tool: t, execute: t.execute, logger };
  }

  it("returns success when job completes", async () => {
    mockParseResult.mockResolvedValueOnce({
      ok: true,
      data: { sessionId: "sess-1", status: "completed" },
    });

    const { execute } = buildTool();
    const result = await execute({ prompt: "deploy to prod" }, TOOL_CALL_OPTS);

    expect(result).toEqual({
      success: true,
      sessionId: "sess-1",
      status: "completed",
      output: [],
    });
  });

  it("surfaces structured signal-error body to the chat agent", async () => {
    // Hono's RPC client wraps non-OK responses in DetailedError with the
    // parsed body in `detail.data`. Job-tools must extract the structured
    // `error` field so the chat agent sees the actual failure reason
    // instead of a generic "DetailedError: 422 Unprocessable Entity".
    const detailedError = new MockDetailedError("422 Unprocessable Entity", {
      statusCode: 422,
      detail: {
        data: {
          error:
            "Signal 'review-inbox' session failed: LLM step failed: {\"reason\":\"No email triage data was provided in the input.\"}",
        },
      },
    });
    mockParseResult.mockResolvedValueOnce({ ok: false, error: detailedError });

    const { execute } = buildTool();
    const result = await execute({ prompt: "deploy" }, TOOL_CALL_OPTS);

    expect(result).toEqual({
      success: false,
      statusCode: 422,
      error:
        "Signal 'review-inbox' session failed: LLM step failed: {\"reason\":\"No email triage data was provided in the input.\"}",
    });
  });

  it("falls back to error message when body shape is unexpected", async () => {
    const detailedError = new MockDetailedError("502 Bad Gateway", {
      statusCode: 502,
      detail: { data: "not the expected shape" },
    });
    mockParseResult.mockResolvedValueOnce({ ok: false, error: detailedError });

    const { execute } = buildTool();
    const result = await execute({ prompt: "deploy" }, TOOL_CALL_OPTS);

    expect(result).toEqual({
      success: false,
      statusCode: 502,
      error: "502 Bad Gateway",
    });
  });

  it("handles non-Error rejections gracefully", async () => {
    mockParseResult.mockResolvedValueOnce({ ok: false, error: "workspace not found" });

    const { execute } = buildTool();
    const result = await execute({ prompt: "deploy" }, TOOL_CALL_OPTS);

    expect(result).toEqual({
      success: false,
      statusCode: undefined,
      error: "workspace not found",
    });
  });

  it("returns failure when session status is failed", async () => {
    mockParseResult.mockResolvedValueOnce({
      ok: true,
      data: { sessionId: "sess-2", status: "failed" },
    });

    const { execute, logger } = buildTool();
    const result = await execute({ prompt: "deploy" }, TOOL_CALL_OPTS);

    expect(result).toEqual({
      success: false,
      sessionId: "sess-2",
      status: "failed",
      error: "Job 'deploy-app' returned status: failed",
    });
    expect(logger.error).toHaveBeenCalled();
  });

  it("returns failure when session status is cancelled", async () => {
    mockParseResult.mockResolvedValueOnce({
      ok: true,
      data: { sessionId: "sess-3", status: "cancelled" },
    });

    const { execute } = buildTool();
    const result = await execute({ prompt: "deploy" }, TOOL_CALL_OPTS);

    expect(result).toEqual({
      success: false,
      sessionId: "sess-3",
      status: "cancelled",
      error: "Job 'deploy-app' returned status: cancelled",
    });
  });

  it("passes payload to execution endpoint", async () => {
    mockParseResult.mockResolvedValueOnce({
      ok: true,
      data: { sessionId: "sess-4", status: "completed", error: null },
    });

    const { execute } = buildTool();
    const result = await execute({ target: "production", force: true }, TOOL_CALL_OPTS);

    expect(mockSignalPost).toHaveBeenCalledWith({
      param: { workspaceId: "ws-test", signalId: "deploy-signal" },
      json: { payload: { target: "production", force: true } },
    });
    expect(result).toEqual({
      success: true,
      sessionId: "sess-4",
      status: "completed",
      output: [],
    });
  });
});
