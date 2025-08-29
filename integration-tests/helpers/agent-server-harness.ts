/**
 * Atlas Agent MCP Server Test Harness
 *
 * Minimal test harness for E2E testing of the Atlas Agent MCP Server.
 * Supports server instantiation with test agents, direct execution,
 * and testing of streaming, notifications, and progress tracking.
 *
 * Notes:
 * - I don't like that the Agent server has to fetch back to the daemon for workspace configuration.
 */

import type { AgentExecutionResult, AgentSessionData, AtlasAgent } from "@atlas/agent-sdk";
import type { MCPServerConfig } from "@atlas/config";
import { createLogger, type Logger } from "@atlas/logger";
import { MCPManager } from "@atlas/mcp";
import { StreamableHTTPTransport } from "@hono/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hono } from "hono";
import { GlobalMCPServerPool } from "../../packages/core/mod.ts";
import {
  AtlasAgentsMCPServer,
  InMemoryAgentRegistry,
} from "../../packages/core/src/agent-server/mod.ts";

/**
 * Mock MCP server pool that prevents real connections in tests
 * @TODO: Convert the GlobalMCPServerPool into an abstract class
 * rather than extending and overriding methods w/ Reflect.
 */
class MockMCPServerPool extends GlobalMCPServerPool {
  constructor(logger: Logger) {
    super(logger);
    // Override cleanup timer to prevent it from running
    // The timer is started in the parent constructor, so we need to clear it immediately
    const timer = Reflect.get(this, "cleanupTimer");
    if (timer) {
      clearInterval(timer);
      Reflect.set(this, "cleanupTimer", undefined);
    }
  }

  override getMCPManager(_serverConfigsMap: Record<string, MCPServerConfig>): Promise<MCPManager> {
    // Return empty manager without creating real connections
    return Promise.resolve(new MCPManager());
  }

  override async dispose(): Promise<void> {
    // Ensure cleanup timer is cleared on dispose as well
    const timer = Reflect.get(this, "cleanupTimer");
    if (timer) {
      clearInterval(timer);
      Reflect.set(this, "cleanupTimer", undefined);
    }
  }
}

/**
 * Test harness configuration options
 */
export interface TestHarnessOptions {
  /** Array of test agents to register on startup */
  agents?: AtlasAgent[];
  /** Enable memory support (defaults to false) */
  enableMemory?: boolean;
  /** Enable approval flows (defaults to false) */
  enableApprovals?: boolean;
}

/**
 * Agent MCP Test Harness
 *
 * Provides a controlled environment for testing Atlas agents.
 * Uses direct server calls for simplicity and reliability in testing.
 */
export class AgentMCPTestHarness {
  private server: AtlasAgentsMCPServer;
  private registry: InMemoryAgentRegistry;
  private logger = createLogger();
  private testAgents = new Map<string, AtlasAgent>();
  private mockServerPool: MockMCPServerPool;
  private sessionId = "test-session";
  private isRunning = false;
  private mcpClient: Client | null = null;
  private honoApp: Hono | null = null;
  private httpServer: Deno.HttpServer | null = null;
  private mockDaemonServer: Deno.HttpServer | null = null;
  private mockDaemonAbortController: AbortController | null = null;
  private port: number = 0; // Let Deno pick a free port
  private serverUrl: string | null = null;
  private daemonPort: number = 0; // Let Deno pick a free port for mock daemon too

  constructor(options?: TestHarnessOptions) {
    this.registry = new InMemoryAgentRegistry();
    this.mockServerPool = new MockMCPServerPool(this.logger);

    // Create the MCP server with test configuration
    this.server = AtlasAgentsMCPServer.create({
      daemonUrl: "http://localhost:8080",
      logger: this.logger,
      agentRegistry: this.registry,
      mcpServerPool: this.mockServerPool,
      sessionId: this.sessionId,
      hasActiveSSE: () => false,
    });

    // Register initial agents if provided
    if (options?.agents) {
      for (const agent of options.agents) {
        this.addAgent(agent);
      }
    }
  }

