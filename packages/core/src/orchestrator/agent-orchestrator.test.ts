import { logger } from "@atlas/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentOrchestrator } from "./agent-orchestrator.ts";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Capture the onerror handler that the orchestrator attaches to the transport
let capturedTransportOnerror: ((error: Error) => void) | undefined;
// Capture the onclose handler that Protocol.connect() wraps
let capturedTransportOnclose: (() => void) | undefined;

const mockTransport = {
  close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  get sessionId() {
    return "mock-session-id";
  },
  set onerror(handler: ((error: Error) => void) | undefined) {
    capturedTransportOnerror = handler;
  },
  get onerror() {
    return capturedTransportOnerror;
  },
  set onclose(handler: (() => void) | undefined) {
    capturedTransportOnclose = handler;
  },
  get onclose() {
    return capturedTransportOnclose;
  },
  set onmessage(_handler: unknown) {
    // noop
  },
  start: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  send: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
};

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class {
    constructor() {
      // biome-ignore lint/correctness/noConstructorReturn: mock must return exact object for vi.fn tracking
      return mockTransport;
    }
  },
}));

// Track callTool calls and allow controlling their resolution
let callToolResolve: ((value: unknown) => void) | undefined;
let callToolReject: ((error: Error) => void) | undefined;

const mockClient = {
  // deno-lint-ignore require-await
  connect: vi.fn<(transport: unknown) => Promise<void>>(async (transport) => {
    // Protocol.connect() wraps transport.onerror to also call Protocol._onerror
    // and wraps transport.onclose to also call Protocol._onclose (which rejects
    // all pending requests). Simulate this wrapping behavior.
    const userOnerror = (transport as typeof mockTransport).onerror;
    (transport as typeof mockTransport).onerror = (error: Error) => {
      userOnerror?.(error);
    };

    const userOnclose = (transport as typeof mockTransport).onclose;
    (transport as typeof mockTransport).onclose = () => {
      userOnclose?.();
      // Protocol._onclose rejects all pending response handlers
      // In real SDK this iterates _responseHandlers and calls each with ConnectionClosed
      // We simulate this by rejecting the pending callTool promise
      if (callToolReject) {
        callToolReject(new Error("MCP error -1: Connection closed"));
        callToolReject = undefined;
      }
    };
  }),
  listTools: vi.fn<() => Promise<{ tools: unknown[] }>>().mockResolvedValue({ tools: [] }),
  callTool: vi.fn<() => Promise<unknown>>(() => {
    return new Promise((resolve, reject) => {
      callToolResolve = resolve;
      callToolReject = reject;
    });
  }),
  setNotificationHandler: vi.fn(),
  close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
};

vi.mock("@modelcontextprotocol/sdk/client", () => ({
  Client: class {
    constructor() {
      // biome-ignore lint/correctness/noConstructorReturn: mock must return exact object for vi.fn tracking
      return mockClient;
    }
  },
}));

function assertOnerrorCaptured(
  handler: typeof capturedTransportOnerror,
): asserts handler is (error: Error) => void {
  if (!handler) throw new Error("Expected capturedTransportOnerror to be set");
}

