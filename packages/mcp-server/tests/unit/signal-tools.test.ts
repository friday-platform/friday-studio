/**
 * Unit tests for signal tools
 * Tests signal operations with mocked daemon API calls
 */

import { assertEquals, assertRejects } from "@std/assert";
import { createSuccessResponse } from "../../src/tools/types.ts";

// Mock logger for testing
const mockLogger = {
  info: (_message: string, _data?: unknown) => {},
  warn: (_message: string, _data?: unknown) => {},
  error: (_message: string, _data?: unknown) => {},
  debug: (_message: string, _data?: unknown) => {},
};

// Mock data for signals
const mockSignals = [
  {
    id: "signal-1",
    name: "webhook",
    workspaceId: "workspace-1",
    type: "webhook",
    status: "active",
    payload: { url: "https://example.com/webhook", method: "POST" },
    createdAt: "2023-01-01T00:00:00Z",
    updatedAt: "2023-01-01T00:00:01Z",
  },
  {
    id: "signal-2",
    name: "file_watcher",
    workspaceId: "workspace-1",
    type: "file_change",
    status: "active",
    payload: { path: "/test/file.txt", patterns: ["*.ts"] },
    createdAt: "2023-01-01T00:01:00Z",
    updatedAt: "2023-01-01T00:01:01Z",
  },
];

const mockTriggerResponse = {
  status: "triggered",
  message: "Signal triggered successfully",
  sessionId: "session-123",
  timestamp: "2023-01-01T00:02:00Z",
};

// Mock workspace with MCP enabled
const mockWorkspaceEnabled = {
  id: "workspace-1",
  name: "Test Workspace",
  config: {
    server: {
      mcp: {
        enabled: true,
      },
    },
  },
};

// Mock workspace with MCP disabled
const mockWorkspaceDisabled = {
  id: "workspace-1",
  name: "Test Workspace",
  config: {
    server: {
      mcp: {
        enabled: false,
      },
    },
  },
};

// Extract core logic from signals list tool
async function signalListToolLogic(ctx: { daemonUrl: string; logger: typeof mockLogger }, params: {
  workspaceId: string;
}) {
  ctx.logger.info("MCP workspace_signals_list called", { workspaceId: params.workspaceId });

  try {
    const response = await fetch(`${ctx.daemonUrl}/api/workspaces/${params.workspaceId}/signals`);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
      );
    }

    const signals = await response.json();

    return createSuccessResponse({
      signals,
      total: signals.length,
      workspaceId: params.workspaceId,
      source: "daemon_api",
    });
  } catch (error) {
    ctx.logger.error("MCP workspace_signals_list failed", {
      workspaceId: params.workspaceId,
      error,
    });
    throw error;
  }
}

