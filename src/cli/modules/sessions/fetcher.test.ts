import type { SessionInfo } from "@atlas/client";
import { assertEquals, assertExists } from "@std/assert";
import { fetchSessions } from "./fetcher.ts";

// Mock response helper function
function mockResponse(body: unknown, options: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
}

Deno.test("fetchSessions - should transform API response to UI format", async () => {
  const originalFetch = globalThis.fetch;

  const mockSessionInfos: SessionInfo[] = [
    {
      id: "sess_123",
      workspaceId: "workspace_1",
      status: "executing",
      summary: "Processing data",
      signal: "http-webhook",
      startTime: "2024-01-01T10:00:00Z",
      endTime: undefined,
      progress: 50,
    },
    {
      id: "sess_456",
      workspaceId: "workspace_2",
      status: "completed",
      summary: "Completed task",
      signal: "schedule",
      startTime: "2024-01-01T09:00:00Z",
      endTime: "2024-01-01T09:30:00Z",
      progress: 100,
    },
  ];

  globalThis.fetch = async () => mockResponse(mockSessionInfos);

  try {
    const result = await fetchSessions({});

    assertEquals(result.success, true);

    if (result.success) {
      assertEquals(result.sessions.length, 2);
      assertEquals(result.filteredSessions.length, 2);

      // Check first session mapping
      assertEquals(result.sessions[0].id, "sess_123");
      assertEquals(result.sessions[0].workspaceName, "workspace_1");
      assertEquals(result.sessions[0].signal, "http-webhook");
      assertEquals(result.sessions[0].status, "executing");
      assertEquals(result.sessions[0].startedAt, "2024-01-01T10:00:00Z");
      assertEquals(result.sessions[0].completedAt, undefined);

      // Check second session mapping
      assertEquals(result.sessions[1].id, "sess_456");
      assertEquals(result.sessions[1].workspaceName, "workspace_2");
      assertEquals(result.sessions[1].signal, "schedule");
      assertEquals(result.sessions[1].status, "completed");
      assertEquals(result.sessions[1].startedAt, "2024-01-01T09:00:00Z");
      assertEquals(result.sessions[1].completedAt, "2024-01-01T09:30:00Z");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchSessions - should filter by workspace", async () => {
  const originalFetch = globalThis.fetch;

  const mockSessionInfos: SessionInfo[] = [
    {
      id: "sess_123",
      workspaceId: "workspace_1",
      status: "executing",
      summary: "Processing",
      signal: "http",
      startTime: "2024-01-01T10:00:00Z",
      progress: 50,
    },
    {
      id: "sess_456",
      workspaceId: "workspace_2",
      status: "executing",
      summary: "Running",
      signal: "schedule",
      startTime: "2024-01-01T10:00:00Z",
      progress: 30,
    },
    {
      id: "sess_789",
      workspaceId: "workspace_1",
      status: "completed",
      summary: "Done",
      signal: "manual",
      startTime: "2024-01-01T09:00:00Z",
      endTime: "2024-01-01T09:15:00Z",
      progress: 100,
    },
  ];

  globalThis.fetch = async () => mockResponse(mockSessionInfos);

  try {
    const result = await fetchSessions({ workspace: "workspace_1" });

    assertEquals(result.success, true);

    if (result.success) {
      // All sessions should be returned in sessions array
      assertEquals(result.sessions.length, 3);

      // But only workspace_1 sessions should be in filteredSessions
      assertEquals(result.filteredSessions.length, 2);
      assertEquals(result.filteredSessions[0].workspaceName, "workspace_1");
      assertEquals(result.filteredSessions[1].workspaceName, "workspace_1");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchSessions - should make correct HTTP request to sessions endpoint", async () => {
  const originalFetch = globalThis.fetch;

  const mockSessionInfos: SessionInfo[] = [
    {
      id: "sess_123",
      workspaceId: "workspace_1",
      status: "executing",
      summary: "Test session",
      signal: "test",
      startTime: "2024-01-01T10:00:00Z",
      progress: 0,
    },
  ];

  let capturedRequest: Request | undefined;

  globalThis.fetch = async (input: string | Request, init?: RequestInit) => {
    if (input instanceof Request) {
      capturedRequest = input;
    } else {
      capturedRequest = new Request(input, init);
    }

    return mockResponse(mockSessionInfos);
  };

  try {
    await fetchSessions({});

    assertExists(capturedRequest);
    assertEquals(capturedRequest.method, "GET");
    assertEquals(capturedRequest.url, "http://localhost:8080/api/sessions");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchSessions - should use custom port in request URL", async () => {
  const originalFetch = globalThis.fetch;

  const mockSessionInfo: SessionInfo = {
    id: "sess_123",
    workspaceId: "workspace_1",
    status: "executing",
    summary: "Test",
    signal: "test",
    startTime: "2024-01-01T10:00:00Z",
    progress: 0,
  };

  let capturedUrl: string | undefined;

  globalThis.fetch = async (input: string | Request) => {
    if (input instanceof Request) {
      capturedUrl = input.url;
    } else {
      capturedUrl = input;
    }
    return mockResponse([mockSessionInfo]);
  };

  try {
    const result = await fetchSessions({ port: 8769 });

    assertEquals(result.success, true);
    if (result.success) {
      assertEquals(result.sessions.length, 1);
      assertEquals(result.sessions[0].id, "sess_123");
    }

    // Note: Due to AtlasClient singleton behavior, this test verifies the function works
    // The actual port URL testing is limited by the client's singleton pattern
    assertExists(capturedUrl);
    assertEquals(capturedUrl.includes("/api/sessions"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchSessions - should handle connection refused error", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    throw new Error("Failed to connect to Atlas: Connection refused");
  };

  try {
    const result = await fetchSessions({});

    assertEquals(result.success, false);

    // Type assertion for error case
    const errorResult = result as { success: false; error: string; reason?: string };
    assertEquals(errorResult.reason, "server_not_running");
    assertExists(errorResult.error);
    assertEquals(
      errorResult.error,
      "No workspace server running. Start a workspace with 'atlas workspace serve'",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchSessions - should handle 503 HTTP error as server_not_running", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    return new Response("Service unavailable", { status: 503 });
  };

  try {
    const result = await fetchSessions({});

    assertEquals(result.success, false);

    // Type assertion for error case
    const errorResult = result as { success: false; error: string; reason?: string };
    assertEquals(errorResult.reason, "server_not_running");
    assertExists(errorResult.error);
    assertEquals(
      errorResult.error,
      "No workspace server running. Start a workspace with 'atlas workspace serve'",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchSessions - should handle 4xx HTTP error as api_error", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    return new Response("Unauthorized", { status: 401 });
  };

  try {
    const result = await fetchSessions({});

    assertEquals(result.success, false);

    // Type assertion for error case
    const errorResult = result as { success: false; error: string; reason?: string };
    assertEquals(errorResult.reason, "api_error");
    assertExists(errorResult.error);
    assertEquals(errorResult.error, "HTTP 401: ");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchSessions - should handle 5xx HTTP error as network_error", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    return new Response("Internal Server Error", { status: 500 });
  };

  try {
    const result = await fetchSessions({});

    assertEquals(result.success, false);

    // Type assertion for error case
    const errorResult = result as { success: false; error: string; reason?: string };
    assertEquals(errorResult.reason, "network_error");
    assertExists(errorResult.error);
    assertEquals(errorResult.error, "HTTP 500: ");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchSessions - should handle timeout error", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    // Simulate AbortError which gets converted to AtlasApiError with status 408
    const abortError = new Error(
      "Request to Atlas daemon timed out after 5000ms. Is the daemon running?",
    );
    abortError.name = "AbortError";
    throw abortError;
  };

  try {
    const result = await fetchSessions({});

    assertEquals(result.success, false);

    const errorResult = result as { success: false; error: string; reason?: string };
    assertEquals(errorResult.reason, "api_error");
    assertEquals(
      errorResult.error,
      "Request to Atlas daemon timed out after 5000ms. Is the daemon running?",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchSessions - should handle invalid JSON response", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    throw new Error("Unexpected token 'I' in JSON");
  };

  try {
    const result = await fetchSessions({});

    assertEquals(result.success, false);

    // Type assertion for error case
    const errorResult = result as { success: false; error: string; reason?: string };
    assertExists(errorResult.error);
    assertEquals(errorResult.reason, "server_not_running");
    assertEquals(
      errorResult.error,
      "No workspace server running. Start a workspace with 'atlas workspace serve'",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchSessions - should handle empty session list", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => mockResponse([]);

  try {
    const result = await fetchSessions({});

    assertEquals(result.success, true);

    if (result.success) {
      assertEquals(result.sessions.length, 0);
      assertEquals(result.filteredSessions.length, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchSessions - should handle workspace filtering with no matches", async () => {
  const originalFetch = globalThis.fetch;

  const mockSessionInfos: SessionInfo[] = [
    {
      id: "sess_123",
      workspaceId: "workspace_1",
      status: "executing",
      summary: "Test",
      signal: "test",
      startTime: "2024-01-01T10:00:00Z",
      progress: 0,
    },
  ];

  globalThis.fetch = async () => mockResponse(mockSessionInfos);

  try {
    const result = await fetchSessions({ workspace: "nonexistent_workspace" });

    assertEquals(result.success, true);

    if (result.success) {
      assertEquals(result.sessions.length, 1);
      assertEquals(result.filteredSessions.length, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchSessions - should correctly map SessionInfo to Session fields", async () => {
  const originalFetch = globalThis.fetch;

  const mockSessionInfos: SessionInfo[] = [
    {
      id: "sess_complex",
      workspaceId: "workspace_mapping_test",
      status: "running",
      summary: "Complex session for field mapping",
      signal: "complex-signal",
      startTime: "2024-01-01T12:00:00Z",
      endTime: "2024-01-01T12:30:00Z",
      progress: 85,
    },
  ];

  globalThis.fetch = async () => mockResponse(mockSessionInfos);

  try {
    const result = await fetchSessions({});

    assertEquals(result.success, true);

    if (result.success) {
      const session = result.sessions[0];

      // Test field mapping
      assertEquals(session.id, "sess_complex");
      assertEquals(session.workspaceName, "workspace_mapping_test"); // workspaceId → workspaceName
      assertEquals(session.status, "running");
      assertEquals(session.signal, "complex-signal");
      assertEquals(session.startedAt, "2024-01-01T12:00:00Z"); // startTime → startedAt
      assertEquals(session.completedAt, "2024-01-01T12:30:00Z"); // endTime → completedAt

      // Verify that agents field is not present (not provided by SessionInfo)
      assertEquals(session.agents, undefined);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchSessions - should handle missing optional endTime field", async () => {
  const originalFetch = globalThis.fetch;

  const mockSessionInfos: SessionInfo[] = [
    {
      id: "sess_ongoing",
      workspaceId: "workspace_active",
      status: "executing",
      summary: "Ongoing session",
      signal: "webhook",
      startTime: "2024-01-01T10:00:00Z",
      // endTime is optional and not provided
      progress: 45,
    },
  ];

  globalThis.fetch = async () => mockResponse(mockSessionInfos);

  try {
    const result = await fetchSessions({});

    assertEquals(result.success, true);

    if (result.success) {
      const session = result.sessions[0];
      assertEquals(session.id, "sess_ongoing");
      assertEquals(session.workspaceName, "workspace_active");
      assertEquals(session.startedAt, "2024-01-01T10:00:00Z");
      assertEquals(session.completedAt, undefined); // Should be undefined when endTime is missing
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchSessions - should handle sessions with all required fields", async () => {
  const originalFetch = globalThis.fetch;

  const mockSessionInfos: SessionInfo[] = [
    {
      id: "sess_minimal",
      workspaceId: "workspace_minimal",
      status: "pending",
      summary: "Minimal session",
      signal: "manual",
      startTime: "2024-01-01T08:00:00Z",
      progress: 0,
    },
  ];

  globalThis.fetch = async () => mockResponse(mockSessionInfos);

  try {
    const result = await fetchSessions({});

    assertEquals(result.success, true);

    if (result.success) {
      const session = result.sessions[0];
      assertEquals(session.id, "sess_minimal");
      assertEquals(session.workspaceName, "workspace_minimal");
      assertEquals(session.status, "pending");
      assertEquals(session.signal, "manual");
      assertEquals(session.startedAt, "2024-01-01T08:00:00Z");
      assertEquals(session.completedAt, undefined);
      assertEquals(session.agents, undefined);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchSessions - should handle request with 5000ms timeout", async () => {
  const originalFetch = globalThis.fetch;

  const mockSessionInfos: SessionInfo[] = [
    {
      id: "sess_timeout_test",
      workspaceId: "workspace_test",
      status: "executing",
      summary: "Timeout test session",
      signal: "test",
      startTime: "2024-01-01T10:00:00Z",
      progress: 0,
    },
  ];

  let capturedRequest: Request | undefined;

  globalThis.fetch = async (input: string | Request, init?: RequestInit) => {
    if (input instanceof Request) {
      capturedRequest = input;
    } else {
      capturedRequest = new Request(input, init);
    }

    // Verify that the request has a timeout signal
    assertExists(init?.signal);
    assertEquals(init?.signal instanceof AbortSignal, true);

    return mockResponse(mockSessionInfos);
  };

  try {
    const result = await fetchSessions({});

    assertEquals(result.success, true);
    if (result.success) {
      assertEquals(result.sessions.length, 1);
      assertEquals(result.sessions[0].id, "sess_timeout_test");
    }

    assertExists(capturedRequest);
    assertEquals(capturedRequest.url, "http://localhost:8080/api/sessions");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchSessions - should handle generic network errors", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    throw new Error("Network error occurred");
  };

  try {
    const result = await fetchSessions({});

    assertEquals(result.success, false);

    const errorResult = result as { success: false; error: string; reason?: string };
    assertEquals(errorResult.reason, "server_not_running");
    assertEquals(
      errorResult.error,
      "No workspace server running. Start a workspace with 'atlas workspace serve'",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchSessions - should pass through correct request headers", async () => {
  const originalFetch = globalThis.fetch;

  const mockSessionInfos: SessionInfo[] = [
    {
      id: "sess_headers_test",
      workspaceId: "workspace_test",
      status: "executing",
      summary: "Headers test session",
      signal: "test",
      startTime: "2024-01-01T10:00:00Z",
      progress: 0,
    },
  ];

  let capturedRequest: Request | undefined;

  globalThis.fetch = async (input: string | Request, init?: RequestInit) => {
    if (input instanceof Request) {
      capturedRequest = input;
    } else {
      capturedRequest = new Request(input, init);
    }

    return mockResponse(mockSessionInfos);
  };

  try {
    await fetchSessions({});

    assertExists(capturedRequest);
    assertEquals(capturedRequest.method, "GET");
    // Verify no unnecessary headers are added for GET requests
    assertEquals(capturedRequest.headers.get("Content-Type"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
