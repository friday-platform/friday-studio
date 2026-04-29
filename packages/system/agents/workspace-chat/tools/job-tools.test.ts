import type { AtlasUIMessage } from "@atlas/agent-sdk";
import type { JobSpecification, WorkspaceSignalConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import type { Result } from "@atlas/utils";
import type { UIMessageStreamWriter } from "ai";
import { asSchema } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJobTools } from "./job-tools.ts";

// ---------------------------------------------------------------------------
// Hoisted mocks
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
    constructor(message: string, options: { detail?: unknown; statusCode?: number } = {}) {
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

vi.mock("@atlas/oapi-client", () => ({ getAtlasDaemonUrl: () => "http://localhost:3000" }));

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

    expect(result).toEqual({ success: true, sessionId: "sess-1", status: "completed", output: [] });
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
            'Signal \'review-inbox\' session failed: LLM step failed: {"reason":"No email triage data was provided in the input."}',
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
        'Signal \'review-inbox\' session failed: LLM step failed: {"reason":"No email triage data was provided in the input."}',
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

    expect(result).toEqual({ success: false, statusCode: 502, error: "502 Bad Gateway" });
  });

  it("handles non-Error rejections gracefully", async () => {
    mockParseResult.mockResolvedValueOnce({ ok: false, error: "workspace not found" });

    const { execute } = buildTool();
    const result = await execute({ prompt: "deploy" }, TOOL_CALL_OPTS);

    expect(result).toEqual({ success: false, statusCode: undefined, error: "workspace not found" });
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
    expect(result).toEqual({ success: true, sessionId: "sess-4", status: "completed", output: [] });
  });
});

// ---------------------------------------------------------------------------
// SSE streaming path tests
// ---------------------------------------------------------------------------

