/**
 * Comprehensive tests for the Atlas client
 */

import { AtlasApiError, AtlasClient, getAtlasClient } from "@atlas/client";
import { expect } from "@std/expect";

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
  const client = new AtlasClient({ url: "http://localhost:9090", timeout: 30000 });
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

Deno.test(
  "AtlasClient - isHealthy returns false on network error",
  { sanitizeResources: false, sanitizeOps: false },
  async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error("Network error"));

    try {
      const client = new AtlasClient({ timeout: 100 });
      const isHealthy = await client.isHealthy();
      expect(isHealthy).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test("AtlasClient - handles successful API responses", async () => {
  // Create a properly formatted workspace response
  const mockWorkspaces = [
    {
      id: "workspace_1",
      name: "Test Workspace",
      status: "executing",
      path: "/test/workspace",
      createdAt: "2024-01-01T10:00:00Z",
      lastSeen: "2024-01-01T10:00:00Z",
    },
  ];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(mockResponse(mockWorkspaces));

  try {
    const client = new AtlasClient();
    const workspaces = await client.listWorkspaces();
    expect(Array.isArray(workspaces)).toBe(true);
    expect(workspaces.length).toBe(1);
    expect(workspaces[0]?.id).toBe("workspace_1");
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
    const result = await client.triggerWorkspaceSignal(8080, "test-signal", { data: "test" });
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
      new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    );

  try {
    const client = new AtlasClient();
    const logs = [];

    for await (const log of client.streamSessionLogs("sess_123")) {
      logs.push(log);
    }

    expect(logs.length).toBe(2);
    expect(logs[0]?.message).toBe("Log 1");
    expect(logs[1]?.message).toBe("Log 2");
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

Deno.test("AtlasClient - describeJob loads job configuration", async () => {
  const originalFetch = globalThis.fetch;
  const originalReadTextFile = Deno.readTextFile;

  // Mock the job list API call
  globalThis.fetch = (url) => {
    if (typeof url === "string" && url.includes("/api/workspaces/test-workspace/jobs")) {
      return Promise.resolve(
        mockResponse([{ name: "test-job", description: "Test job description" }]),
      );
    }
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  };

  // Mock the file read for workspace configuration
  Deno.readTextFile = (path) => {
    if (typeof path === "string" && path.includes("workspace.yml")) {
      return Promise.resolve(`
workspace:
  name: "Test Workspace"
jobs:
  test-job:
    name: "test-job"
    description: "Test job description"
    execution:
      strategy: "sequential"
      agents:
        - "agent1"
        - "agent2"
`);
    }
    return Promise.reject(new Error(`Unexpected path: ${path}`));
  };

  try {
    const client = new AtlasClient();
    const jobDetails = await client.describeJob(
      "test-workspace",
      "test-job",
      "/test/workspace/path",
    );

    expect(jobDetails.name).toBe("test-job");
    expect(jobDetails.description).toBe("Test job description");
    expect(jobDetails.execution?.strategy).toBe("sequential");
    expect(jobDetails.execution?.agents).toEqual(["agent1", "agent2"]);
  } finally {
    globalThis.fetch = originalFetch;
    Deno.readTextFile = originalReadTextFile;
  }
});

Deno.test("AtlasClient - describeJob throws error when job not found", async () => {
  const originalFetch = globalThis.fetch;

  // Mock the job list API call with empty array
  globalThis.fetch = (url) => {
    if (typeof url === "string" && url.includes("/api/workspaces/test-workspace/jobs")) {
      return Promise.resolve(mockResponse([]));
    }
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  };

  try {
    const client = new AtlasClient();

    await expect(
      client.describeJob("test-workspace", "nonexistent-job", "/test/workspace/path"),
    ).rejects.toThrow("Job 'nonexistent-job' not found in workspace");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("AtlasClient - listWorkspaceLibraryItems returns workspace library items", async () => {
  const originalFetch = globalThis.fetch;

  const mockLibraryResult = {
    items: [
      {
        id: "lib_1",
        type: "document",
        name: "Test Document",
        description: "Test description",
        metadata: { format: "markdown", source: "user", session_id: "sess_123" },
        created_at: "2024-01-01T10:00:00Z",
        updated_at: "2024-01-01T10:00:00Z",
        tags: ["test", "document"],
        size_bytes: 1024,
        workspace_id: "test-workspace",
      },
    ],
    total: 1,
    query: {},
    took_ms: 10,
  };

  globalThis.fetch = (url) => {
    if (typeof url === "string" && url.includes("/api/workspaces/test-workspace/library")) {
      return Promise.resolve(mockResponse(mockLibraryResult));
    }
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  };

  try {
    const client = new AtlasClient();
    const result = await client.listWorkspaceLibraryItems("test-workspace", {
      type: "document",
      limit: 10,
    });

    expect(result.items.length).toBe(1);
    expect(result.items[0]?.id).toBe("lib_1");
    expect(result.items[0]?.workspace_id).toBe("test-workspace");
    expect(result.total).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("AtlasClient - searchWorkspaceLibrary searches within workspace", async () => {
  const originalFetch = globalThis.fetch;

  const mockSearchResult = {
    items: [
      {
        id: "lib_search_1",
        type: "code",
        name: "Search Result",
        metadata: { format: "typescript", source: "agent" },
        created_at: "2024-01-01T11:00:00Z",
        updated_at: "2024-01-01T11:00:00Z",
        tags: ["search", "test"],
        size_bytes: 2048,
        workspace_id: "test-workspace",
      },
    ],
    total: 1,
    query: { query: "test search", type: "code" },
    took_ms: 25,
  };

  globalThis.fetch = (url) => {
    if (typeof url === "string" && url.includes("/api/workspaces/test-workspace/library/search")) {
      return Promise.resolve(mockResponse(mockSearchResult));
    }
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  };

  try {
    const client = new AtlasClient();
    const result = await client.searchWorkspaceLibrary("test-workspace", {
      query: "test search",
      type: "code",
      limit: 20,
    });

    expect(result.items.length).toBe(1);
    expect(result.items[0]?.type).toBe("code");
    expect(result.query.query).toBe("test search");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("AtlasClient - getWorkspaceLibraryItem retrieves specific item", async () => {
  const originalFetch = globalThis.fetch;

  const mockLibraryItem = {
    item: {
      id: "lib_item_1",
      type: "config",
      name: "Configuration File",
      description: "Test config",
      metadata: { format: "yaml", source: "user" },
      created_at: "2024-01-01T12:00:00Z",
      updated_at: "2024-01-01T12:00:00Z",
      tags: ["config"],
      size_bytes: 512,
      workspace_id: "test-workspace",
    },
    content: "test: configuration\nvalue: 123",
  };

  globalThis.fetch = (url) => {
    if (
      typeof url === "string" &&
      url.includes("/api/workspaces/test-workspace/library/lib_item_1")
    ) {
      return Promise.resolve(mockResponse(mockLibraryItem));
    }
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  };

  try {
    const client = new AtlasClient();
    const result = await client.getWorkspaceLibraryItem(
      "test-workspace",
      "lib_item_1",
      true, // includeContent
    );

    expect(result.item.id).toBe("lib_item_1");
    expect(result.item.type).toBe("config");
    expect(result.content).toBe("test: configuration\nvalue: 123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("AtlasClient - getWorkspaceLibraryItem without content", async () => {
  const originalFetch = globalThis.fetch;

  const mockLibraryItem = {
    item: {
      id: "lib_item_2",
      type: "document",
      name: "Document Without Content",
      metadata: { format: "markdown", source: "agent" },
      created_at: "2024-01-01T13:00:00Z",
      updated_at: "2024-01-01T13:00:00Z",
      tags: ["document"],
      size_bytes: 1536,
      workspace_id: "test-workspace",
    },
    // No content field when includeContent is false
  };

  globalThis.fetch = (url) => {
    if (
      typeof url === "string" &&
      url.includes("/api/workspaces/test-workspace/library/lib_item_2")
    ) {
      // Verify that content=true is NOT in the URL when includeContent is false
      expect(url).not.toContain("content=true");
      return Promise.resolve(mockResponse(mockLibraryItem));
    }
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  };

  try {
    const client = new AtlasClient();
    const result = await client.getWorkspaceLibraryItem(
      "test-workspace",
      "lib_item_2",
      false, // includeContent = false
    );

    expect(result.item.id).toBe("lib_item_2");
    expect(result.content).toBeUndefined();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
