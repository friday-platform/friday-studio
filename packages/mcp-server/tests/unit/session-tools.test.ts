/**
 * Unit tests for session tools
 * Tests session management operations with mocked daemon API calls
 */

import { assert, assertEquals, assertExists, assertRejects } from "@std/assert";
import { createSuccessResponse } from "../../src/tools/types.ts";

// Mock logger for testing
const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// Extract core logic from session describe tool
async function sessionDescribeToolLogic(ctx: { daemonUrl: string; logger: any }, params: {
  sessionId: string;
}) {
  ctx.logger.info("MCP session_describe called", { sessionId: params.sessionId });

  try {
    const response = await fetch(`${ctx.daemonUrl}/api/sessions/${params.sessionId}`);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
      );
    }

    const session = await response.json();

    return createSuccessResponse({
      session,
      source: "daemon_api",
    });
  } catch (error) {
    ctx.logger.error("MCP session_describe failed", { sessionId: params.sessionId, error });
    throw error;
  }
}

// Extract core logic from session cancel tool
async function sessionCancelToolLogic(ctx: { daemonUrl: string; logger: any }, params: {
  sessionId: string;
}) {
  ctx.logger.info("MCP session_cancel called", { sessionId: params.sessionId });

  try {
    const response = await fetch(`${ctx.daemonUrl}/api/sessions/${params.sessionId}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
      );
    }

    const result = await response.json();

    return createSuccessResponse({
      success: true,
      sessionId: params.sessionId,
      message: result.message,
      source: "daemon_api",
    });
  } catch (error) {
    ctx.logger.error("MCP session_cancel failed", { sessionId: params.sessionId, error });
    throw error;
  }
}

// Mock data for sessions
const mockSessionDetails = {
  id: "session-123",
  workspaceId: "workspace-1",
  status: "running",
  startTime: "2023-01-01T00:00:00Z",
  endTime: null,
  jobName: "test-job",
  progress: 0.5,
  logs: [
    { timestamp: "2023-01-01T00:00:01Z", level: "info", message: "Session started" },
    { timestamp: "2023-01-01T00:00:02Z", level: "info", message: "Processing..." },
  ],
  metadata: {
    triggeredBy: "user",
    parameters: { key: "value" },
  },
};

const mockCompletedSession = {
  id: "session-456",
  workspaceId: "workspace-1",
  status: "completed",
  startTime: "2023-01-01T00:00:00Z",
  endTime: "2023-01-01T00:05:00Z",
  jobName: "test-job",
  progress: 1.0,
  logs: [
    { timestamp: "2023-01-01T00:00:01Z", level: "info", message: "Session started" },
    { timestamp: "2023-01-01T00:05:00Z", level: "info", message: "Session completed" },
  ],
  metadata: {
    triggeredBy: "user",
    parameters: { key: "value" },
  },
};

const mockFailedSession = {
  id: "session-789",
  workspaceId: "workspace-1",
  status: "failed",
  startTime: "2023-01-01T00:00:00Z",
  endTime: "2023-01-01T00:03:00Z",
  jobName: "test-job",
  progress: 0.3,
  error: "Job execution failed",
  logs: [
    { timestamp: "2023-01-01T00:00:01Z", level: "info", message: "Session started" },
    { timestamp: "2023-01-01T00:03:00Z", level: "error", message: "Job execution failed" },
  ],
  metadata: {
    triggeredBy: "user",
    parameters: { key: "value" },
  },
};

const mockCancelResponse = {
  message: "Session cancelled successfully",
  sessionId: "session-123",
  timestamp: "2023-01-01T00:05:00Z",
};

// Create mock fetch function
function createMockFetch(
  responseData: any,
  options: { ok?: boolean; status?: number; statusText?: string } = {},
) {
  return () =>
    Promise.resolve({
      ok: options.ok ?? true,
      status: options.status ?? 200,
      statusText: options.statusText ?? "OK",
      json: () => Promise.resolve(responseData),
    } as Response);
}

// Test Cases for Session Describe Tool
Deno.test("session describe tool - describes session successfully", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch(mockSessionDetails);

  try {
    const ctx = { daemonUrl: "http://localhost:8080", logger: mockLogger };
    const result = await sessionDescribeToolLogic(ctx, { sessionId: "session-123" });

    assertExists(result);
    assertEquals(result.content[0].type, "text");

    const responseData = JSON.parse(result.content[0].text);
    assertEquals(responseData.session.id, "session-123");
    assertEquals(responseData.session.status, "running");
    assertEquals(responseData.session.jobName, "test-job");
    assertEquals(responseData.session.progress, 0.5);
    assertEquals(responseData.source, "daemon_api");
    assertExists(responseData.session.logs);
    assertExists(responseData.session.metadata);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("session describe tool - handles session not found", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch(
    { error: "Session not found" },
    { ok: false, status: 404, statusText: "Not Found" },
  );

  try {
    const ctx = { daemonUrl: "http://localhost:8080", logger: mockLogger };

    await assertRejects(
      async () => await sessionDescribeToolLogic(ctx, { sessionId: "nonexistent-session" }),
      Error,
      "Daemon API error: 404 - Session not found",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("session describe tool - handles completed sessions", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch(mockCompletedSession);

  try {
    const ctx = { daemonUrl: "http://localhost:8080", logger: mockLogger };
    const result = await sessionDescribeToolLogic(ctx, { sessionId: "session-456" });

    assertExists(result);
    const responseData = JSON.parse(result.content[0].text);
    assertEquals(responseData.session.status, "completed");
    assertEquals(responseData.session.progress, 1.0);
    assertExists(responseData.session.endTime);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("session describe tool - handles failed sessions", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch(mockFailedSession);

  try {
    const ctx = { daemonUrl: "http://localhost:8080", logger: mockLogger };
    const result = await sessionDescribeToolLogic(ctx, { sessionId: "session-789" });

    assertExists(result);
    const responseData = JSON.parse(result.content[0].text);
    assertEquals(responseData.session.status, "failed");
    assertEquals(responseData.session.error, "Job execution failed");
    assertExists(responseData.session.endTime);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Test Cases for Session Cancel Tool
Deno.test("session cancel tool - cancels session successfully", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch(mockCancelResponse);

  try {
    const ctx = { daemonUrl: "http://localhost:8080", logger: mockLogger };
    const result = await sessionCancelToolLogic(ctx, { sessionId: "session-123" });

    assertExists(result);
    assertEquals(result.content[0].type, "text");

    const responseData = JSON.parse(result.content[0].text);
    assertEquals(responseData.success, true);
    assertEquals(responseData.sessionId, "session-123");
    assertEquals(responseData.message, "Session cancelled successfully");
    assertEquals(responseData.source, "daemon_api");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("session cancel tool - handles session not found", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch(
    { error: "Session not found" },
    { ok: false, status: 404, statusText: "Not Found" },
  );

  try {
    const ctx = { daemonUrl: "http://localhost:8080", logger: mockLogger };

    await assertRejects(
      async () => await sessionCancelToolLogic(ctx, { sessionId: "nonexistent-session" }),
      Error,
      "Daemon API error: 404 - Session not found",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("session cancel tool - handles session already completed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch(
    { error: "Cannot cancel completed session" },
    { ok: false, status: 400, statusText: "Bad Request" },
  );

  try {
    const ctx = { daemonUrl: "http://localhost:8080", logger: mockLogger };

    await assertRejects(
      async () => await sessionCancelToolLogic(ctx, { sessionId: "session-456" }),
      Error,
      "Daemon API error: 400 - Cannot cancel completed session",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("session cancel tool - handles session already cancelled", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch(
    { error: "Session already cancelled" },
    { ok: false, status: 400, statusText: "Bad Request" },
  );

  try {
    const ctx = { daemonUrl: "http://localhost:8080", logger: mockLogger };

    await assertRejects(
      async () => await sessionCancelToolLogic(ctx, { sessionId: "session-789" }),
      Error,
      "Daemon API error: 400 - Session already cancelled",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// Test Cases for Error Handling
Deno.test("session tools - handle network errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("Network error"));

  try {
    const ctx = { daemonUrl: "http://localhost:8080", logger: mockLogger };

    await assertRejects(
      async () => await sessionDescribeToolLogic(ctx, { sessionId: "session-123" }),
      Error,
      "Network error",
    );

    await assertRejects(
      async () => await sessionCancelToolLogic(ctx, { sessionId: "session-123" }),
      Error,
      "Network error",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("session tools - handle server errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch(
    { error: "Internal server error" },
    { ok: false, status: 500, statusText: "Internal Server Error" },
  );

  try {
    const ctx = { daemonUrl: "http://localhost:8080", logger: mockLogger };

    await assertRejects(
      async () => await sessionDescribeToolLogic(ctx, { sessionId: "session-123" }),
      Error,
      "Daemon API error: 500 - Internal server error",
    );

    await assertRejects(
      async () => await sessionCancelToolLogic(ctx, { sessionId: "session-123" }),
      Error,
      "Daemon API error: 500 - Internal server error",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("session tools - handle malformed JSON responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve({
      ok: false,
      status: 400,
      statusText: "Bad Request",
      json: () => Promise.reject(new Error("Invalid JSON")),
    } as unknown as Response);

  try {
    const ctx = { daemonUrl: "http://localhost:8080", logger: mockLogger };

    await assertRejects(
      async () => await sessionDescribeToolLogic(ctx, { sessionId: "session-123" }),
      Error,
      "Daemon API error: 400 - Bad Request",
    );

    await assertRejects(
      async () => await sessionCancelToolLogic(ctx, { sessionId: "session-123" }),
      Error,
      "Daemon API error: 400 - Bad Request",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
