/**
 * Unit tests for workspace tools
 * Tests the core logic with mocked daemon API calls
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

// Mock workspace data
const mockWorkspaces = [
  {
    id: "test-workspace-1",
    name: "Test Workspace 1",
    path: "/path/to/workspace1",
    status: "running",
    config: { version: "1.0.0" },
  },
  {
    id: "test-workspace-2",
    name: "Test Workspace 2",
    path: "/path/to/workspace2",
    status: "stopped",
    config: { version: "1.0.0" },
  },
];

// Mock workspace details
const mockWorkspaceDetails = {
  id: "test-workspace-1",
  name: "Test Workspace 1",
  path: "/path/to/workspace1",
  status: "running",
  config: { version: "1.0.0" },
  jobs: ["job1", "job2"],
  agents: ["agent1"],
};

// Extract the core logic from workspace list tool
async function workspaceListToolLogic(ctx: { daemonUrl: string; logger: any }) {
  ctx.logger.info("MCP workspace_list called - querying daemon API");

  try {
    const response = await fetch(`${ctx.daemonUrl}/api/workspaces`);
    if (!response.ok) {
      throw new Error(`Daemon API error: ${response.status} ${response.statusText}`);
    }

    const workspaces = await response.json();

    ctx.logger.info("MCP workspace_list response", {
      totalWorkspaces: workspaces.length,
      runningWorkspaces: workspaces.filter((w: any) => w.status === "running").length,
    });

    return createSuccessResponse({
      workspaces,
      total: workspaces.length,
      source: "daemon_api",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    ctx.logger.error("MCP workspace_list error", { error: error.message });
    throw error;
  }
}

// Extract the core logic from workspace describe tool
async function workspaceDescribeToolLogic(
  ctx: { daemonUrl: string; logger: any },
  params: { workspaceId: string },
) {
  ctx.logger.info("MCP workspace_describe called", { workspaceId: params.workspaceId });

  try {
    const response = await fetch(`${ctx.daemonUrl}/api/workspaces/${params.workspaceId}`);
    if (!response.ok) {
      throw new Error(`Daemon API error: ${response.status} ${response.statusText}`);
    }

    const workspace = await response.json();

    ctx.logger.info("MCP workspace_describe response", {
      workspaceId: params.workspaceId,
      status: workspace.status,
    });

    return createSuccessResponse({
      workspace,
      source: "daemon_api",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    ctx.logger.error("MCP workspace_describe error", {
      workspaceId: params.workspaceId,
      error: error.message,
    });
    throw error;
  }
}

// Mock fetch function
function createMockFetch(mockResponses: Record<string, any>) {
  return async (url: string) => {
    const response = mockResponses[url];
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

Deno.test("workspace list tool - lists workspaces successfully", async () => {
  // Mock fetch to return workspace data
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/workspaces": {
      data: mockWorkspaces,
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };
    const result = await workspaceListToolLogic(ctx);

    // Check response structure
    assertExists(result.content);
    assertEquals(Array.isArray(result.content), true);
    assertEquals(result.content.length, 1);
    assertEquals(result.content[0].type, "text");

    // Parse the response
    const response = JSON.parse(result.content[0].text);

    // Check response data
    assertExists(response.workspaces);
    assertEquals(response.total, 2);
    assertEquals(response.source, "daemon_api");
    assertExists(response.timestamp);

    // Check workspace data
    assertEquals(response.workspaces.length, 2);
    assertEquals(response.workspaces[0].id, "test-workspace-1");
    assertEquals(response.workspaces[0].name, "Test Workspace 1");
    assertEquals(response.workspaces[0].status, "running");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("workspace list tool - handles daemon API error", async () => {
  // Mock fetch to return error
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/workspaces": {
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };

    // Should throw an error
    let errorThrown = false;
    try {
      await workspaceListToolLogic(ctx);
    } catch (error) {
      errorThrown = true;
      assert(error.message.includes("Daemon API error: 500"));
    }

    assert(errorThrown, "Expected error to be thrown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("workspace describe tool - describes workspace successfully", async () => {
  // Mock fetch to return workspace details
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/workspaces/test-workspace-1": {
      data: mockWorkspaceDetails,
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };
    const result = await workspaceDescribeToolLogic(ctx, { workspaceId: "test-workspace-1" });

    // Check response structure
    assertExists(result.content);
    assertEquals(Array.isArray(result.content), true);
    assertEquals(result.content.length, 1);
    assertEquals(result.content[0].type, "text");

    // Parse the response
    const response = JSON.parse(result.content[0].text);

    // Check response data
    assertExists(response.workspace);
    assertEquals(response.source, "daemon_api");
    assertExists(response.timestamp);

    // Check workspace details
    assertEquals(response.workspace.id, "test-workspace-1");
    assertEquals(response.workspace.name, "Test Workspace 1");
    assertEquals(response.workspace.status, "running");
    assertExists(response.workspace.jobs);
    assertExists(response.workspace.agents);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("workspace describe tool - handles workspace not found", async () => {
  // Mock fetch to return 404
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/workspaces/nonexistent": {
      ok: false,
      status: 404,
      statusText: "Not Found",
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };

    // Should throw an error
    let errorThrown = false;
    try {
      await workspaceDescribeToolLogic(ctx, { workspaceId: "nonexistent" });
    } catch (error) {
      errorThrown = true;
      assert(error.message.includes("Daemon API error: 404"));
    }

    assert(errorThrown, "Expected error to be thrown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("workspace describe tool - handles network error", async () => {
  // Mock fetch to throw network error
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("Network error");
  };

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };

    // Should throw an error
    let errorThrown = false;
    try {
      await workspaceDescribeToolLogic(ctx, { workspaceId: "test-workspace-1" });
    } catch (error) {
      errorThrown = true;
      assert(error.message.includes("Network error"));
    }

    assert(errorThrown, "Expected error to be thrown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