/** Build a ReadableStream<Uint8Array> that yields SSE message lines. */
function makeMockSSEStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < lines.length) {
        controller.enqueue(encoder.encode(lines[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

/** Build a mock Response for the SSE fetch path. */
function makeMockFetchResponse(
  lines: string[],
  overrides?: { ok?: boolean; status?: number; jsonBody?: unknown },
): Response {
  return {
    ok: overrides?.ok ?? true,
    status: overrides?.status ?? 200,
    body: makeMockSSEStream(lines),
    json: vi.fn(() => Promise.resolve(overrides?.jsonBody ?? {})),
    headers: new Headers(),
  } as unknown as Response;
}

/** Build job tools in SSE mode (writer present). */
function buildStreamingTool(jobName = "deploy-app", signalId = "deploy-signal") {
  const logger = makeLogger();
  const writer: UIMessageStreamWriter<AtlasUIMessage> = { write: vi.fn(), merge: vi.fn(), onError: vi.fn() };
  const tools = createJobTools(
    "ws-test",
    { [jobName]: makeJob({ description: "Deploy", triggers: [{ signal: signalId }] }) },
    {},
    logger,
    undefined,
    writer,
  );
  const t = tools[jobName];
  if (!t?.execute) throw new Error(`tool ${jobName} has no execute`);
  return { tool: t, execute: t.execute, logger, writer };
}

describe("createJobTools execute (SSE streaming)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns success on job-complete and forwards chunks as nested-chunk", async () => {
    globalThis.fetch = vi.fn(() =>
      makeMockFetchResponse([
        `data: ${JSON.stringify({ type: "tool-input-start", toolCallId: "tc1", toolName: "test-tool" })}
\n\n`,
        `data: ${JSON.stringify({
          type: "job-complete",
          data: {
            success: true,
            sessionId: "sess-sse-1",
            status: "completed",
            output: [{ id: "1" }],
          },
        })}
\n\n`,
        "data: [DONE]\n\n",
      ]),
    ) as unknown as typeof fetch;

    const { execute, writer } = buildStreamingTool();
    const result = await execute({ prompt: "deploy" }, TOOL_CALL_OPTS);

    expect(result).toEqual({
      success: true,
      sessionId: "sess-sse-1",
      status: "completed",
      output: [{ id: "1" }],
    });

    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(writer.write).toHaveBeenCalledWith({
      type: "data-nested-chunk",
      data: {
        parentToolCallId: "test-call",
        chunk: { type: "tool-input-start", toolCallId: "tc1", toolName: "test-tool" },
      },
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:3000/api/workspaces/ws-test/signals/deploy-signal",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ payload: { prompt: "deploy" } }),
      }),
    );
  });

  it("forwards multiple chunks before job-complete", async () => {
    globalThis.fetch = vi.fn(() =>
      makeMockFetchResponse([
        `data: ${JSON.stringify({ type: "tool-input-start", toolCallId: "tc1", toolName: "a" })}
\n\n`,
        `data: ${JSON.stringify({ type: "tool-input-available", toolCallId: "tc1", input: { x: 1 } })}
\n\n`,
        `data: ${JSON.stringify({ type: "tool-input-start", toolCallId: "tc2", toolName: "b" })}
\n\n`,
        `data: ${JSON.stringify({
          type: "job-complete",
          data: { success: true, sessionId: "sess-sse-2", status: "completed", output: [] },
        })}
\n\n`,
        "data: [DONE]\n\n",
      ]),
    ) as unknown as typeof fetch;

    const { execute, writer } = buildStreamingTool();
    await execute({ prompt: "go" }, TOOL_CALL_OPTS);

    expect(writer.write).toHaveBeenCalledTimes(3);
  });

  it("ignores unknown chunk types silently", async () => {
    globalThis.fetch = vi.fn(() =>
      makeMockFetchResponse([
        `data: ${JSON.stringify({ type: "data-session-start", data: { sessionId: "sess-x" } })}
\n\n`,
        `data: ${JSON.stringify({
          type: "job-complete",
          data: { success: true, sessionId: "sess-sse-3", status: "completed", output: [] },
        })}
\n\n`,
        "data: [DONE]\n\n",
      ]),
    ) as unknown as typeof fetch;

    const { execute, writer } = buildStreamingTool();
    await execute({ prompt: "go" }, TOOL_CALL_OPTS);

    // data-session-start is forwarded as nested-chunk even though reducer ignores it
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(writer.write).toHaveBeenCalledWith({
      type: "data-nested-chunk",
      data: {
        parentToolCallId: "test-call",
        chunk: { type: "data-session-start", data: { sessionId: "sess-x" } },
      },
    });
  });

  it("returns failure on job-error event", async () => {
    globalThis.fetch = vi.fn(() =>
      makeMockFetchResponse([
        `data: ${JSON.stringify({ type: "job-error", data: { error: "workspace not found" } })}
\n\n`,
        "data: [DONE]\n\n",
      ]),
    ) as unknown as typeof fetch;

    const { execute, logger } = buildStreamingTool();
    const result = await execute({ prompt: "go" }, TOOL_CALL_OPTS);

    expect(result).toEqual({ success: false, error: "workspace not found" });
    expect(logger.error).toHaveBeenCalled();
  });

  it("returns failure on HTTP error with parsed body", async () => {
    globalThis.fetch = vi.fn(() =>
      makeMockFetchResponse([], {
        ok: false,
        status: 404,
        jsonBody: { error: "Workspace not found: ws-test" },
      }),
    ) as unknown as typeof fetch;

    const { execute, logger } = buildStreamingTool();
    const result = await execute({ prompt: "go" }, TOOL_CALL_OPTS);

    expect(result).toEqual({
      success: false,
      statusCode: 404,
      error: "Workspace not found: ws-test",
    });
    expect(logger.error).toHaveBeenCalled();
  });

  it("returns failure on HTTP error when json parse fails", async () => {
    globalThis.fetch = vi.fn(() =>
      makeMockFetchResponse([], { ok: false, status: 500 }),
    ) as unknown as typeof fetch;

    const { execute } = buildStreamingTool();
    const result = await execute({ prompt: "go" }, TOOL_CALL_OPTS);

    expect(result).toEqual({ success: false, statusCode: 500, error: "HTTP 500" });
  });

  it("returns failure when response has no body", async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, body: null } as unknown as Response),
    );

    const { execute } = buildStreamingTool();
    const result = await execute({ prompt: "go" }, TOOL_CALL_OPTS);

    expect(result).toEqual({ success: false, error: "SSE response has no body" });
  });

  it("returns failure when stream ends without job-complete", async () => {
    globalThis.fetch = vi.fn(() =>
      makeMockFetchResponse([
        `data: ${JSON.stringify({ type: "tool-input-start", toolCallId: "tc1", toolName: "orphan" })}
\n\n`,
        "data: [DONE]\n\n",
      ]),
    ) as unknown as typeof fetch;

    const { execute, logger, writer } = buildStreamingTool();
    const result = await execute({ prompt: "go" }, TOOL_CALL_OPTS);

    expect(result).toEqual({ success: false, error: "Job stream ended without completion signal" });
    expect(writer.write).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("skips non-JSON data lines silently", async () => {
    globalThis.fetch = vi.fn(() =>
      makeMockFetchResponse([
        "data: not valid json\n\n",
        `data: ${JSON.stringify({
          type: "job-complete",
          data: { success: true, sessionId: "sess-sse-4", status: "completed", output: [] },
        })}
\n\n`,
        "data: [DONE]\n\n",
      ]),
    ) as unknown as typeof fetch;

    const { execute } = buildStreamingTool();
    const result = await execute({ prompt: "go" }, TOOL_CALL_OPTS);

    expect(result).toEqual({
      success: true,
      sessionId: "sess-sse-4",
      status: "completed",
      output: [],
    });
  });

  it("passes streamId in SSE body when parentStreamId is provided", async () => {
    const logger = makeLogger();
    const writer: UIMessageStreamWriter<AtlasUIMessage> = { write: vi.fn(), merge: vi.fn(), onError: vi.fn() };
    createJobTools(
      "ws-test",
      { "deploy-app": makeJob({ triggers: [{ signal: "deploy-signal" }] }) },
      {},
      logger,
      "parent-stream-123",
      writer,
    );

    globalThis.fetch = vi.fn(() =>
      makeMockFetchResponse([
        `data: ${JSON.stringify({
          type: "job-complete",
          data: { success: true, sessionId: "sess-sse-5", status: "completed", output: [] },
        })}
\n\n`,
        "data: [DONE]\n\n",
      ]),
    ) as unknown as typeof fetch;

    const tools = createJobTools(
      "ws-test",
      { "deploy-app": makeJob({ triggers: [{ signal: "deploy-signal" }] }) },
      {},
      logger,
      "parent-stream-123",
      writer,
    );
    const execute = tools["deploy-app"]?.execute;
    if (!execute) throw new Error("no execute");

    await execute({ prompt: "go" }, TOOL_CALL_OPTS);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ payload: { prompt: "go" }, streamId: "parent-stream-123" }),
      }),
    );
  });

  it("passes abortSignal to fetch when provided", async () => {
    const abortController = new AbortController();
    const logger = makeLogger();
    const writer: UIMessageStreamWriter<AtlasUIMessage> = { write: vi.fn(), merge: vi.fn(), onError: vi.fn() };

    globalThis.fetch = vi.fn(() =>
      makeMockFetchResponse([
        `data: ${JSON.stringify({
          type: "job-complete",
          data: { success: true, sessionId: "sess-sse-6", status: "completed", output: [] },
        })}
\n\n`,
        "data: [DONE]\n\n",
      ]),
    ) as unknown as typeof fetch;

    const tools = createJobTools(
      "ws-test",
      { "deploy-app": makeJob({ triggers: [{ signal: "deploy-signal" }] }) },
      {},
      logger,
      undefined,
      writer,
      abortController.signal,
    );
    const execute = tools["deploy-app"]?.execute;
    if (!execute) throw new Error("no execute");

    await execute({ prompt: "go" }, TOOL_CALL_OPTS);

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs?.[1]).toHaveProperty("signal", abortController.signal);
  });
});