function assertResolverCaptured(
  resolver: typeof callToolResolve,
): asserts resolver is (value: unknown) => void {
  if (!resolver) throw new Error("Expected callToolResolve to be set");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentOrchestrator - MCP transport fatal error handling", () => {
  let orchestrator: AgentOrchestrator;
  const testLogger = logger.child({ component: "test" });

  beforeEach(() => {
    vi.clearAllMocks();
    capturedTransportOnerror = undefined;
    capturedTransportOnclose = undefined;
    callToolResolve = undefined;
    callToolReject = undefined;

    orchestrator = new AgentOrchestrator(
      { agentsServerUrl: "http://localhost:8080/agents", requestTimeoutMs: 300000 },
      testLogger,
    );
  });

  afterEach(async () => {
    await orchestrator.shutdown();
  });

  it("closes transport and rejects pending callTool on max reconnection attempts exceeded", async () => {
    // Start an agent execution — this creates the MCP session and calls callTool
    const executionPromise = orchestrator.executeAgent("test-agent", "hello", {
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });

    // Wait for session setup to complete (connect + listTools)
    await vi.waitFor(() => {
      expect(mockClient.callTool).toHaveBeenCalled();
    });

    // Verify our onerror handler was captured before Protocol.connect() wrapped it
    assertOnerrorCaptured(capturedTransportOnerror);

    // Simulate: pod OOMKilled → SSE stream dies → SDK retries exhausted
    capturedTransportOnerror(new Error("Maximum reconnection attempts (2) exceeded."));

    // The onerror handler should have called transport.close()
    expect(mockTransport.close).toHaveBeenCalled();

    // transport.close() triggers onclose, which rejects callTool via Protocol._onclose
    // Simulate the close callback chain
    capturedTransportOnclose?.();

    // The executeAgent promise should now resolve with an error result (not hang)
    const result = await executionPromise;

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toContain("Connection closed");
    }
  });

  it("cleans up session from mcpSessions map on fatal error", async () => {
    const executionPromise = orchestrator.executeAgent("test-agent", "hello", {
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });

    await vi.waitFor(() => {
      expect(mockClient.callTool).toHaveBeenCalled();
    });

    // Session should be in the map now
    // biome-ignore lint/complexity/useLiteralKeys: accessing private property in test
    expect(orchestrator["mcpSessions"].has("session-1")).toBe(true);

    // Simulate fatal error
    assertOnerrorCaptured(capturedTransportOnerror);
    capturedTransportOnerror(new Error("Maximum reconnection attempts (2) exceeded."));
    capturedTransportOnclose?.();

    // Session should be cleaned up
    // biome-ignore lint/complexity/useLiteralKeys: accessing private property in test
    expect(orchestrator["mcpSessions"].has("session-1")).toBe(false);

    await executionPromise;
  });

  it("does NOT close transport on transient SSE disconnect (allows SDK retry)", async () => {
    const executionPromise = orchestrator.executeAgent("test-agent", "hello", {
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });

    await vi.waitFor(() => {
      expect(mockClient.callTool).toHaveBeenCalled();
    });

    // Simulate: transient SSE disconnect (SDK will retry, we should NOT close)
    assertOnerrorCaptured(capturedTransportOnerror);
    capturedTransportOnerror(new Error("SSE stream disconnected: network error"));

    // transport.close should NOT have been called — SDK should retry
    expect(mockTransport.close).not.toHaveBeenCalled();

    // Session should still be in the map
    // biome-ignore lint/complexity/useLiteralKeys: accessing private property in test
    expect(orchestrator["mcpSessions"].has("session-1")).toBe(true);

    // Resolve the callTool to let the test complete cleanly
    assertResolverCaptured(callToolResolve);
    callToolResolve({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            type: "completed",
            result: {
              agentId: "test-agent",
              timestamp: new Date().toISOString(),
              input: "hello",
              ok: true,
              durationMs: 100,
              data: {},
            },
          }),
        },
      ],
    });

    await executionPromise;
  });

  it("closes transport on 'Failed to reconnect SSE stream' error", async () => {
    const executionPromise = orchestrator.executeAgent("test-agent", "hello", {
      sessionId: "session-1",
      workspaceId: "workspace-1",
    });

    await vi.waitFor(() => {
      expect(mockClient.callTool).toHaveBeenCalled();
    });

    // Simulate: reconnection attempt itself failed
    assertOnerrorCaptured(capturedTransportOnerror);
    capturedTransportOnerror(new Error("Failed to reconnect SSE stream: ECONNREFUSED"));

    expect(mockTransport.close).toHaveBeenCalled();

    capturedTransportOnclose?.();

    const result = await executionPromise;
    expect(result.ok).toBe(false);
  });
});
