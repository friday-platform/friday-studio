/**
 * Comprehensive tests for the Atlas client
 */

import { expect } from "@std/expect";
import { AtlasApiError, AtlasClient, getAtlasClient } from "../mod.ts";

// Helper to create response mocks
function mockResponse(body: unknown, options: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
}

Deno.test("AtlasClient - constructor with default options", () => {
  const client = new AtlasClient();
  expect(client).toBeInstanceOf(AtlasClient);
});

Deno.test("AtlasClient - constructor with custom options", () => {
  const client = new AtlasClient({
    url: "http://localhost:9090",
    timeout: 30000,
  });
  expect(client).toBeInstanceOf(AtlasClient);
});

Deno.test("AtlasClient - isHealthy returns true when server is healthy", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response("", { status: 200 }));

  try {
    const client = new AtlasClient();
    const isHealthy = await client.isHealthy();
    expect(isHealthy).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("AtlasClient - isHealthy returns false when server is unhealthy", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response("", { status: 500 }));

  try {
    const client = new AtlasClient();
    const isHealthy = await client.isHealthy();
    expect(isHealthy).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("AtlasClient - isHealthy returns false on network error", {
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new Error("Network error"));

  try {
    const client = new AtlasClient({ timeout: 100 });
    const isHealthy = await client.isHealthy();
    expect(isHealthy).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("AtlasClient - handles successful API responses", async () => {
  // Create a properly formatted workspace response
  const mockWorkspaces = [{
    id: "workspace_1",
    name: "Test Workspace",
    status: "active",
    path: "/test/workspace",
    hasActiveRuntime: true,
    createdAt: "2024-01-01T10:00:00Z",
    lastSeen: "2024-01-01T10:00:00Z",
  }];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(mockResponse(mockWorkspaces));

  try {
    const client = new AtlasClient();
    const workspaces = await client.listWorkspaces();
    expect(Array.isArray(workspaces)).toBe(true);
    expect(workspaces.length).toBe(1);
    expect(workspaces[0].id).toBe("workspace_1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("AtlasClient - throws AtlasApiError on 404", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(new Response("Not found", { status: 404 }));

  try {
    const client = new AtlasClient();
    await expect(client.getWorkspace("nonexistent")).rejects.toThrow(AtlasApiError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("AtlasClient - triggerWorkspaceSignal triggers signal on workspace server", async () => {
  const mockResponse = { success: true, sessionId: "sess_123" };
  const originalFetch = globalThis.fetch;
  let capturedUrl: string | undefined;

  globalThis.fetch = (input: RequestInfo | URL) => {
    capturedUrl = input.toString();
    return Promise.resolve(
      new Response(JSON.stringify(mockResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  try {
    const client = new AtlasClient();
    const result = await client.triggerWorkspaceSignal(
      8080,
      "test-signal",
      { data: "test" },
    );
    expect(result.success).toBe(true);
    expect(capturedUrl).toBe("http://localhost:8080/signals/test-signal");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("AtlasClient - streamSessionLogs streams logs using Server-Sent Events", async () => {
  const mockEventData = [
    'data: {"timestamp":"2024-01-01T10:00:00Z","level":"info","message":"Log 1"}\n\n',
    'data: {"timestamp":"2024-01-01T10:00:01Z","level":"debug","message":"Log 2"}\n\n',
  ];

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      mockEventData.forEach((data) => {
        controller.enqueue(encoder.encode(data));
      });
      controller.close();
    },
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );

  try {
    const client = new AtlasClient();
    const logs = [];

    for await (const log of client.streamSessionLogs("sess_123")) {
      logs.push(log);
    }

    expect(logs.length).toBe(2);
    expect(logs[0].message).toBe("Log 1");
    expect(logs[1].message).toBe("Log 2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("AtlasApiError - creates error with status", () => {
  const error = new AtlasApiError("Test error", 404);
  expect(error.message).toBe("Test error");
  expect(error.status).toBe(404);
  expect(error.name).toBe("AtlasApiError");
});

Deno.test("getAtlasClient - returns singleton instance", () => {
  // Since getAtlasClient uses a module-level singleton,
  // we can't easily reset it. Just verify it returns the same instance
  const client1 = getAtlasClient();
  const client2 = getAtlasClient();
  expect(client1).toBe(client2);
});
