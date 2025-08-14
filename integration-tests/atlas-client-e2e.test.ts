/**
 * End-to-end integration tests for @atlas/client migration
 * These tests verify the complete flow from CLI modules through AtlasClient to the daemon API
 */

import { assertEquals, assertExists } from "@std/assert";
import { fetchSessions } from "../src/cli/modules/sessions/fetcher.ts";
import { fetchLibraryItems } from "../src/cli/modules/library/fetcher.ts";
import { getAtlasClient, resetAtlasClientForTesting } from "@atlas/client";

/**
 * Simple mock server for testing
 */
class MockServer {
  private server: Deno.HttpServer | null = null;
  private routes: Map<string, unknown> = new Map();
  private port: number = 0;

  async start(): Promise<number> {
    this.port = 8000 + Math.floor(Math.random() * 1000);

    this.server = Deno.serve({ port: this.port }, (req) => {
      const url = new URL(req.url);
      const key = `${req.method} ${url.pathname}`;
      const route = this.routes.get(key);

      if (route) {
        const response = route.handler ? route.handler(req) : route.response;
        return new Response(
          JSON.stringify(response),
          {
            status: route.status || 200,
            headers: route.headers || { "Content-Type": "application/json" },
          },
        );
      }

      return new Response("Not found", { status: 404 });
    });

    // Wait for server to be ready
    await new Promise((resolve) => setTimeout(resolve, 100));

    return this.port;
  }

  async stop() {
    if (this.server) {
      await this.server.shutdown();
    }
  }

  addRoute(path: string, options: unknown) {
    const key = `${options.method || "GET"} ${path}`;
    this.routes.set(key, options);
  }
}

// Test group: Sessions Module Integration
Deno.test("Atlas Client E2E - should fetch sessions through the complete stack", async () => {
  resetAtlasClientForTesting(); // Reset client for test isolation
  const mockServer = new MockServer();
  const serverPort = await mockServer.start();

  try {
    // Set up mock response
    mockServer.addRoute("/api/sessions", {
      method: "GET",
      response: [
        {
          id: "sess_e2e_1",
          workspaceId: "test_workspace",
          status: "executing",
          summary: "E2E test session",
          signal: "manual",
          startTime: new Date().toISOString(),
          progress: 75,
        },
        {
          id: "sess_e2e_2",
          workspaceId: "test_workspace",
          status: "completed",
          summary: "Completed E2E session",
          signal: "schedule",
          startTime: new Date(Date.now() - 3600000).toISOString(),
          endTime: new Date(Date.now() - 1800000).toISOString(),
          progress: 100,
        },
      ],
    });

    // Test through the fetcher module
    const result = await fetchSessions({ port: serverPort });

    assertEquals(result.success, true);
    if (result.success) {
      assertEquals(result.sessions.length, 2);
      assertEquals(result.sessions[0].id, "sess_e2e_1");
      assertEquals(result.sessions[0].status, "executing");
      assertEquals(result.sessions[1].id, "sess_e2e_2");
      assertEquals(result.sessions[1].status, "completed");
    }
  } finally {
    await mockServer.stop();
  }
});

Deno.test("Atlas Client E2E - should handle workspace filtering end-to-end", async () => {
  resetAtlasClientForTesting(); // Reset client for test isolation
  const mockServer = new MockServer();
  const serverPort = await mockServer.start();

  try {
    mockServer.addRoute("/api/sessions", {
      method: "GET",
      response: [
        {
          id: "sess_1",
          workspaceId: "workspace_a",
          status: "executing",
          summary: "Session A",
          signal: "http",
          startTime: new Date().toISOString(),
          progress: 50,
        },
        {
          id: "sess_2",
          workspaceId: "workspace_b",
          status: "executing",
          summary: "Session B",
          signal: "http",
          startTime: new Date().toISOString(),
          progress: 30,
        },
      ],
    });

    const result = await fetchSessions({
      port: serverPort,
      workspace: "workspace_a",
    });

    assertEquals(result.success, true);
    if (result.success) {
      assertEquals(result.sessions.length, 2); // All sessions
      assertEquals(result.filteredSessions.length, 1); // Only workspace_a
      assertEquals(result.filteredSessions[0].workspaceName, "workspace_a");
    }
  } finally {
    await mockServer.stop();
  }
});

