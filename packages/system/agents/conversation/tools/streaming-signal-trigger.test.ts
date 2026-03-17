import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStreamingSignalTriggerTool } from "./streaming-signal-trigger.ts";

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Builds a minimal fake SSE stream from an array of event objects.
 * Each event is encoded as `data: {"type":"...","data":{...}}\n\n`,
 * followed by `data: [DONE]\n\n`.
 */
function makeSSEStream(events: Array<Record<string, unknown>>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    },
  });
}

/** Minimal workspace JSON response for the config fetch. */
const WORKSPACE_RESPONSE = { config: { signals: {} } };

const mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

const SESSION = {
  sessionId: "sess-1",
  workspaceId: "parent-ws",
  streamId: "stream-1",
  daemonUrl: "http://localhost:9999",
};

/**
 * Routes fetch calls by URL: workspace config GETs return JSON,
 * signal trigger POSTs return the provided Response.
 */
function mockFetchWithSignalResponse(signalResponse: Response): typeof fetch {
  return (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/signals/")) {
      return Promise.resolve(signalResponse);
    }
    return Promise.resolve(
      new Response(JSON.stringify(WORKSPACE_RESPONSE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
}

// =============================================================================
// Tests
// =============================================================================

describe("streaming-signal-trigger", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("forwards allowlisted chunk types and drops blocked/unknown types", async () => {
    const writeFn = vi.fn();
    const mockWriter = { write: writeFn } as unknown as import("ai").UIMessageStreamWriter;

    globalThis.fetch = mockFetchWithSignalResponse(
      new Response(
        makeSSEStream([
          { type: "data-fsm-action-execution", data: { action: "test" } },
          { type: "data-session-finish", data: {} },
          { type: "totally-unknown-event", data: { foo: 1 } },
          { type: "text-delta", id: "p-1", delta: "hello" },
          { type: "data-agent-start", data: { agentId: "a1", task: "t1" } },
          {
            type: "job-complete",
            data: { success: true, sessionId: "inner-sess", status: "completed" },
          },
        ]),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    );

    const tool = createStreamingSignalTriggerTool(
      mockWriter,
      SESSION,
      mockLogger as unknown as import("@atlas/logger").Logger,
    );

    // biome-ignore lint/style/noNonNullAssertion: tool always provides execute
    const result = await tool.execute!(
      { workspaceId: "test-ws", signalId: "test-signal" },
      { toolCallId: "tc-1", messages: [], abortSignal: undefined },
    );

    if (Symbol.asyncIterator in (result as object)) throw new Error("Unexpected async iterable");

    const writtenTypes = writeFn.mock.calls.map(
      (call: unknown[]) => (call[0] as { type: string }).type,
    );

    expect(writtenTypes).toContain("data-tool-progress");
    expect(writtenTypes).toContain("text-delta");
    expect(writtenTypes).toContain("data-agent-start");

    for (const t of writtenTypes) {
      expect(t).not.toMatch(/^data-fsm-/);
      expect(t).not.toMatch(/^data-session-/);
    }
    expect(writtenTypes).not.toContain("totally-unknown-event");

    expect(result).toEqual({ success: true, sessionId: "inner-sess", status: "completed" });
  });

  it("returns error result on non-200 HTTP response", async () => {
    const mockWriter = { write: vi.fn() } as unknown as import("ai").UIMessageStreamWriter;

    globalThis.fetch = mockFetchWithSignalResponse(
      new Response(JSON.stringify({ error: "Workspace not found" }), {
        status: 404,
        statusText: "Not Found",
        headers: { "Content-Type": "application/json" },
      }),
    );

    const tool = createStreamingSignalTriggerTool(
      mockWriter,
      SESSION,
      mockLogger as unknown as import("@atlas/logger").Logger,
    );

    // biome-ignore lint/style/noNonNullAssertion: tool always provides execute
    const result = await tool.execute!(
      { workspaceId: "test-ws", signalId: "missing-signal" },
      { toolCallId: "tc-2", messages: [], abortSignal: undefined },
    );

    expect(result).toEqual({
      success: false,
      sessionId: "",
      status: "error",
      error: "Workspace not found",
    });
  });

  it("returns error result when stream contains job-error event", async () => {
    const mockWriter = { write: vi.fn() } as unknown as import("ai").UIMessageStreamWriter;

    globalThis.fetch = mockFetchWithSignalResponse(
      new Response(
        makeSSEStream([
          { type: "text-delta", id: "p-1", delta: "partial output" },
          { type: "job-error", data: { error: "Agent exceeded step limit" } },
        ]),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    );

    const tool = createStreamingSignalTriggerTool(
      mockWriter,
      SESSION,
      mockLogger as unknown as import("@atlas/logger").Logger,
    );

    // biome-ignore lint/style/noNonNullAssertion: tool always provides execute
    const result = await tool.execute!(
      { workspaceId: "test-ws", signalId: "test-signal" },
      { toolCallId: "tc-3", messages: [], abortSignal: undefined },
    );

    expect(result).toEqual({
      success: false,
      sessionId: "",
      status: "error",
      error: "Agent exceeded step limit",
    });
  });

  it("returns validation error and skips SSE request when payload violates signal schema", async () => {
    const mockWriter = { write: vi.fn() } as unknown as import("ai").UIMessageStreamWriter;

    const workspaceWithSchema = {
      config: {
        signals: {
          "test-signal": {
            provider: "http",
            description: "signal with required field",
            config: { path: "/test" },
            schema: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        },
      },
    };

    const fetchCalls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      fetchCalls.push(url);
      // Only the workspace config GET should happen
      return Promise.resolve(
        new Response(JSON.stringify(workspaceWithSchema), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch;

    const tool = createStreamingSignalTriggerTool(
      mockWriter,
      SESSION,
      mockLogger as unknown as import("@atlas/logger").Logger,
    );

    // biome-ignore lint/style/noNonNullAssertion: tool always provides execute
    const result = await tool.execute!(
      { workspaceId: "test-ws", signalId: "test-signal", payload: {} },
      { toolCallId: "tc-5", messages: [], abortSignal: undefined },
    );

    expect(result).toEqual({
      success: false,
      sessionId: "",
      status: "error",
      error: expect.stringContaining("Payload validation failed"),
    });

    // Only the workspace config fetch should have been called, not the signal SSE endpoint
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain("/api/workspaces/");
    expect(fetchCalls[0]).not.toContain("/signals/");
  });

  it("returns cancelled result without fetching when abort signal is pre-aborted", async () => {
    const mockWriter = { write: vi.fn() } as unknown as import("ai").UIMessageStreamWriter;
    const fetchSpy = vi.fn<typeof fetch>();
    globalThis.fetch = fetchSpy;

    const tool = createStreamingSignalTriggerTool(
      mockWriter,
      SESSION,
      mockLogger as unknown as import("@atlas/logger").Logger,
      AbortSignal.abort(),
    );

    // biome-ignore lint/style/noNonNullAssertion: tool always provides execute
    const result = await tool.execute!(
      { workspaceId: "test-ws", signalId: "test-signal" },
      { toolCallId: "tc-4", messages: [], abortSignal: undefined },
    );

    expect(result).toEqual({
      success: false,
      sessionId: "",
      status: "cancelled",
      error: "Signal trigger cancelled",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
