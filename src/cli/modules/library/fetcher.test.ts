import { assertEquals, assertExists } from "@std/assert";
import { buildLibraryQueryParams, fetchLibraryItems } from "./fetcher.ts";
import { AtlasClient } from "@atlas/client";

// Helper to create a mock AtlasClient
function createMockClient(overrides: Partial<AtlasClient> = {}): AtlasClient {
  const client = new AtlasClient();
  Object.assign(client, overrides);
  return client;
}

Deno.test("buildLibraryQueryParams - should build query params with all options", () => {
  const params = buildLibraryQueryParams({
    type: "document",
    tags: "important,archive",
    since: "2024-01-01",
    limit: 50,
    workspace: "my-workspace",
  });

  assertEquals(params.get("type"), "document");
  assertEquals(params.get("tags"), "important,archive");
  assertEquals(params.get("since"), "2024-01-01");
  assertEquals(params.get("limit"), "50");
  assertEquals(params.get("workspace"), "my-workspace");
});

Deno.test("buildLibraryQueryParams - should handle boolean workspace parameter", () => {
  const params = buildLibraryQueryParams({
    workspace: true,
  });

  assertEquals(params.get("workspace"), "true");
});

Deno.test("buildLibraryQueryParams - should omit undefined parameters", () => {
  const params = buildLibraryQueryParams({
    type: "document",
  });

  assertEquals(params.get("type"), "document");
  assertEquals(params.has("tags"), false);
  assertEquals(params.has("since"), false);
  assertEquals(params.has("limit"), false);
  assertEquals(params.has("workspace"), false);
});

Deno.test("fetchLibraryItems - should fetch items successfully", async () => {
  const mockLibraryResult = {
    items: [
      {
        id: "item_1",
        type: "document",
        name: "Technical Spec",
        description: "API documentation",
        metadata: {
          format: "markdown",
          source: "manual",
          custom_fields: { version: "1.0" },
        },
        created_at: "2024-01-01T10:00:00Z",
        updated_at: "2024-01-01T10:00:00Z",
        tags: ["api", "docs"],
        size_bytes: 2048,
        workspace_id: "workspace_1",
      },
      {
        id: "item_2",
        type: "analysis",
        name: "Performance Report",
        description: "Q1 analysis",
        metadata: {
          format: "json",
          source: "automated",
          session_id: "sess_123",
        },
        created_at: "2024-01-02T10:00:00Z",
        updated_at: "2024-01-02T10:00:00Z",
        tags: ["performance", "quarterly"],
        size_bytes: 4096,
        workspace_id: "workspace_1",
      },
    ],
    total: 2,
    query: { type: "document" },
    took_ms: 15,
  };

  const originalGetAtlasClient = globalThis.getAtlasClient;
  globalThis.getAtlasClient = () =>
    createMockClient({
      searchLibrary: () => Promise.resolve(mockLibraryResult),
    });

  try {
    const result = await fetchLibraryItems({
      type: "document",
      tags: "api",
      limit: 10,
    });

    assertEquals(result.success, true);

    if (result.success) {
      assertEquals(result.items.length, 2);

      // Check first item mapping
      assertEquals(result.items[0].id, "item_1");
      assertEquals(result.items[0].type, "document");
      assertEquals(result.items[0].name, "Technical Spec");
      assertEquals(result.items[0].description, "API documentation");
      assertEquals(result.items[0].created_at, "2024-01-01T10:00:00Z");
      assertEquals(result.items[0].tags, ["api", "docs"]);
      assertEquals(result.items[0].size_bytes, 2048);

      // Check second item mapping
      assertEquals(result.items[1].id, "item_2");
      assertEquals(result.items[1].type, "analysis");
      assertEquals(result.items[1].name, "Performance Report");
    }
  } finally {
    globalThis.getAtlasClient = originalGetAtlasClient;
  }
});

