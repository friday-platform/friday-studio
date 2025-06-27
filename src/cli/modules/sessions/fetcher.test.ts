import { assertEquals, assertExists } from "@std/assert";
import { fetchSessions } from "./fetcher.ts";

// Since we can't easily mock the singleton getAtlasClient function that's called inside fetchSessions,
// we'll run integration-style tests with a mock server instead

Deno.test("fetchSessions - integration test with mock server", async () => {
  // Create a simple mock server
  const mockSessions = [
    {
      id: "sess_123",
      workspaceId: "workspace_1",
      status: "active",
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

  const server = Deno.serve(
    { port: 8765, hostname: "127.0.0.1" },
    (req) => {
      const url = new URL(req.url);

      if (url.pathname === "/api/sessions" && req.method === "GET") {
        return new Response(JSON.stringify(mockSessions), {
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  );

  try {
    const result = await fetchSessions({ port: 8765 });

    assertEquals(result.success, true);

    if (result.success) {
      assertEquals(result.sessions.length, 2);
      assertEquals(result.filteredSessions.length, 2);

      // Check first session mapping
      assertEquals(result.sessions[0].id, "sess_123");
      assertEquals(result.sessions[0].workspaceName, "workspace_1");
      assertEquals(result.sessions[0].signal, "http-webhook");
      assertEquals(result.sessions[0].status, "active");
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
    await server.shutdown();
  }
});

Deno.test("fetchSessions - should filter by workspace", async () => {
  const mockSessions = [
    {
      id: "sess_123",
      workspaceId: "workspace_1",
      status: "active",
      summary: "Processing",
      signal: "http",
      startTime: "2024-01-01T10:00:00Z",
      progress: 50,
    },
    {
      id: "sess_456",
      workspaceId: "workspace_2",
      status: "active",
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

  const server = Deno.serve(
    { port: 8766, hostname: "127.0.0.1" },
    (req) => {
      const url = new URL(req.url);

      if (url.pathname === "/api/sessions" && req.method === "GET") {
        return new Response(JSON.stringify(mockSessions), {
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  );

  try {
    const result = await fetchSessions({ port: 8766, workspace: "workspace_1" });

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
    await server.shutdown();
  }
});

Deno.test("fetchSessions - should handle connection refused error", async () => {
  // Try to connect to a port that's not listening
  const result = await fetchSessions({ port: 9999 });

  assertEquals(result.success, false);

  // Type assertion for error case
  const errorResult = result as { success: false; error: string; reason?: string };
  assertEquals(errorResult.reason, "server_not_running");
  assertExists(errorResult.error);
  assertEquals(
    errorResult.error,
    "No workspace server running. Start a workspace with 'atlas workspace serve'",
  );
});

Deno.test("fetchSessions - should handle server errors", async () => {
  const server = Deno.serve(
    { port: 8767, hostname: "127.0.0.1" },
    (req) => {
      const url = new URL(req.url);

      if (url.pathname === "/api/sessions") {
        return new Response("Internal Server Error", { status: 500 });
      }

      return new Response("Not found", { status: 404 });
    },
  );

  try {
    const result = await fetchSessions({ port: 8767 });

    assertEquals(result.success, false);

    // Type assertion for error case
    const errorResult = result as { success: false; error: string; reason?: string };
    assertEquals(errorResult.reason, "network_error");
    assertExists(errorResult.error);
  } finally {
    await server.shutdown();
  }
});

Deno.test("fetchSessions - should handle invalid JSON response", async () => {
  const server = Deno.serve(
    { port: 8768, hostname: "127.0.0.1" },
    (req) => {
      const url = new URL(req.url);

      if (url.pathname === "/api/sessions") {
        return new Response("Invalid JSON", {
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  );

  try {
    const result = await fetchSessions({ port: 8768 });

    assertEquals(result.success, false);

    // Type assertion for error case
    const errorResult = result as { success: false; error: string; reason?: string };
    assertExists(errorResult.error);
    assertEquals(errorResult.reason, "network_error");
  } finally {
    await server.shutdown();
  }
});

Deno.test("fetchSessions - should use custom port", async () => {
  const mockSession = {
    id: "sess_123",
    workspaceId: "workspace_1",
    status: "active",
    summary: "Test",
    signal: "test",
    startTime: "2024-01-01T10:00:00Z",
    progress: 0,
  };

  const server = Deno.serve(
    { port: 8769, hostname: "127.0.0.1" },
    (req) => {
      const url = new URL(req.url);

      if (url.pathname === "/api/sessions") {
        return new Response(JSON.stringify([mockSession]), {
          headers: { "content-type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  );

  try {
    const result = await fetchSessions({ port: 8769 });

    assertEquals(result.success, true);
    if (result.success) {
      assertEquals(result.sessions.length, 1);
      assertEquals(result.sessions[0].id, "sess_123");
    }
  } finally {
    await server.shutdown();
  }
});