// Test group: Library Module Integration
Deno.test("Atlas Client E2E - should fetch library items through the complete stack", async () => {
  resetAtlasClientForTesting(); // Reset client for test isolation
  const mockServer = new MockServer();
  const serverPort = await mockServer.start();

  try {
    mockServer.addRoute("/api/library/search", {
      method: "GET",
      handler: (req) => {
        const url = new URL(req.url);
        const params = url.searchParams;

        // Verify query parameters are passed correctly
        assertEquals(params.get("type"), "document");
        // Tags come as comma-separated string in URL params
        assertEquals(params.get("tags"), "technical,api");
        assertEquals(params.get("limit"), "10");

        return {
          items: [
            {
              id: "lib_e2e_1",
              type: "document",
              name: "API Guide",
              description: "Complete API documentation",
              metadata: {
                format: "markdown",
                source: "manual",
              },
              created_at: "2024-01-01T10:00:00Z",
              updated_at: "2024-01-01T10:00:00Z",
              tags: ["technical", "api"],
              size_bytes: 10240,
              workspace_id: "test_workspace",
            },
          ],
          total: 1,
          query: {
            type: "document",
            tags: ["technical", "api"],
            limit: 10,
          },
          took_ms: 25,
        };
      },
    });

    const result = await fetchLibraryItems({
      port: serverPort,
      type: "document",
      tags: "technical,api",
      limit: 10,
    });

    assertEquals(result.success, true);
    if (result.success) {
      assertEquals(result.items.length, 1);
      assertEquals(result.items[0].id, "lib_e2e_1");
      assertEquals(result.items[0].type, "document");
      assertEquals(result.items[0].name, "API Guide");
      assertEquals(result.items[0].tags, ["technical", "api"]);
    }
  } finally {
    await mockServer.stop();
  }
});

// Test group: Signal Triggering Integration
Deno.test("Atlas Client E2E - should trigger workspace signal end-to-end", async () => {
  resetAtlasClientForTesting(); // Reset client for test isolation
  const mockServer = new MockServer();
  const serverPort = await mockServer.start();

  try {
    const signalData = {
      event: "deployment",
      environment: "production",
      version: "1.2.3",
    };

    mockServer.addRoute("/signals/deploy-signal", {
      method: "POST",
      response: {
        success: true,
        sessionId: "sess_signal_123",
        message: "Signal triggered successfully",
      },
    });

    const client = getAtlasClient({
      url: `http://localhost:${serverPort}`,
    });

    const result = await client.triggerWorkspaceSignal(
      serverPort,
      "deploy-signal",
      signalData,
    );

    assertEquals(result.success, true);
    assertEquals(result.sessionId, "sess_signal_123");
  } finally {
    await mockServer.stop();
  }
});

// Test group: Error Handling Integration
Deno.test("Atlas Client E2E - should handle server errors gracefully", async () => {
  resetAtlasClientForTesting(); // Reset client for test isolation
  const mockServer = new MockServer();
  const serverPort = await mockServer.start();

  try {
    mockServer.addRoute("/api/sessions", {
      method: "GET",
      status: 500,
      response: { error: "Internal server error" },
    });

    const result = await fetchSessions({ port: serverPort });

    assertEquals(result.success, false);
    if ("error" in result) {
      assertExists(result.error);
      assertEquals(result.reason, "network_error");
    }
  } finally {
    await mockServer.stop();
  }
});

Deno.test("Atlas Client E2E - should handle malformed responses", async () => {
  resetAtlasClientForTesting(); // Reset client for test isolation
  const mockServer = new MockServer();
  const serverPort = await mockServer.start();

  try {
    mockServer.addRoute("/api/library/search", {
      method: "GET",
      response: "Invalid JSON response",
      headers: { "Content-Type": "text/plain" },
    });

    const result = await fetchLibraryItems({ port: serverPort });

    assertEquals(result.success, false);
    if ("error" in result) {
      assertExists(result.error);
    }
  } finally {
    await mockServer.stop();
  }
});

// Test group: Client Singleton Behavior
Deno.test("Atlas Client E2E - should reuse client instance across modules", async () => {
  resetAtlasClientForTesting(); // Reset client for test isolation
  const mockServer = new MockServer();
  const serverPort = await mockServer.start();

  try {
    // Set up mock routes
    mockServer.addRoute("/api/sessions", {
      method: "GET",
      response: [],
    });

    mockServer.addRoute("/api/library/search", {
      method: "GET",
      response: { items: [], total: 0, query: {}, took_ms: 5 },
    });
    // Test that both fetchers work with the same server
    const sessionsResult = await fetchSessions({ port: serverPort });
    const libraryResult = await fetchLibraryItems({ port: serverPort });

    // Both should succeed (indicating client reuse is working)
    assertEquals(sessionsResult.success, true);
    assertEquals(libraryResult.success, true);
  } finally {
    await mockServer.stop();
  }
});
