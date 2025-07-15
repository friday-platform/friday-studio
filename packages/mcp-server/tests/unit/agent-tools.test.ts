/**
 * Unit tests for agent tools
 * Tests agent-related operations with mocked daemon API calls
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

// Extract core logic from agent list tool for testing
async function agentListToolLogic(ctx: { daemonUrl: string; logger: any }, params: {
  workspaceId: string;
}) {
  ctx.logger.info("MCP workspace_agents_list called", { workspaceId: params.workspaceId });

  try {
    const response = await fetch(`${ctx.daemonUrl}/api/workspaces/${params.workspaceId}/agents`);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
      );
    }

    const agents = await response.json();

    return createSuccessResponse({
      agents,
      total: agents.length,
      workspaceId: params.workspaceId,
      source: "daemon_api",
    });
  } catch (error) {
    ctx.logger.error("MCP workspace_agents_list failed", {
      workspaceId: params.workspaceId,
      error,
    });
    throw error;
  }
}

// Extract core logic from agent describe tool for testing
async function agentDescribeToolLogic(ctx: { daemonUrl: string; logger: any }, params: {
  workspaceId: string;
  agentId: string;
}) {
  ctx.logger.info("MCP workspace_agents_describe called", {
    workspaceId: params.workspaceId,
    agentId: params.agentId,
  });

  try {
    const response = await fetch(
      `${ctx.daemonUrl}/api/workspaces/${params.workspaceId}/agents/${params.agentId}`,
    );
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
      );
    }

    const agent = await response.json();

    return createSuccessResponse({
      agent,
      workspaceId: params.workspaceId,
      source: "daemon_api",
    });
  } catch (error) {
    ctx.logger.error("MCP workspace_agents_describe failed", {
      workspaceId: params.workspaceId,
      agentId: params.agentId,
      error,
    });
    throw error;
  }
}

// Mock fetch function for testing
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

// Mock agent data for testing
const mockAgents = [
  {
    id: "agent-1",
    name: "Data Analysis Agent",
    type: "system",
    status: "active",
    description: "Analyzes data and generates reports",
    capabilities: ["data_analysis", "report_generation"],
    created: "2024-01-01T00:00:00Z",
  },
  {
    id: "agent-2",
    name: "Code Review Agent",
    type: "custom",
    status: "inactive",
    description: "Reviews code changes and provides feedback",
    capabilities: ["code_review", "static_analysis"],
    created: "2024-01-02T00:00:00Z",
  },
];

const mockAgentDetails = {
  id: "agent-1",
  name: "Data Analysis Agent",
  type: "system",
  status: "active",
  description: "Analyzes data and generates reports",
  capabilities: ["data_analysis", "report_generation"],
  created: "2024-01-01T00:00:00Z",
  lastExecuted: "2024-01-15T10:30:00Z",
  executionCount: 42,
  configuration: {
    timeout: 300,
    maxRetries: 3,
  },
};

Deno.test("agent list tool - lists agents successfully", async () => {
  // Mock fetch to return agent data
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/workspaces/test-workspace/agents": {
      data: mockAgents,
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };
    const result = await agentListToolLogic(ctx, { workspaceId: "test-workspace" });

    // Check response structure
    assertExists(result.content);
    assertEquals(Array.isArray(result.content), true);
    assertEquals(result.content.length, 1);
    assertEquals(result.content[0].type, "text");

    // Parse the response
    const response = JSON.parse(result.content[0].text);

    // Check response data
    assertExists(response.agents);
    assertEquals(response.total, 2);
    assertEquals(response.workspaceId, "test-workspace");
    assertEquals(response.source, "daemon_api");

    // Check agent data
    assertEquals(response.agents.length, 2);
    assertEquals(response.agents[0].id, "agent-1");
    assertEquals(response.agents[0].name, "Data Analysis Agent");
    assertEquals(response.agents[1].id, "agent-2");
    assertEquals(response.agents[1].name, "Code Review Agent");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("agent list tool - handles workspace not found", async () => {
  // Mock fetch to return 404
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/workspaces/nonexistent/agents": {
      ok: false,
      status: 404,
      statusText: "Not Found",
      data: { error: "Workspace not found" },
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };

    // Should throw an error
    let errorThrown = false;
    try {
      await agentListToolLogic(ctx, { workspaceId: "nonexistent" });
    } catch (error) {
      errorThrown = true;
      assert(error.message.includes("Daemon API error: 404"));
      assert(error.message.includes("Workspace not found"));
    }

    assert(errorThrown, "Expected error to be thrown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("agent list tool - handles empty agent list", async () => {
  // Mock fetch to return empty array
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/workspaces/empty-workspace/agents": {
      data: [],
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };
    const result = await agentListToolLogic(ctx, { workspaceId: "empty-workspace" });

    // Check response structure
    assertExists(result.content);
    const response = JSON.parse(result.content[0].text);

    // Check that empty list is handled correctly
    assertEquals(response.agents, []);
    assertEquals(response.total, 0);
    assertEquals(response.workspaceId, "empty-workspace");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("agent describe tool - describes agent successfully", async () => {
  // Mock fetch to return agent details
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/workspaces/test-workspace/agents/agent-1": {
      data: mockAgentDetails,
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };
    const result = await agentDescribeToolLogic(ctx, {
      workspaceId: "test-workspace",
      agentId: "agent-1",
    });

    // Check response structure
    assertExists(result.content);
    assertEquals(Array.isArray(result.content), true);
    assertEquals(result.content.length, 1);
    assertEquals(result.content[0].type, "text");

    // Parse the response
    const response = JSON.parse(result.content[0].text);

    // Check response data
    assertExists(response.agent);
    assertEquals(response.workspaceId, "test-workspace");
    assertEquals(response.source, "daemon_api");

    // Check agent details
    assertEquals(response.agent.id, "agent-1");
    assertEquals(response.agent.name, "Data Analysis Agent");
    assertEquals(response.agent.type, "system");
    assertEquals(response.agent.status, "active");
    assertEquals(response.agent.executionCount, 42);
    assertExists(response.agent.configuration);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("agent describe tool - handles agent not found", async () => {
  // Mock fetch to return 404
  const originalFetch = globalThis.fetch;
  globalThis.fetch = createMockFetch({
    "http://mock-daemon/api/workspaces/test-workspace/agents/nonexistent": {
      ok: false,
      status: 404,
      statusText: "Not Found",
      data: { error: "Agent not found" },
    },
  }) as typeof fetch;

  try {
    const ctx = { daemonUrl: "http://mock-daemon", logger: mockLogger };

    // Should throw an error
    let errorThrown = false;
    try {
      await agentDescribeToolLogic(ctx, {
        workspaceId: "test-workspace",
        agentId: "nonexistent",
      });
    } catch (error) {
      errorThrown = true;
      assert(error.message.includes("Daemon API error: 404"));
      assert(error.message.includes("Agent not found"));
    }

    assert(errorThrown, "Expected error to be thrown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("agent describe tool - handles network error", async () => {
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
      await agentDescribeToolLogic(ctx, {
        workspaceId: "test-workspace",
        agentId: "agent-1",
      });
    } catch (error) {
      errorThrown = true;
      assert(error.message.includes("Network connection failed"));
    }

    assert(errorThrown, "Expected error to be thrown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
