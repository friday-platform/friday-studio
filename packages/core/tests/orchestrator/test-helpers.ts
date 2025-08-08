/**
 * Test infrastructure for Atlas orchestrator integration tests
 *
 * Creates the minimal Atlas environment needed for testing: mock daemon/platform servers
 * provide workspace config, mock MCP server hosts test agents, orchestrator connects as client.
 * Tests the complete Atlas agent execution pipeline without full daemon setup.
 */

import { createAgent } from "@atlas/agent-sdk";
import { AgentOrchestrator } from "../../src/orchestrator/agent-orchestrator.ts";
import { createLogger } from "@atlas/logger";
import { MockMCPServer } from "./mock-mcp-server.ts";

/** Base ports for test servers - incremented per test to avoid conflicts */
export const TestPorts = {
  daemon: 8765,
  mcp: 9876,
  platform: 8080,
};

/** Test agent response types for echo, calculation, and unknown commands */
export interface EchoResponse {
  type: "echo";
  message: string;
  sessionId: string;
  timestamp: string;
}

export interface CalculationResponse {
  type: "calculation";
  expression: string;
  result: number;
  timestamp: string;
}

export interface UnknownResponse {
  type: "unknown";
  message: string;
  prompt: string;
  timestamp: string;
}

export type TestAgentResponse = EchoResponse | CalculationResponse | UnknownResponse;

/** Test agent with predictable responses: echo, simple math, unknown command handling */
export const createTestAgent = () =>
  createAgent({
    id: "test-agent",
    displayName: "Test Agent",
    version: "1.0.0",
    description: "Test agent for orchestrator integration testing",

    expertise: {
      domains: ["testing"],
      capabilities: ["echo messages", "simple calculations"],
      examples: ["echo hello world", "calculate 2 + 2"],
    },

    handler: (prompt, context): Promise<TestAgentResponse> => {
      // Simple echo command handler
      if (prompt.toLowerCase().includes("echo")) {
        const message = prompt.replace(/echo/i, "").trim();
        return Promise.resolve({
          type: "echo",
          message: message || "No message to echo",
          sessionId: context.session.sessionId,
          timestamp: new Date().toISOString(),
        });
      }

      // Simple calculation handler (addition only)
      if (prompt.toLowerCase().includes("calculate")) {
        const match = prompt.match(/(\d+)\s*\+\s*(\d+)/);
        if (match && match[1] && match[2]) {
          const a = parseInt(match[1]);
          const b = parseInt(match[2]);
          return Promise.resolve({
            type: "calculation",
            expression: `${a} + ${b}`,
            result: a + b,
            timestamp: new Date().toISOString(),
          });
        }
      }

      // Unknown command handler
      return Promise.resolve({
        type: "unknown",
        message: "I don't understand that request",
        prompt,
        timestamp: new Date().toISOString(),
      });
    },
  });

/** Complete test setup with all required servers and components */
export interface TestSetup {
  mcpServer: MockMCPServer;
  orchestrator: AgentOrchestrator;
  daemonController: AbortController;
  platformController: AbortController;
  ports: {
    daemon: number;
    mcp: number;
    platform: number;
  };
}

/** Sets up complete test environment: mock daemon/platform servers + mock MCP server/orchestrator */
export async function setupTestServers(): Promise<TestSetup> {
  const ports = {
    daemon: ++TestPorts.daemon,
    mcp: ++TestPorts.mcp,
    platform: ++TestPorts.platform,
  };

  const testLogger = createLogger({ test: "orchestrator-integration" });

  // Mock daemon server provides workspace configuration
  const daemonController = new AbortController();
  Deno.serve({
    port: ports.daemon,
    signal: daemonController.signal,
    onListen: () => {},
    handler: (req) => {
      const url = new URL(req.url);

      if (url.pathname.includes("/api/workspaces/") && url.pathname.includes("/config")) {
        return new Response(
          JSON.stringify({
            config: {
              name: "test-workspace",
              description: "Test workspace",
              tools: {
                mcp: {
                  servers: {}, // No workspace MCP servers for testing
                },
              },
              agents: {},
              mcp_servers: {},
            },
          }),
          {
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      return new Response(JSON.stringify({ message: "NOT FOUND" }), {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    },
  });

  // Mock platform server
  const platformController = new AbortController();
  Deno.serve({
    port: ports.platform,
    signal: platformController.signal,
    onListen: () => {},
    handler: () => new Response("Mock atlas-platform MCP", { status: 200 }),
  });

  // Start mock MCP server
  const mcpServer = new MockMCPServer(ports.mcp);
  await mcpServer.start();

  // Wait a bit for server to be ready
  await new Promise((resolve) => setTimeout(resolve, 100));

  const orchestrator = new AgentOrchestrator(
    {
      agentsServerUrl: `http://localhost:${ports.mcp}`,
      executionTimeout: 30000,
    },
    testLogger,
  );

  await orchestrator.initialize();

  return {
    mcpServer,
    orchestrator,
    daemonController,
    platformController,
    ports,
  };
}

/** Properly shuts down all test components in correct order */
export async function cleanupTestServers(setup: TestSetup): Promise<void> {
  try {
    await setup.orchestrator.shutdown();
  } catch (e) {
    console.error("Error shutting down orchestrator:", e);
  }

  try {
    setup.mcpServer.stop();
  } catch (e) {
    console.error("Error stopping MCP server:", e);
  }

  setup.daemonController.abort();
  setup.platformController.abort();

  await new Promise((resolve) => setTimeout(resolve, 500));
}
