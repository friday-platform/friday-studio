/**
 * Unit tests for library tools
 * Tests library operations with mocked daemon API calls
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { createSuccessResponse } from "../../src/tools/types.ts";

// Mock logger for testing
const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// Import the buildLibraryQueryParams helper for testing
import { buildLibraryQueryParams } from "../../src/tools/utils.ts";

// Mock fetch helpers
async function mockFetchWithTimeout(url: string, options?: RequestInit) {
  return fetch(url, options);
}

async function mockHandleDaemonResponse(response: Response, operation: string, logger: any) {
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
    );
  }
  return response.json();
}

// Extract core logic from library list tool for testing
async function libraryListToolLogic(ctx: { daemonUrl: string; logger: any }, params: {
  query?: string;
  type?: string[];
  tags?: string[];
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}) {
  ctx.logger.info("MCP library_list called", {
    query: params.query,
    type: params.type,
    tags: params.tags,
    limit: params.limit,
    offset: params.offset,
  });

  try {
    // Build query parameters using helper method
    const queryParams = buildLibraryQueryParams({
      query: params.query,
      type: params.type,
      tags: params.tags,
      since: params.since,
      until: params.until,
      limit: params.limit,
      offset: params.offset,
    });

    const queryString = queryParams.toString();
    const url = queryString
      ? `${ctx.daemonUrl}/api/library?${queryString}`
      : `${ctx.daemonUrl}/api/library`;

    const response = await mockFetchWithTimeout(url);
    const result = await mockHandleDaemonResponse(response, "library_list", ctx.logger);

    ctx.logger.info("MCP library_list response", {
      totalItems: result.total,
      returnedItems: result.items.length,
      tookMs: result.took_ms,
    });

    return createSuccessResponse({
      ...result,
      source: "daemon_api",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    ctx.logger.error("MCP library_list failed", { error });
    throw error;
  }
}

// Extract core logic from library get tool for testing
async function libraryGetToolLogic(ctx: { daemonUrl: string; logger: any }, params: {
  itemId: string;
  includeContent?: boolean;
}) {
  ctx.logger.info("MCP library_get called", {
    itemId: params.itemId,
    includeContent: params.includeContent,
  });

  // Input validation
  if (!params.itemId || typeof params.itemId !== "string" || params.itemId.trim().length === 0) {
    throw new Error("itemId is required and must be a non-empty string");
  }

  try {
    const queryParams = new URLSearchParams();
    if (params.includeContent) queryParams.set("content", "true");

    const queryString = queryParams.toString();
    const url = queryString
      ? `${ctx.daemonUrl}/api/library/${params.itemId}?${queryString}`
      : `${ctx.daemonUrl}/api/library/${params.itemId}`;

    const response = await mockFetchWithTimeout(url);
    const result = await mockHandleDaemonResponse(response, "library_get", ctx.logger);

    ctx.logger.info("MCP library_get response", {
      itemId: params.itemId,
      hasContent: params.includeContent && "content" in result,
    });

    return createSuccessResponse({
      ...result,
      source: "daemon_api",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    ctx.logger.error("MCP library_get failed", { itemId: params.itemId, error });
    throw error;
  }
}

// Extract core logic from library store tool for testing
async function libraryStoreToolLogic(ctx: { daemonUrl: string; logger: any }, params: {
  type: string;
  name: string;
  description?: string;
  content: string;
  format?: string;
  tags?: string[];
  workspace_id?: string;
  session_id?: string;
  agent_ids?: string[];
  source?: string;
  metadata?: Record<string, any>;
}) {
  ctx.logger.info("MCP library_store called", {
    type: params.type,
    name: params.name,
    format: params.format,
    contentLength: params.content.length,
    tagCount: params.tags?.length || 0,
    workspace_id: params.workspace_id,
    session_id: params.session_id,
  });

  try {
    const contextualPayload = {
      type: params.type,
      name: params.name,
      description: params.description,
      content: params.content,
      format: params.format || "markdown",
      tags: params.tags || [],
      workspace_id: params.workspace_id,
      session_id: params.session_id,
      agent_ids: params.agent_ids || [],
      source: params.source || "agent",
      metadata: params.metadata || {},
    };

    const response = await mockFetchWithTimeout(`${ctx.daemonUrl}/api/library`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(contextualPayload),
    });

    const result = await mockHandleDaemonResponse(response, "library_store", ctx.logger);

    ctx.logger.info("MCP library_store response", {
      success: result.success,
      itemId: result.itemId,
      name: result.item?.name,
    });

    return createSuccessResponse({
      ...result,
      source: "daemon_api",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    ctx.logger.error("MCP library_store failed", { name: params.name, type: params.type, error });
    throw error;
  }
}

// Mock data for library items
const mockLibraryItems = [
  {
    id: "lib-item-1",
    name: "Test Report",
    type: "report",
    description: "Sample test report",
    content: "This is test content 1",
    format: "markdown",
    tags: ["test", "example"],
    workspace_id: "workspace-1",
    session_id: "session-1",
    agent_ids: ["agent-1"],
    source: "agent",
    created: "2023-01-01T00:00:00Z",
    updated: "2023-01-01T00:00:00Z",
  },
  {
    id: "lib-item-2",
    name: "Code Template",
    type: "template",
    description: "Sample code template",
    content: "function example() { return 'hello'; }",
    format: "text",
    tags: ["template", "code"],
    workspace_id: "workspace-1",
    session_id: "session-2",
    agent_ids: ["agent-2"],
    source: "agent",
    created: "2023-01-02T00:00:00Z",
    updated: "2023-01-02T00:00:00Z",
  },
];

const mockLibraryListResponse = {
  items: mockLibraryItems,
  total: 2,
  limit: 50,
  offset: 0,
  took_ms: 15,
};

const mockLibraryItemDetails = {
  id: "lib-item-1",
  name: "Test Report",
  type: "report",
  description: "Sample test report",
  content: "This is detailed test content with more information",
  format: "markdown",
  tags: ["test", "example"],
  workspace_id: "workspace-1",
  session_id: "session-1",
  agent_ids: ["agent-1"],
  source: "agent",
  created: "2023-01-01T00:00:00Z",
  updated: "2023-01-01T00:00:00Z",
  metadata: {
    size: 1234,
    version: "1.0",
  },
};

const mockStoreResponse = {
  success: true,
  itemId: "lib-item-new",
  item: {
    id: "lib-item-new",
    name: "New Library Item",
    type: "report",
    description: "A new library item",
    format: "markdown",
    tags: ["new", "test"],
    workspace_id: "workspace-1",
    created: "2023-01-03T00:00:00Z",
  },
};

// Mock fetch function for testing
function createMockFetch(mockResponses: Record<string, any>) {
  return async (url: string, options?: any) => {
    // Handle POST requests (for store)
    if (options?.method === "POST") {
      const postKey = `${url}_POST`;
      const postResponse = mockResponses[postKey] || mockResponses[url];
      if (postResponse) {
        return {
          ok: postResponse.ok !== false,
          status: postResponse.status || 200,
          statusText: postResponse.statusText || "OK",
          json: async () => postResponse.data,
        };
      }
    }

    // Try exact match first
    let response = mockResponses[url];

    // If no exact match, try to find a matching pattern
    if (!response) {
      for (const [pattern, mockResponse] of Object.entries(mockResponses)) {
        if (pattern.includes("_POST")) continue; // Skip POST patterns for GET requests

        // Check if the URL starts with the pattern (for query parameters)
        if (url.startsWith(pattern)) {
          response = mockResponse;
          break;
        }

        // Check if the pattern matches the base URL (ignoring query params)
        const urlBase = url.split("?")[0];
        const patternBase = pattern.split("?")[0];
        if (urlBase === patternBase) {
          response = mockResponse;
          break;
        }
      }
    }

    if (!response) {
      return {
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: async () => ({ error: "Not found" }),
      };
    }

    return {
      ok: response.ok !== false,
      status: response.status || 200,
      statusText: response.statusText || "OK",
      json: async () => response.data,
    };
  };
}

Deno.test("library list tool - lists items successfully", async () => {
  // Mock fetch to return library items
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/library": {
      data: mockLibraryListResponse,
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };
    const result = await libraryListToolLogic(ctx, { limit: 50, offset: 0 });

    // Check response structure
    assertExists(result.content);
    assertEquals(Array.isArray(result.content), true);
    assertEquals(result.content.length, 1);
    assertEquals(result.content[0].type, "text");

    // Parse the response
    const response = JSON.parse(result.content[0].text);

    // Check response data
    assertExists(response.items);
    assertEquals(response.total, 2);
    assertEquals(response.limit, 50);
    assertEquals(response.offset, 0);
    assertEquals(response.source, "daemon_api");
    assertExists(response.timestamp);

    // Check library items
    assertEquals(response.items.length, 2);
    assertEquals(response.items[0].id, "lib-item-1");
    assertEquals(response.items[0].name, "Test Report");
    assertEquals(response.items[0].type, "report");
    assertEquals(response.items[1].id, "lib-item-2");
    assertEquals(response.items[1].name, "Code Template");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("library list tool - handles filtering by query", async () => {
  // Mock fetch to return filtered results
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/library?q=test": {
      data: {
        items: [mockLibraryItems[0]],
        total: 1,
        limit: 50,
        offset: 0,
        took_ms: 12,
      },
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };
    const result = await libraryListToolLogic(ctx, { query: "test" });

    // Check response structure
    assertExists(result.content);
    const response = JSON.parse(result.content[0].text);

    // Check that filtering worked
    assertEquals(response.items.length, 1);
    assertEquals(response.items[0].name, "Test Report");
    assertEquals(response.total, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("library list tool - handles pagination", async () => {
  // Mock fetch to return paginated results
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/library?limit=1&offset=1": {
      data: {
        items: [mockLibraryItems[1]],
        total: 2,
        limit: 1,
        offset: 1,
        took_ms: 10,
      },
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };
    const result = await libraryListToolLogic(ctx, { limit: 1, offset: 1 });

    // Check response structure
    assertExists(result.content);
    const response = JSON.parse(result.content[0].text);

    // Check pagination worked
    assertEquals(response.items.length, 1);
    assertEquals(response.items[0].name, "Code Template");
    assertEquals(response.total, 2);
    assertEquals(response.limit, 1);
    assertEquals(response.offset, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("library list tool - handles empty results", async () => {
  // Mock fetch to return empty array
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/library": {
      data: { items: [], total: 0, limit: 50, offset: 0, took_ms: 5 },
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };
    const result = await libraryListToolLogic(ctx, {});

    // Check response structure
    assertExists(result.content);
    const response = JSON.parse(result.content[0].text);

    // Check that empty list is handled correctly
    assertEquals(response.items, []);
    assertEquals(response.total, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("library get tool - gets item successfully", async () => {
  // Mock fetch to return library item
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/library/lib-item-1": {
      data: mockLibraryItemDetails,
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };
    const result = await libraryGetToolLogic(ctx, { itemId: "lib-item-1", includeContent: false });

    // Check response structure
    assertExists(result.content);
    assertEquals(Array.isArray(result.content), true);
    assertEquals(result.content.length, 1);
    assertEquals(result.content[0].type, "text");

    // Parse the response
    const response = JSON.parse(result.content[0].text);

    // Check response data
    assertEquals(response.id, "lib-item-1");
    assertEquals(response.name, "Test Report");
    assertEquals(response.type, "report");
    assertEquals(response.description, "Sample test report");
    assertEquals(response.source, "daemon_api");
    assertExists(response.timestamp);
    assertExists(response.metadata);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("library get tool - handles item not found", async () => {
  // Mock fetch to return 404
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/library/nonexistent": {
      ok: false,
      status: 404,
      statusText: "Not Found",
      data: { error: "Library item not found" },
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };

    // Should throw an error
    let errorThrown = false;
    try {
      await libraryGetToolLogic(ctx, { itemId: "nonexistent" });
    } catch (error) {
      errorThrown = true;
      assert(error.message.includes("Daemon API error: 404"));
      assert(error.message.includes("Library item not found"));
    }

    assert(errorThrown, "Expected error to be thrown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("library store tool - stores item successfully", async () => {
  // Mock fetch to return stored item
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/library": {
      data: mockStoreResponse,
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };
    const result = await libraryStoreToolLogic(ctx, {
      type: "report",
      name: "New Library Item",
      description: "A new library item",
      content: "This is new content",
      format: "markdown",
      tags: ["new", "test"],
      workspace_id: "workspace-1",
    });

    // Check response structure
    assertExists(result.content);
    assertEquals(Array.isArray(result.content), true);
    assertEquals(result.content.length, 1);
    assertEquals(result.content[0].type, "text");

    // Parse the response
    const response = JSON.parse(result.content[0].text);

    // Check response data
    assertEquals(response.success, true);
    assertEquals(response.itemId, "lib-item-new");
    assertEquals(response.source, "daemon_api");
    assertExists(response.timestamp);
    assertExists(response.item);
    assertEquals(response.item.name, "New Library Item");
    assertEquals(response.item.type, "report");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("library store tool - handles validation errors", async () => {
  // Mock fetch to return 400 with validation errors
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/library": {
      ok: false,
      status: 400,
      statusText: "Bad Request",
      data: { error: "Validation failed: name is required" },
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };

    // Should throw an error
    let errorThrown = false;
    try {
      await libraryStoreToolLogic(ctx, {
        type: "report",
        name: "",
        content: "test content",
      });
    } catch (error) {
      errorThrown = true;
      assert(error.message.includes("Daemon API error: 400"));
      assert(error.message.includes("Validation failed"));
    }

    assert(errorThrown, "Expected error to be thrown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("library tools - handle network errors", async () => {
  // Mock fetch to throw network error
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Network connection failed");
  };

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };

    // Should throw an error
    let errorThrown = false;
    try {
      await libraryListToolLogic(ctx, {});
    } catch (error) {
      errorThrown = true;
      assert(error.message.includes("Network connection failed"));
    }

    assert(errorThrown, "Expected error to be thrown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("library tools - handle server errors", async () => {
  // Mock fetch to return 500 errors
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/library": {
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      data: { error: "Server error occurred" },
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };

    // Should throw an error
    let errorThrown = false;
    try {
      await libraryListToolLogic(ctx, {});
    } catch (error) {
      errorThrown = true;
      assert(error.message.includes("Daemon API error: 500"));
      assert(error.message.includes("Server error occurred"));
    }

    assert(errorThrown, "Expected error to be thrown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
