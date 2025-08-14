/**
 * Mock MCP HTTP Server for testing
 *
 * Implements minimal MCP protocol over HTTP to test the orchestrator
 */

import type { TestAgentResponse } from "./test-helpers.ts";
import { createLogger } from "@atlas/logger";

const logger = createLogger({ test: "mock-mcp-server" });

interface MCPRequest {
  jsonrpc: string;
  id: number | string;
  method: string;
  params?: any;
}

interface MCPResponse {
  jsonrpc: string;
  id: number | string;
  result?: any;
  error?: any;
}

export class MockMCPServer {
  private abortController: AbortController;

  constructor(private port: number) {
    this.abortController = new AbortController();
  }

  async start(): Promise<void> {
    Deno.serve({
      port: this.port,
      signal: this.abortController.signal,
      onListen: () => {
        logger.debug("Mock MCP server listening", { port: this.port });
      },
      handler: async (req) => {
        const url = new URL(req.url);

        // Handle SSE endpoint for streaming
        if (url.pathname === "/sse") {
          return this.handleSSE(req);
        }

        // Handle JSON-RPC requests
        if (req.method === "POST") {
          return await this.handleJSONRPC(req);
        }

        return new Response("Not Found", { status: 404 });
      },
    });
  }

  private async handleJSONRPC(req: Request): Promise<Response> {
    try {
      const body = await req.text();
      const request: MCPRequest = JSON.parse(body);

      logger.debug("Mock MCP received request", {
        method: request.method,
        id: request.id,
        params: request.params,
      });

      let response: MCPResponse;

      switch (request.method) {
        case "initialize":
          response = {
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: "2025-06-18",
              serverInfo: {
                name: "mock-mcp-server",
                version: "1.0.0",
              },
              capabilities: {
                tools: {},
              },
            },
          };
          break;

        case "tools/list":
          response = {
            jsonrpc: "2.0",
            id: request.id,
            result: {
              tools: [{
                name: "test-agent",
                description: "Test agent for orchestrator integration testing",
                inputSchema: {
                  type: "object",
                  properties: {
                    prompt: { type: "string" },
                    context: { type: "object" },
                    _sessionContext: { type: "object" },
                  },
                  required: ["prompt"],
                },
              }],
            },
          };
          break;

        case "resources/list":
          response = {
            jsonrpc: "2.0",
            id: request.id,
            result: {
              resources: [{
                uri: "agent://test-agent",
                name: "test-agent",
                description: "Test agent for orchestrator integration testing",
                metadata: {
                  expertise: {
                    domains: ["testing"],
                    capabilities: ["echo messages", "simple calculations"],
                    examples: ["echo hello world", "calculate 2 + 2"],
                  },
                },
              }],
            },
          };
          break;

        case "tools/call":
          response = await this.handleToolCall(request);
          break;

        default:
          response = {
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32601,
              message: `Method not found: ${request.method}`,
            },
          };
      }

      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      logger.error("Error handling JSON-RPC request", { error });
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: "Parse error",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
  }

  private async handleToolCall(request: MCPRequest): Promise<MCPResponse> {
    const { name, arguments: args } = request.params;

    if (name !== "test-agent") {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32602,
          message: `Unknown tool: ${name}`,
        },
      };
    }

    // Simulate agent execution
    const prompt = args.prompt;
    let agentResult: TestAgentResponse;

    if (prompt.toLowerCase().includes("echo")) {
      const message = prompt.replace(/echo/i, "").trim();
      agentResult = {
        type: "echo",
        message: message || "No message to echo",
        sessionId: args._sessionContext?.sessionId || "unknown",
        timestamp: new Date().toISOString(),
      };
    } else if (prompt.toLowerCase().includes("calculate")) {
      const match = prompt.match(/(\d+)\s*\+\s*(\d+)/);
      if (match && match[1] && match[2]) {
        const a = parseInt(match[1]);
        const b = parseInt(match[2]);
        agentResult = {
          type: "calculation",
          expression: `${a} + ${b}`,
          result: a + b,
          timestamp: new Date().toISOString(),
        };
      } else {
        agentResult = {
          type: "unknown",
          message: "Invalid calculation",
          prompt,
          timestamp: new Date().toISOString(),
        };
      }
    } else {
      agentResult = {
        type: "unknown",
        message: "I don't understand that request",
        prompt,
        timestamp: new Date().toISOString(),
      };
    }

    // Wrap in the expected MCP response format
    const executionResult = {
      type: "completed",
      result: agentResult,
    };

    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [{
          type: "text",
          text: JSON.stringify(executionResult),
        }],
      },
    };
  }

  private handleSSE(_req: Request): Response {
    // Return SSE stream for notifications
    const stream = new ReadableStream({
      start(controller) {
        // Send initial connection event
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('event: open\ndata: {"type":"connection"}\n\n'));

        // Keep connection alive with periodic pings
        const interval = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(":ping\n\n"));
          } catch {
            clearInterval(interval);
          }
        }, 30000);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }

  stop(): void {
    this.abortController.abort();
  }
}