  /**
   * Add a test agent to the harness
   */
  async addAgent(agent: AtlasAgent): Promise<void> {
    const agentId = agent.metadata.id;
    this.testAgents.set(agentId, agent);
    await this.registry.registerAgent(agent);

    // If server is already running, register the agent with it
    if (this.isRunning) {
      await this.server.registerAgent(agent);
    }

    this.logger.info("Added test agent", { agentId, displayName: agent.metadata.displayName });
  }

  /**
   * Start the server for testing
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error("Test harness is already running");
    }

    // Register all test agents with the server
    for (const agent of this.testAgents.values()) {
      await this.server.registerAgent(agent);
    }

    // Skip mock daemon - tests work fine without it, just with a logged error
    // await this.startMockDaemon();

    // Start the MCP server
    await this.server.start();

    // Create Hono app for HTTP/SSE transport
    this.honoApp = new Hono();

    // Set up MCP endpoint
    this.honoApp.all("/mcp", async (c) => {
      const transport = new StreamableHTTPTransport();
      await this.server.getServer().connect(transport);
      return transport.handleRequest(c);
    });

    // Start HTTP server using Deno.serve with port 0 (auto-assign)
    this.httpServer = Deno.serve({ port: 0, handler: this.honoApp.fetch });

    // Get the actual port from the server
    const addr = this.httpServer.addr;
    if (!addr || addr.transport !== "tcp") {
      throw new Error("Failed to get server address");
    }
    this.port = addr.port;
    this.serverUrl = `http://localhost:${this.port}/mcp`;
    this.isRunning = true;
    this.logger.info("Test harness started", {
      sessionId: this.sessionId,
      port: this.port,
      url: this.serverUrl,
    });
  }

  /**
   * Connect an MCP client to the server
   * This creates a real MCP connection using StreamableHTTP transport
   */
  async connectMCPClient(): Promise<Client> {
    if (this.mcpClient) {
      return this.mcpClient;
    }

    if (!this.isRunning || !this.serverUrl) {
      throw new Error("Server must be started before connecting client");
    }

    // Create MCP client
    this.mcpClient = new Client(
      { name: "test-harness-client", version: "1.0.0" },
      { capabilities: {} },
    );

    // Create HTTP transport for the client
    const transport = new StreamableHTTPClientTransport(new URL(this.serverUrl), {
      sessionId: this.sessionId,
    });

    // Connect client to server via HTTP transport
    await this.mcpClient.connect(transport);

    this.logger.info("MCP client connected", { url: this.serverUrl, sessionId: this.sessionId });

    return this.mcpClient;
  }

  private activeRequestIds = new Map<string, string>(); // Track requestId per agent execution

  /**
   * Execute an agent via MCP protocol
   */
  async executeAgent(
    agentId: string,
    prompt: string,
    sessionData?: Partial<AgentSessionData>,
  ): Promise<AgentExecutionResult> {
    if (!this.isRunning) {
      throw new Error("Test harness not started. Call start() first.");
    }

    // Ensure client is connected
    const client = await this.connectMCPClient();

    const session: AgentSessionData = {
      sessionId: sessionData?.sessionId || this.sessionId,
      workspaceId: sessionData?.workspaceId || "test-workspace",
      userId: sessionData?.userId || "test-user",
      ...sessionData,
    };

    // Generate and track requestId for this execution
    const requestId = crypto.randomUUID();
    const executionKey = `${agentId}:${session.sessionId}`;
    this.activeRequestIds.set(executionKey, requestId);

    try {
      // Execute agent via MCP tool call with requestId in _meta
      const result = await client.callTool({
        name: agentId,
        arguments: { prompt, _sessionContext: session },
        _meta: { requestId },
      });

      // Parse the tool result to match AgentExecutionResult format
      // The MCP protocol returns content array, we need to extract the actual result
      const resultContent = result.content as Array<{ type: string; text?: string }>;
      if (resultContent && resultContent.length > 0) {
        const content = resultContent[0];
        if (content && content.type === "text" && content.text) {
          // Try to parse as JSON if it looks like JSON
          try {
            const parsed = JSON.parse(content.text);
            return { type: "completed", result: parsed } as AgentExecutionResult;
          } catch {
            // Not JSON, return as-is
            return { type: "completed", result: content.text } as AgentExecutionResult;
          }
        }
      }

      // Fallback for unexpected format
      return { type: "completed", result: result } as AgentExecutionResult;
    } catch (error) {
      this.logger.error("Failed to execute agent via MCP", { agentId, error });
      throw error;
    }
  }