Deno.test("fetchLibraryItems - should handle empty results", async () => {
  const mockEmptyResult = {
    items: [],
    total: 0,
    query: {},
    took_ms: 5,
  };

  const originalGetAtlasClient = globalThis.getAtlasClient;
  globalThis.getAtlasClient = () =>
    createMockClient({
      searchLibrary: () => Promise.resolve(mockEmptyResult),
    });

  try {
    const result = await fetchLibraryItems();

    assertEquals(result.success, true);

    if (result.success) {
      assertEquals(result.items.length, 0);
    }
  } finally {
    globalThis.getAtlasClient = originalGetAtlasClient;
  }
});

Deno.test("fetchLibraryItems - should handle connection refused error", async () => {
  const originalGetAtlasClient = globalThis.getAtlasClient;
  globalThis.getAtlasClient = () =>
    createMockClient({
      searchLibrary: () =>
        Promise.reject(new Error("Failed to connect to Atlas: Connection refused")),
    });

  try {
    const result = await fetchLibraryItems();

    assertEquals(result.success, false);

    if (!result.success) {
      assertEquals(result.reason, "server_not_running");
      assertExists(result.error);
      assertEquals(
        result.error,
        "Cannot connect to server on port 8080. Make sure the workspace server is running.",
      );
    }
  } finally {
    globalThis.getAtlasClient = originalGetAtlasClient;
  }
});

Deno.test("fetchLibraryItems - should handle timeout error", async () => {
  const originalGetAtlasClient = globalThis.getAtlasClient;
  globalThis.getAtlasClient = () =>
    createMockClient({
      searchLibrary: () => Promise.reject(new Error("Request timed out after 5000ms")),
    });

  try {
    const result = await fetchLibraryItems();

    assertEquals(result.success, false);

    if (!result.success) {
      assertEquals(result.reason, "network_error");
      assertEquals(result.error, "Request timed out. Server may be unresponsive.");
    }
  } finally {
    globalThis.getAtlasClient = originalGetAtlasClient;
  }
});

Deno.test("fetchLibraryItems - should use custom port", async () => {
  const mockResult = {
    items: [],
    total: 0,
    query: {},
    took_ms: 5,
  };

  let capturedUrl: string | undefined;

  const originalGetAtlasClient = globalThis.getAtlasClient;
  globalThis.getAtlasClient = (options?: { url?: string; timeout?: number }) => {
    capturedUrl = options?.url;
    return createMockClient({
      searchLibrary: () => Promise.resolve(mockResult),
    });
  };

  try {
    await fetchLibraryItems({ port: 9090 });

    assertEquals(capturedUrl, "http://localhost:9090");
  } finally {
    globalThis.getAtlasClient = originalGetAtlasClient;
  }
});

Deno.test("fetchLibraryItems - should convert tags string to array", async () => {
  const mockResult = {
    items: [],
    total: 0,
    query: {},
    took_ms: 5,
  };

  let capturedQuery: any;

  const originalGetAtlasClient = globalThis.getAtlasClient;
  globalThis.getAtlasClient = () =>
    createMockClient({
      searchLibrary: (query: any) => {
        capturedQuery = query;
        return Promise.resolve(mockResult);
      },
    });

  try {
    await fetchLibraryItems({
      type: "document",
      tags: "api,docs,v2",
      since: "2024-01-01",
      limit: 20,
    });

    // Verify the query was transformed correctly
    assertEquals(capturedQuery.type, "document");
    assertEquals(capturedQuery.tags, ["api", "docs", "v2"]);
    assertEquals(capturedQuery.since, "2024-01-01");
    assertEquals(capturedQuery.limit, 20);
  } finally {
    globalThis.getAtlasClient = originalGetAtlasClient;
  }
});

Deno.test("fetchLibraryItems - should handle generic errors", async () => {
  const originalGetAtlasClient = globalThis.getAtlasClient;
  globalThis.getAtlasClient = () =>
    createMockClient({
      searchLibrary: () => Promise.reject(new Error("Unexpected error occurred")),
    });

  try {
    const result = await fetchLibraryItems();

    assertEquals(result.success, false);

    if (!result.success) {
      assertEquals(result.reason, "network_error");
      assertEquals(result.error, "Unexpected error occurred");
    }
  } finally {
    globalThis.getAtlasClient = originalGetAtlasClient;
  }
});
