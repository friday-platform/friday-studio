/**
 * Unit tests for draft tools
 * Tests draft management operations with mocked daemon API calls
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

// Extract core logic from draft list tool for testing
async function draftListToolLogic(ctx: { daemonUrl: string; logger: any }, params: {
  sessionId?: string;
  conversationId?: string;
  includeDetails?: boolean;
}) {
  ctx.logger.info("MCP list_session_drafts called", {
    sessionId: params.sessionId,
    conversationId: params.conversationId,
    includeDetails: params.includeDetails,
  });

  try {
    const queryParams = new URLSearchParams();
    if (params.sessionId) queryParams.set("sessionId", params.sessionId);
    if (params.conversationId) queryParams.set("conversationId", params.conversationId);
    if (params.includeDetails) queryParams.set("includeDetails", "true");

    const queryString = queryParams.toString();
    const url = queryString
      ? `${ctx.daemonUrl}/api/drafts?${queryString}`
      : `${ctx.daemonUrl}/api/drafts`;

    const response = await mockFetchWithTimeout(url);
    const result = await mockHandleDaemonResponse(response, "list_session_drafts", ctx.logger);

    ctx.logger.info("MCP list_session_drafts response", {
      draftCount: result.drafts?.length || 0,
      includeDetails: params.includeDetails,
    });

    return createSuccessResponse({
      ...result,
      source: "daemon_api",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    ctx.logger.error("MCP list_session_drafts failed", { error });
    throw error;
  }
}

// Extract core logic from draft create tool for testing
async function draftCreateToolLogic(ctx: { daemonUrl: string; logger: any }, params: {
  name: string;
  description: string;
  initialConfig?: Record<string, any>;
  sessionId?: string;
  conversationId?: string;
}) {
  ctx.logger.info("MCP workspace_draft_create called", {
    name: params.name,
    description: params.description,
    sessionId: params.sessionId,
    conversationId: params.conversationId,
  });

  try {
    const payload = {
      name: params.name,
      description: params.description,
      initialConfig: params.initialConfig || {},
      sessionId: params.sessionId,
      conversationId: params.conversationId || params.sessionId,
    };

    const response = await mockFetchWithTimeout(`${ctx.daemonUrl}/api/drafts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = await mockHandleDaemonResponse(response, "workspace_draft_create", ctx.logger);

    ctx.logger.info("MCP workspace_draft_create response", {
      draftId: result.draftId,
      name: result.name,
      isValid: result.isValid,
    });

    return createSuccessResponse({
      ...result,
      source: "daemon_api",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    ctx.logger.error("MCP workspace_draft_create failed", { name: params.name, error });
    throw error;
  }
}

// Extract core logic from draft show tool for testing
async function draftShowToolLogic(ctx: { daemonUrl: string; logger: any }, params: {
  draftId: string;
  format?: "yaml" | "json" | "summary";
}) {
  ctx.logger.info("MCP show_draft_config called", {
    draftId: params.draftId,
    format: params.format,
  });

  try {
    const queryParams = new URLSearchParams();
    if (params.format) queryParams.set("format", params.format);

    const queryString = queryParams.toString();
    const url = queryString
      ? `${ctx.daemonUrl}/api/drafts/${params.draftId}?${queryString}`
      : `${ctx.daemonUrl}/api/drafts/${params.draftId}`;

    const response = await mockFetchWithTimeout(url);
    const result = await mockHandleDaemonResponse(response, "show_draft_config", ctx.logger);

    ctx.logger.info("MCP show_draft_config response", {
      draftId: params.draftId,
      format: params.format,
      configSize: result.config?.toString().length || 0,
    });

    return createSuccessResponse({
      ...result,
      source: "daemon_api",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    ctx.logger.error("MCP show_draft_config failed", { draftId: params.draftId, error });
    throw error;
  }
}

// Extract core logic from draft update tool for testing
async function draftUpdateToolLogic(ctx: { daemonUrl: string; logger: any }, params: {
  draftId: string;
  updates: Record<string, any>;
  updateDescription?: string;
}) {
  ctx.logger.info("MCP workspace_draft_update called", {
    draftId: params.draftId,
    updateDescription: params.updateDescription,
    updateKeys: Object.keys(params.updates),
  });

  try {
    const payload = {
      updates: params.updates,
      updateDescription: params.updateDescription,
    };

    const response = await mockFetchWithTimeout(`${ctx.daemonUrl}/api/drafts/${params.draftId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = await mockHandleDaemonResponse(response, "workspace_draft_update", ctx.logger);

    ctx.logger.info("MCP workspace_draft_update response", {
      draftId: params.draftId,
      isValid: result.isValid,
      validationErrors: result.validationErrors?.length || 0,
    });

    return createSuccessResponse({
      ...result,
      source: "daemon_api",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    ctx.logger.error("MCP workspace_draft_update failed", { draftId: params.draftId, error });
    throw error;
  }
}

// Extract core logic from draft validate tool for testing
async function draftValidateToolLogic(ctx: { daemonUrl: string; logger: any }, params: {
  draftId: string;
}) {
  ctx.logger.info("MCP workspace_draft_validate called", {
    draftId: params.draftId,
  });

  try {
    const response = await mockFetchWithTimeout(
      `${ctx.daemonUrl}/api/drafts/${params.draftId}/validate`,
      {
        method: "POST",
      },
    );

    const result = await mockHandleDaemonResponse(response, "workspace_draft_validate", ctx.logger);

    ctx.logger.info("MCP workspace_draft_validate response", {
      draftId: params.draftId,
      isValid: result.isValid,
      errorCount: result.errors?.length || 0,
      warningCount: result.warnings?.length || 0,
    });

    return createSuccessResponse({
      ...result,
      source: "daemon_api",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    ctx.logger.error("MCP workspace_draft_validate failed", { draftId: params.draftId, error });
    throw error;
  }
}

// Extract core logic from draft publish tool for testing
async function draftPublishToolLogic(ctx: { daemonUrl: string; logger: any }, params: {
  draftId: string;
  path?: string;
  overwrite?: boolean;
}) {
  ctx.logger.info("MCP publish_draft_to_workspace called", {
    draftId: params.draftId,
    path: params.path,
    overwrite: params.overwrite,
  });

  try {
    const payload = {
      path: params.path,
      overwrite: params.overwrite || false,
    };

    const response = await mockFetchWithTimeout(
      `${ctx.daemonUrl}/api/drafts/${params.draftId}/publish`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
    );

    const result = await mockHandleDaemonResponse(
      response,
      "publish_draft_to_workspace",
      ctx.logger,
    );

    ctx.logger.info("MCP publish_draft_to_workspace response", {
      draftId: params.draftId,
      workspacePath: result.workspacePath,
      success: result.success,
    });

    return createSuccessResponse({
      ...result,
      source: "daemon_api",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    ctx.logger.error("MCP publish_draft_to_workspace failed", { draftId: params.draftId, error });
    throw error;
  }
}

// Extract core logic from draft delete tool for testing
async function draftDeleteToolLogic(ctx: { daemonUrl: string; logger: any }, params: {
  draftId: string;
}) {
  ctx.logger.info("MCP delete_draft_config called", {
    draftId: params.draftId,
  });

  try {
    const response = await mockFetchWithTimeout(`${ctx.daemonUrl}/api/drafts/${params.draftId}`, {
      method: "DELETE",
    });

    const result = await mockHandleDaemonResponse(response, "delete_draft_config", ctx.logger);

    ctx.logger.info("MCP delete_draft_config response", {
      draftId: params.draftId,
      success: result.success,
    });

    return createSuccessResponse({
      ...result,
      source: "daemon_api",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    ctx.logger.error("MCP delete_draft_config failed", { draftId: params.draftId, error });
    throw error;
  }
}

// Mock data for draft objects
const mockDrafts = [
  {
    id: "draft-1",
    name: "Test Workspace Draft",
    description: "A test workspace draft",
    sessionId: "session-1",
    conversationId: "conv-1",
    config: {
      name: "test-workspace",
      description: "Test workspace",
      agents: ["agent-1"],
      jobs: ["job-1"],
    },
    created: "2023-01-01T00:00:00Z",
    updated: "2023-01-01T00:00:00Z",
    isValid: true,
    validationErrors: [],
  },
  {
    id: "draft-2",
    name: "Another Draft",
    description: "Another test draft",
    sessionId: "session-2",
    conversationId: "conv-2",
    config: {
      name: "another-workspace",
      description: "Another workspace",
      agents: ["agent-2"],
      jobs: ["job-2"],
    },
    created: "2023-01-02T00:00:00Z",
    updated: "2023-01-02T00:00:00Z",
    isValid: false,
    validationErrors: ["Missing required field: environment"],
  },
];

const mockDraftDetails = {
  id: "draft-1",
  name: "Test Workspace Draft",
  description: "A test workspace draft",
  sessionId: "session-1",
  conversationId: "conv-1",
  config: `# Test Workspace Configuration
name: test-workspace
description: Test workspace
agents:
  - agent-1
jobs:
  - job-1
environment:
  NODE_ENV: development`,
  created: "2023-01-01T00:00:00Z",
  updated: "2023-01-01T00:00:00Z",
  isValid: true,
  validationErrors: [],
};

const mockValidationResult = {
  isValid: true,
  errors: [],
  warnings: [
    {
      field: "agents",
      message: "Consider adding more agents for better coverage",
    },
  ],
  suggestions: [
    {
      field: "jobs",
      message: "You might want to add a monitoring job",
    },
  ],
};

const mockPublishResult = {
  success: true,
  workspacePath: "/Users/test/workspace",
  draftId: "draft-1",
  workspaceId: "workspace-1",
};

// Mock fetch function for testing
function createMockFetch(mockResponses: Record<string, any>) {
  return async (url: string, options?: any) => {
    // Handle different HTTP methods
    let responseKey = url;
    if (options?.method === "POST") {
      responseKey = `${url}_POST`;
    } else if (options?.method === "PATCH") {
      responseKey = `${url}_PATCH`;
    } else if (options?.method === "DELETE") {
      responseKey = `${url}_DELETE`;
    }

    // Try exact match first
    let response = mockResponses[responseKey];

    // If no exact match, try to find a matching pattern
    if (!response) {
      for (const [pattern, mockResponse] of Object.entries(mockResponses)) {
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

Deno.test("draft list tool - lists drafts successfully", async () => {
  // Mock fetch to return draft list
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/drafts": {
      data: { drafts: mockDrafts },
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };
    const result = await draftListToolLogic(ctx, { includeDetails: false });

    // Check response structure
    assertExists(result.content);
    assertEquals(Array.isArray(result.content), true);
    assertEquals(result.content.length, 1);
    assertEquals(result.content[0].type, "text");

    // Parse the response
    const response = JSON.parse(result.content[0].text);

    // Check response data
    assertExists(response.drafts);
    assertEquals(response.drafts.length, 2);
    assertEquals(response.drafts[0].id, "draft-1");
    assertEquals(response.drafts[0].name, "Test Workspace Draft");
    assertEquals(response.drafts[1].id, "draft-2");
    assertEquals(response.drafts[1].name, "Another Draft");
    assertEquals(response.source, "daemon_api");
    assertExists(response.timestamp);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("draft list tool - handles filtering by session", async () => {
  // Mock fetch to return filtered results
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/drafts?sessionId=session-1": {
      data: { drafts: [mockDrafts[0]] },
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };
    const result = await draftListToolLogic(ctx, { sessionId: "session-1" });

    // Check response structure
    assertExists(result.content);
    const response = JSON.parse(result.content[0].text);

    // Check that filtering worked
    assertEquals(response.drafts.length, 1);
    assertEquals(response.drafts[0].sessionId, "session-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("draft list tool - handles empty draft list", async () => {
  // Mock fetch to return empty array
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/drafts": {
      data: { drafts: [] },
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };
    const result = await draftListToolLogic(ctx, {});

    // Check response structure
    assertExists(result.content);
    const response = JSON.parse(result.content[0].text);

    // Check that empty list is handled correctly
    assertEquals(response.drafts, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("draft create tool - creates draft successfully", async () => {
  // Mock fetch to return created draft
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/drafts_POST": {
      data: {
        draftId: "draft-new",
        name: "New Draft",
        description: "A new draft",
        isValid: true,
        validationErrors: [],
      },
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };
    const result = await draftCreateToolLogic(ctx, {
      name: "New Draft",
      description: "A new draft",
      initialConfig: { agents: ["agent-1"] },
      sessionId: "session-1",
    });

    // Check response structure
    assertExists(result.content);
    const response = JSON.parse(result.content[0].text);

    // Check response data
    assertEquals(response.draftId, "draft-new");
    assertEquals(response.name, "New Draft");
    assertEquals(response.isValid, true);
    assertEquals(response.source, "daemon_api");
    assertExists(response.timestamp);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("draft create tool - handles validation errors", async () => {
  // Mock fetch to return 400 with validation errors
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/drafts_POST": {
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
      await draftCreateToolLogic(ctx, {
        name: "",
        description: "A draft without name",
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

Deno.test("draft show tool - shows draft successfully", async () => {
  // Mock fetch to return draft content
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/drafts/draft-1": {
      data: mockDraftDetails,
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };
    const result = await draftShowToolLogic(ctx, { draftId: "draft-1", format: "yaml" });

    // Check response structure
    assertExists(result.content);
    const response = JSON.parse(result.content[0].text);

    // Check response data
    assertEquals(response.id, "draft-1");
    assertEquals(response.name, "Test Workspace Draft");
    assertExists(response.config);
    assertEquals(response.source, "daemon_api");
    assertExists(response.timestamp);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("draft show tool - handles draft not found", async () => {
  // Mock fetch to return 404
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/drafts/nonexistent": {
      ok: false,
      status: 404,
      statusText: "Not Found",
      data: { error: "Draft not found" },
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };

    // Should throw an error
    let errorThrown = false;
    try {
      await draftShowToolLogic(ctx, { draftId: "nonexistent" });
    } catch (error) {
      errorThrown = true;
      assert(error.message.includes("Daemon API error: 404"));
      assert(error.message.includes("Draft not found"));
    }

    assert(errorThrown, "Expected error to be thrown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("draft update tool - updates draft successfully", async () => {
  // Mock fetch to return updated draft
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/drafts/draft-1_PATCH": {
      data: {
        draftId: "draft-1",
        isValid: true,
        validationErrors: [],
        updated: "2023-01-03T00:00:00Z",
      },
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };
    const result = await draftUpdateToolLogic(ctx, {
      draftId: "draft-1",
      updates: { name: "Updated Draft Name" },
      updateDescription: "Updated the draft name",
    });

    // Check response structure
    assertExists(result.content);
    const response = JSON.parse(result.content[0].text);

    // Check response data
    assertEquals(response.draftId, "draft-1");
    assertEquals(response.isValid, true);
    assertEquals(response.validationErrors, []);
    assertEquals(response.source, "daemon_api");
    assertExists(response.timestamp);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("draft validate tool - validates draft successfully", async () => {
  // Mock fetch to return validation results
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/drafts/draft-1/validate_POST": {
      data: mockValidationResult,
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };
    const result = await draftValidateToolLogic(ctx, { draftId: "draft-1" });

    // Check response structure
    assertExists(result.content);
    const response = JSON.parse(result.content[0].text);

    // Check response data
    assertEquals(response.isValid, true);
    assertEquals(response.errors, []);
    assertEquals(response.warnings.length, 1);
    assertEquals(response.suggestions.length, 1);
    assertEquals(response.source, "daemon_api");
    assertExists(response.timestamp);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("draft publish tool - publishes draft successfully", async () => {
  // Mock fetch to return publication results
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/drafts/draft-1/publish_POST": {
      data: mockPublishResult,
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };
    const result = await draftPublishToolLogic(ctx, {
      draftId: "draft-1",
      path: "/Users/test/workspace",
      overwrite: false,
    });

    // Check response structure
    assertExists(result.content);
    const response = JSON.parse(result.content[0].text);

    // Check response data
    assertEquals(response.success, true);
    assertEquals(response.workspacePath, "/Users/test/workspace");
    assertEquals(response.draftId, "draft-1");
    assertEquals(response.workspaceId, "workspace-1");
    assertEquals(response.source, "daemon_api");
    assertExists(response.timestamp);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("draft delete tool - deletes draft successfully", async () => {
  // Mock fetch to return deletion confirmation
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/drafts/draft-1_DELETE": {
      data: {
        success: true,
        draftId: "draft-1",
        deleted: true,
      },
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };
    const result = await draftDeleteToolLogic(ctx, { draftId: "draft-1" });

    // Check response structure
    assertExists(result.content);
    const response = JSON.parse(result.content[0].text);

    // Check response data
    assertEquals(response.success, true);
    assertEquals(response.draftId, "draft-1");
    assertEquals(response.deleted, true);
    assertEquals(response.source, "daemon_api");
    assertExists(response.timestamp);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("draft tools - handle network errors", async () => {
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
      await draftListToolLogic(ctx, {});
    } catch (error) {
      errorThrown = true;
      assert(error.message.includes("Network connection failed"));
    }

    assert(errorThrown, "Expected error to be thrown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("draft tools - handle server errors", async () => {
  // Mock fetch to return 500 errors
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/drafts": {
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
      await draftListToolLogic(ctx, {});
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