  /**
   * List available agents via MCP protocol
   */
  async listAgents(): Promise<Array<{ id: string }>> {
    // Ensure client is connected
    const client = await this.connectMCPClient();

    // List tools available via MCP
    const tools = await client.listTools();

    return tools.tools.map((tool) => ({
      id: tool.name,
      displayName: tool.name,
      description: tool.description || "",
    }));
  }

  /**
   * Start a mock daemon server to handle workspace config requests
   */
  private async startMockDaemon(): Promise<void> {
    // Create AbortController for clean shutdown
    this.mockDaemonAbortController = new AbortController();

    // Create a simple HTTP server to respond to workspace config requests
    this.mockDaemonServer = Deno.serve({
      port: this.daemonPort,
      hostname: "localhost",
      signal: this.mockDaemonAbortController.signal,
      handler: (req) => {
        const url = new URL(req.url);

        // Handle workspace config request
        if (url.pathname.includes("/api/workspaces/") && url.pathname.includes("/config")) {
          return new Response(
            JSON.stringify({
              workspace: { name: "Test Workspace", id: "test-workspace", version: "1.0.0" },
              agents: {},
              llms: {},
              tools: {},
              mcpServers: {},
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                Connection: "close", // Force connection to close after response
              },
            },
          );
        }

        // Handle other requests with minimal response
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            Connection: "close", // Force connection to close after response
          },
        });
      },
    });

    // Wait a bit for the server to start
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  /**
   * Get the underlying server instance for advanced testing
   */
  getServer(): AtlasAgentsMCPServer {
    return this.server;
  }

  /**
   * Get the underlying MCP client instance (if connected)
   */
  getMCPClient(): Client | null {
    return this.mcpClient;
  }

  /**
   * Get the current requestId for an agent execution
   */
  getRequestId(agentId: string, sessionId?: string): string | undefined {
    const key = `${agentId}:${sessionId || this.sessionId}`;
    return this.activeRequestIds.get(key);
  }

  /**
   * Send a cancellation notification via MCP protocol
   * This is for testing the cancellation flow
   */
  async sendCancellationNotification(requestId?: string, reason?: string): Promise<void> {
    if (!this.mcpClient) {
      throw new Error("MCP client not connected");
    }

    // If no requestId provided, use the last one tracked
    const actualRequestId = requestId || Array.from(this.activeRequestIds.values()).pop();
    if (!actualRequestId) {
      throw new Error("No requestId available for cancellation");
    }

    // Send cancellation notification using the client's notification method
    // This will be used to test agent cancellation later
    await this.mcpClient.notification({
      method: "notifications/cancelled",
      params: { requestId: actualRequestId, reason: reason || "Test cancellation" },
    });
  }

  /**
   * Get test statistics
   */
  getStats(): {
    registeredAgents: number;
    isRunning: boolean;
    sessionId: string;
    port?: number;
    url?: string;
  } {
    return {
      registeredAgents: this.testAgents.size,
      isRunning: this.isRunning,
      sessionId: this.sessionId,
      port: this.port,
      url: this.serverUrl || undefined,
    };
  }

  /**
   * Stop the harness and cleanup resources
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    // Disconnect MCP client if connected
    if (this.mcpClient) {
      await this.mcpClient.close();
      this.mcpClient = null;
    }

    // Stop HTTP server and wait for it to finish
    if (this.httpServer) {
      try {
        await this.httpServer.shutdown();
        // Also wait for the finished promise to ensure complete cleanup
        await this.httpServer.finished;
      } catch {
        // Ignore errors during shutdown
      }
      this.httpServer = null;
    }

    // Skip mock daemon cleanup since we're not starting it
    // if (this.mockDaemonAbortController) {
    //   this.mockDaemonAbortController.abort();
    //   this.mockDaemonAbortController = null;
    // }

    // Stop MCP server
    await this.server.stop();

    // Cleanup mock server pool
    await this.mockServerPool.dispose();

    this.isRunning = false;
    this.serverUrl = null;
    this.logger.info("Test harness stopped");
  }
}