// Extract core logic from signals trigger tool
async function signalTriggerToolLogic(
  ctx: { daemonUrl: string; logger: typeof mockLogger },
  params: {
    workspaceId: string;
    signalName: string;
    payload?: Record<string, unknown>;
  },
) {
  ctx.logger.info("MCP workspace_signals_trigger called", {
    workspaceId: params.workspaceId,
    signalName: params.signalName,
  });

  // Check if workspace has MCP enabled
  const workspaceResponse = await fetch(`${ctx.daemonUrl}/api/workspaces/${params.workspaceId}`);
  if (!workspaceResponse.ok) {
    const errorData = await workspaceResponse.json().catch(() => ({}));
    throw new Error(
      `Daemon API error: ${workspaceResponse.status} - ${
        errorData.error || workspaceResponse.statusText
      }`,
    );
  }

  const workspace = await workspaceResponse.json();
  const mcpEnabled = workspace.config?.server?.mcp?.enabled ?? false;

  if (!mcpEnabled) {
    ctx.logger.warn("Platform MCP: Blocked workspace operation - MCP disabled", {
      workspaceId: params.workspaceId,
      operation: "workspace_signals_trigger",
    });
    const error = new Error(
      `MCP is disabled for workspace '${params.workspaceId}'. Enable it in workspace.yml server.mcp.enabled to access workspace capabilities.`,
    );
    // deno-lint-ignore no-explicit-any
    (error as any).code = -32000;
    throw error;
  }

  try {
    const response = await fetch(
      `${ctx.daemonUrl}/api/workspaces/${params.workspaceId}/signals/${params.signalName}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(params.payload || {}),
      },
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        `Daemon API error: ${response.status} - ${errorData.error || response.statusText}`,
      );
    }

    const result = await response.json();

    return createSuccessResponse({
      success: true,
      workspaceId: params.workspaceId,
      signalName: params.signalName,
      status: result.status,
      message: result.message,
      source: "daemon_api",
    });
  } catch (error) {
    ctx.logger.error("MCP workspace_signals_trigger failed", {
      workspaceId: params.workspaceId,
      signalName: params.signalName,
      error,
    });
    throw error;
  }
}

// Global fetch mock
let fetchMock: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// Helper to create mock response
function createMockResponse(data: unknown, status = 200, statusText = "OK") {
  return new Response(JSON.stringify(data), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });
}

// Helper to create mock error response
function createMockErrorResponse(status: number, statusText: string, error?: string) {
  return new Response(JSON.stringify({ error: error || statusText }), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });
}

// Setup and teardown for each test
function setupFetchMock(mockFn: typeof fetchMock) {
  fetchMock = mockFn;
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = fetchMock;
}

function teardownFetchMock() {
  // deno-lint-ignore no-explicit-any
  (globalThis as any).fetch = undefined;
}

// Test Cases for Signal List Tool
Deno.test("signal list tool - lists signals successfully", async () => {
  setupFetchMock((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/api/workspaces/workspace-1/signals")) {
      return Promise.resolve(createMockResponse(mockSignals));
    }

    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });

  const ctx = { daemonUrl: "http://localhost:8080", logger: mockLogger };
  const result = await signalListToolLogic(ctx, { workspaceId: "workspace-1" });

  assertEquals(result.content[0].type, "text");
  const data = JSON.parse(result.content[0].text);
  assertEquals(data.signals, mockSignals);
  assertEquals(data.total, 2);
  assertEquals(data.workspaceId, "workspace-1");
  assertEquals(data.source, "daemon_api");

  teardownFetchMock();
});

Deno.test("signal list tool - handles empty signal list", async () => {
  setupFetchMock((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/api/workspaces/workspace-1/signals")) {
      return Promise.resolve(createMockResponse([]));
    }

    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });

  const ctx = { daemonUrl: "http://localhost:8080", logger: mockLogger };
  const result = await signalListToolLogic(ctx, { workspaceId: "workspace-1" });

  const data = JSON.parse(result.content[0].text);
  assertEquals(data.signals, []);
  assertEquals(data.total, 0);
  assertEquals(data.workspaceId, "workspace-1");

  teardownFetchMock();
});

Deno.test("signal list tool - handles API errors", async () => {
  setupFetchMock((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/api/workspaces/workspace-1/signals")) {
      return Promise.resolve(createMockErrorResponse(404, "Not Found", "Workspace not found"));
    }

    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });

  const ctx = { daemonUrl: "http://localhost:8080", logger: mockLogger };

  await assertRejects(
    async () => {
      await signalListToolLogic(ctx, { workspaceId: "workspace-1" });
    },
    Error,
    "Daemon API error: 404 - Workspace not found",
  );

  teardownFetchMock();
});

Deno.test("signal list tool - handles network errors", async () => {
  setupFetchMock(() => {
    return Promise.reject(new Error("Network error"));
  });

  const ctx = { daemonUrl: "http://localhost:8080", logger: mockLogger };

  await assertRejects(
    async () => {
      await signalListToolLogic(ctx, { workspaceId: "workspace-1" });
    },
    Error,
    "Network error",
  );

  teardownFetchMock();
});

// Test Cases for Signal Trigger Tool
Deno.test("signal trigger tool - triggers signal successfully", async () => {
  setupFetchMock((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/api/workspaces/workspace-1") && !url.includes("/signals/")) {
      return Promise.resolve(createMockResponse(mockWorkspaceEnabled));
    }

    if (url.includes("/api/workspaces/workspace-1/signals/webhook")) {
      assertEquals(init?.method, "POST");
      assertEquals(init?.headers?.["Content-Type"], "application/json");
      const body = JSON.parse(init?.body as string);
      assertEquals(body, { test: "payload" });
      return Promise.resolve(createMockResponse(mockTriggerResponse));
    }

    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });

  const ctx = { daemonUrl: "http://localhost:8080", logger: mockLogger };
  const result = await signalTriggerToolLogic(ctx, {
    workspaceId: "workspace-1",
    signalName: "webhook",
    payload: { test: "payload" },
  });

  const data = JSON.parse(result.content[0].text);
  assertEquals(data.success, true);
  assertEquals(data.workspaceId, "workspace-1");
  assertEquals(data.signalName, "webhook");
  assertEquals(data.status, "triggered");
  assertEquals(data.message, "Signal triggered successfully");
  assertEquals(data.source, "daemon_api");

  teardownFetchMock();
});

Deno.test("signal trigger tool - handles empty payload", async () => {
  setupFetchMock((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/api/workspaces/workspace-1") && !url.includes("/signals/")) {
      return Promise.resolve(createMockResponse(mockWorkspaceEnabled));
    }

    if (url.includes("/api/workspaces/workspace-1/signals/webhook")) {
      const body = JSON.parse(init?.body as string);
      assertEquals(body, {});
      return Promise.resolve(createMockResponse(mockTriggerResponse));
    }

    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });

  const ctx = { daemonUrl: "http://localhost:8080", logger: mockLogger };
  const result = await signalTriggerToolLogic(ctx, {
    workspaceId: "workspace-1",
    signalName: "webhook",
  });

  const data = JSON.parse(result.content[0].text);
  assertEquals(data.success, true);

  teardownFetchMock();
});

Deno.test("signal trigger tool - handles MCP disabled", async () => {
  setupFetchMock((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/api/workspaces/workspace-1") && !url.includes("/signals/")) {
      return Promise.resolve(createMockResponse(mockWorkspaceDisabled));
    }

    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });

  const ctx = { daemonUrl: "http://localhost:8080", logger: mockLogger };

  await assertRejects(
    async () => {
      await signalTriggerToolLogic(ctx, {
        workspaceId: "workspace-1",
        signalName: "webhook",
        payload: { test: "payload" },
      });
    },
    Error,
    "MCP is disabled for workspace 'workspace-1'. Enable it in workspace.yml server.mcp.enabled to access workspace capabilities.",
  );

  teardownFetchMock();
});

Deno.test("signal trigger tool - handles workspace not found", async () => {
  setupFetchMock((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/api/workspaces/workspace-1") && !url.includes("/signals/")) {
      return Promise.resolve(createMockErrorResponse(404, "Not Found", "Workspace not found"));
    }

    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });

  const ctx = { daemonUrl: "http://localhost:8080", logger: mockLogger };

  await assertRejects(
    async () => {
      await signalTriggerToolLogic(ctx, {
        workspaceId: "workspace-1",
        signalName: "webhook",
        payload: { test: "payload" },
      });
    },
    Error,
    "Daemon API error: 404 - Workspace not found",
  );

  teardownFetchMock();
});

Deno.test("signal trigger tool - handles signal trigger API errors", async () => {
  setupFetchMock((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/api/workspaces/workspace-1") && !url.includes("/signals/")) {
      return Promise.resolve(createMockResponse(mockWorkspaceEnabled));
    }

    if (url.includes("/api/workspaces/workspace-1/signals/webhook")) {
      return Promise.resolve(createMockErrorResponse(400, "Bad Request", "Invalid signal payload"));
    }

    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });

  const ctx = { daemonUrl: "http://localhost:8080", logger: mockLogger };

  await assertRejects(
    async () => {
      await signalTriggerToolLogic(ctx, {
        workspaceId: "workspace-1",
        signalName: "webhook",
        payload: { test: "payload" },
      });
    },
    Error,
    "Daemon API error: 400 - Invalid signal payload",
  );

  teardownFetchMock();
});

Deno.test("signal trigger tool - handles network errors", async () => {
  setupFetchMock((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/api/workspaces/workspace-1") && !url.includes("/signals/")) {
      return Promise.resolve(createMockResponse(mockWorkspaceEnabled));
    }

    if (url.includes("/api/workspaces/workspace-1/signals/webhook")) {
      return Promise.reject(new Error("Network error"));
    }

    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });

  const ctx = { daemonUrl: "http://localhost:8080", logger: mockLogger };

  await assertRejects(
    async () => {
      await signalTriggerToolLogic(ctx, {
        workspaceId: "workspace-1",
        signalName: "webhook",
        payload: { test: "payload" },
      });
    },
    Error,
    "Network error",
  );

  teardownFetchMock();
});

// Test Cases for Error Handling
Deno.test("signal tools - handle JSON parsing errors", async () => {
  setupFetchMock((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/api/workspaces/workspace-1/signals")) {
      return Promise.resolve(
        new Response("invalid json", {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });

  const ctx = { daemonUrl: "http://localhost:8080", logger: mockLogger };

  await assertRejects(
    async () => {
      await signalListToolLogic(ctx, { workspaceId: "workspace-1" });
    },
    Error,
    "Daemon API error: 500 - Internal Server Error",
  );

  teardownFetchMock();
});

Deno.test("signal tools - handle server errors", async () => {
  setupFetchMock((input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();

    if (url.includes("/api/workspaces/workspace-1/signals")) {
      return Promise.resolve(createMockErrorResponse(500, "Internal Server Error", "Server error"));
    }

    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });

  const ctx = { daemonUrl: "http://localhost:8080", logger: mockLogger };

  await assertRejects(
    async () => {
      await signalListToolLogic(ctx, { workspaceId: "workspace-1" });
    },
    Error,
    "Daemon API error: 500 - Server error",
  );

  teardownFetchMock();
});
