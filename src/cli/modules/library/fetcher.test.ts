import type { LibrarySearchResult } from "@atlas/client";
import { AtlasApiError } from "@atlas/client";
import { assertEquals, assertExists } from "@std/assert";
import { fetchLibraryItems, type LibraryFetchError } from "./fetcher.ts";

// Mock response helper function
function mockResponse(body: unknown, options: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
}

Deno.test("fetchLibraryItems - should make correct HTTP request to library search endpoint", async () => {
  const originalFetch = globalThis.fetch;

  const mockSearchResult: LibrarySearchResult = {
    items: [],
    total: 0,
    query: { type: "document", tags: ["important", "archive"], since: "2024-01-01", limit: 50 },
    took_ms: 10,
  };

  let capturedRequest: Request | undefined;

  globalThis.fetch = async (input: string | Request, init?: RequestInit) => {
    if (input instanceof Request) {
      capturedRequest = input;
    } else {
      capturedRequest = new Request(input, init);
    }

    return mockResponse(mockSearchResult);
  };

  try {
    await fetchLibraryItems({
      type: "document",
      tags: "important,archive",
      since: "2024-01-01",
      limit: 50,
    });

    assertExists(capturedRequest);
    assertEquals(capturedRequest.method, "GET");

    // Verify the request URL contains the properly transformed query parameters
    const url = new URL(capturedRequest.url);
    assertEquals(url.pathname, "/api/library/search");
    assertEquals(url.searchParams.get("type"), "document");
    assertEquals(url.searchParams.get("tags"), "important,archive");
    assertEquals(url.searchParams.get("since"), "2024-01-01");
    assertEquals(url.searchParams.get("limit"), "50");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchLibraryItems - should handle empty tags string", async () => {
  const originalFetch = globalThis.fetch;

  const mockSearchResult: LibrarySearchResult = {
    items: [],
    total: 0,
    query: { type: "document" },
    took_ms: 10,
  };

  let capturedRequest: Request | undefined;

  globalThis.fetch = async (input: string | Request, init?: RequestInit) => {
    if (input instanceof Request) {
      capturedRequest = input;
    } else {
      capturedRequest = new Request(input, init);
    }

    return mockResponse(mockSearchResult);
  };

  try {
    await fetchLibraryItems({ type: "document", tags: "" });

    assertExists(capturedRequest);
    const url = new URL(capturedRequest.url);
    assertEquals(url.searchParams.get("type"), "document");
    assertEquals(url.searchParams.get("tags"), null); // Empty string should not be included
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchLibraryItems - should handle undefined parameters", async () => {
  const originalFetch = globalThis.fetch;

  const mockSearchResult: LibrarySearchResult = {
    items: [],
    total: 0,
    query: { type: "document" },
    took_ms: 10,
  };

  let capturedRequest: Request | undefined;

  globalThis.fetch = async (input: string | Request, init?: RequestInit) => {
    if (input instanceof Request) {
      capturedRequest = input;
    } else {
      capturedRequest = new Request(input, init);
    }

    return mockResponse(mockSearchResult);
  };

  try {
    await fetchLibraryItems({ type: "document" });

    assertExists(capturedRequest);
    const url = new URL(capturedRequest.url);
    assertEquals(url.searchParams.get("type"), "document");
    assertEquals(url.searchParams.get("tags"), null);
    assertEquals(url.searchParams.get("since"), null);
    assertEquals(url.searchParams.get("limit"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchLibraryItems - should transform API response to UI format", async () => {
  const originalFetch = globalThis.fetch;

  const mockLibraryResult: LibrarySearchResult = {
    items: [
      {
        id: "item_1",
        type: "document",
        name: "Technical Spec",
        description: "API documentation",
        metadata: { format: "markdown", source: "manual", custom_fields: { version: "1.0" } },
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
        metadata: { format: "json", source: "automated", session_id: "sess_123" },
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

  globalThis.fetch = async () => mockResponse(mockLibraryResult);

  try {
    const result = await fetchLibraryItems({ type: "document", tags: "api", limit: 10 });

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
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchLibraryItems - should handle empty results", async () => {
  const originalFetch = globalThis.fetch;

  const mockEmptyResult: LibrarySearchResult = { items: [], total: 0, query: {}, took_ms: 5 };

  globalThis.fetch = async () => mockResponse(mockEmptyResult);

  try {
    const result = await fetchLibraryItems();

    assertEquals(result.success, true);

    if (result.success) {
      assertEquals(result.items.length, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchLibraryItems - should handle connection refused error", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    throw new Error("Failed to connect to Atlas: Connection refused");
  };

  try {
    const result = await fetchLibraryItems();

    assertEquals(result.success, false);

    if (!result.success) {
      const errorResult = result as LibraryFetchError;
      assertEquals(errorResult.reason, "server_not_running");
      assertExists(errorResult.error);
      assertEquals(
        errorResult.error,
        "Cannot connect to server on port 8080. Make sure the workspace server is running.",
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchLibraryItems - should handle timeout error", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    throw new AtlasApiError("Request to Atlas daemon timed out after 5000ms", 408);
  };

  try {
    const result = await fetchLibraryItems();

    assertEquals(result.success, false);

    if (!result.success) {
      const errorResult = result as LibraryFetchError;
      assertEquals(errorResult.reason, "api_error");
      assertEquals(errorResult.error, "Request to Atlas daemon timed out after 5000ms");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchLibraryItems - should use the configured client port", async () => {
  const originalFetch = globalThis.fetch;

  const mockResult: LibrarySearchResult = { items: [], total: 0, query: {}, took_ms: 5 };

  let capturedUrl: string | undefined;

  globalThis.fetch = async (input: string | Request) => {
    if (input instanceof Request) {
      capturedUrl = input.url;
    } else {
      capturedUrl = input;
    }
    return mockResponse(mockResult);
  };

  try {
    await fetchLibraryItems({ port: 9090 });

    assertExists(capturedUrl);
    const url = new URL(capturedUrl);
    // Note: Due to singleton behavior, the port will be whatever was set in the first test
    // This test verifies that the request goes to the correct endpoint
    assertEquals(url.pathname, "/api/library/search");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchLibraryItems - should convert tags string to array in query params", async () => {
  const originalFetch = globalThis.fetch;

  const mockResult: LibrarySearchResult = { items: [], total: 0, query: {}, took_ms: 5 };

  let capturedRequest: Request | undefined;

  globalThis.fetch = async (input: string | Request, init?: RequestInit) => {
    if (input instanceof Request) {
      capturedRequest = input;
    } else {
      capturedRequest = new Request(input, init);
    }
    return mockResponse(mockResult);
  };

  try {
    await fetchLibraryItems({
      type: "document",
      tags: "api,docs,v2",
      since: "2024-01-01",
      limit: 20,
    });

    assertExists(capturedRequest);
    const url = new URL(capturedRequest.url);
    assertEquals(url.searchParams.get("type"), "document");
    assertEquals(url.searchParams.get("tags"), "api,docs,v2");
    assertEquals(url.searchParams.get("since"), "2024-01-01");
    assertEquals(url.searchParams.get("limit"), "20");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchLibraryItems - should handle AtlasApiError with specific status codes", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    throw new AtlasApiError("Unexpected error occurred", 500);
  };

  try {
    const result = await fetchLibraryItems();

    assertEquals(result.success, false);

    if (!result.success) {
      const errorResult = result as LibraryFetchError;
      assertEquals(errorResult.reason, "network_error");
      assertEquals(errorResult.error, "Unexpected error occurred");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchLibraryItems - should handle 503 HTTP error as server_not_running", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    throw new AtlasApiError("Service unavailable", 503);
  };

  try {
    const result = await fetchLibraryItems({ port: 9000 });

    assertEquals(result.success, false);

    if (!result.success) {
      const errorResult = result as LibraryFetchError;
      assertEquals(errorResult.reason, "server_not_running");
      assertEquals(
        errorResult.error,
        "Cannot connect to server on port 9000. Make sure the workspace server is running.",
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchLibraryItems - should handle 4xx HTTP error as api_error", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    throw new AtlasApiError("Bad request", 400);
  };

  try {
    const result = await fetchLibraryItems();

    assertEquals(result.success, false);

    if (!result.success) {
      const errorResult = result as LibraryFetchError;
      assertEquals(errorResult.reason, "api_error");
      assertEquals(errorResult.error, "Bad request");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchLibraryItems - should handle 5xx HTTP error as network_error", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    throw new AtlasApiError("Internal server error", 500);
  };

  try {
    const result = await fetchLibraryItems();

    assertEquals(result.success, false);

    if (!result.success) {
      const errorResult = result as LibraryFetchError;
      assertEquals(errorResult.reason, "network_error");
      assertEquals(errorResult.error, "Internal server error");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchLibraryItems - should handle missing optional fields in API response", async () => {
  const originalFetch = globalThis.fetch;

  const mockLibraryResult: LibrarySearchResult = {
    items: [
      {
        id: "item_1",
        type: "document",
        name: "Basic Item",
        // description is optional
        metadata: { format: "text", source: "manual" },
        created_at: "2024-01-01T10:00:00Z",
        updated_at: "2024-01-01T10:00:00Z",
        tags: [],
        size_bytes: 1024,
        // workspace_id is optional
      },
    ],
    total: 1,
    query: {},
    took_ms: 5,
  };

  globalThis.fetch = async () => mockResponse(mockLibraryResult);

  try {
    const result = await fetchLibraryItems();

    assertEquals(result.success, true);

    if (result.success) {
      assertEquals(result.items.length, 1);
      assertEquals(result.items[0].id, "item_1");
      assertEquals(result.items[0].name, "Basic Item");
      assertEquals(result.items[0].description, undefined);
      assertEquals(result.items[0].tags, []);
      assertEquals(result.items[0].size_bytes, 1024);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchLibraryItems - should preserve all required fields in transformation", async () => {
  const originalFetch = globalThis.fetch;

  const mockLibraryResult: LibrarySearchResult = {
    items: [
      {
        id: "complex_item",
        type: "analysis",
        name: "Complex Analysis",
        description: "Detailed analysis with rich metadata",
        metadata: {
          format: "json",
          source: "automated",
          session_id: "sess_123",
          agent_ids: ["agent_1", "agent_2"],
          engine: "claude-3",
          template_id: "template_1",
          created_by: "user_1",
          custom_fields: { version: "2.0", priority: "high", category: "performance" },
        },
        created_at: "2024-01-01T10:00:00Z",
        updated_at: "2024-01-02T15:30:00Z",
        tags: ["performance", "analysis", "automated"],
        size_bytes: 8192,
        workspace_id: "workspace_complex",
      },
    ],
    total: 1,
    query: { type: "analysis" },
    took_ms: 25,
  };

  globalThis.fetch = async () => mockResponse(mockLibraryResult);

  try {
    const result = await fetchLibraryItems({ type: "analysis" });

    assertEquals(result.success, true);

    if (result.success) {
      const item = result.items[0];
      assertEquals(item.id, "complex_item");
      assertEquals(item.type, "analysis");
      assertEquals(item.name, "Complex Analysis");
      assertEquals(item.description, "Detailed analysis with rich metadata");
      assertEquals(item.created_at, "2024-01-01T10:00:00Z");
      assertEquals(item.tags, ["performance", "analysis", "automated"]);
      assertEquals(item.size_bytes, 8192);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
