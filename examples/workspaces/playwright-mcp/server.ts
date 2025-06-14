import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { prettyJSON } from "hono/pretty-json";
import { HTTPException } from "hono/http-exception";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

// Simple server that wraps Playwright MCP and exposes it via HTTP
// This demonstrates how to integrate an existing MCP server with Atlas

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: string;
    properties?: Record<string, JsonValue>;
    required?: string[];
  };
}

interface MCPToolsListResponse {
  tools: Array<{
    name: string;
    description?: string;
    inputSchema: {
      type: string;
      properties?: Record<string, JsonValue>;
      required?: string[];
    };
  }>;
}

interface MCPToolCallResponse {
  content: JsonValue;
  isError?: boolean;
}

interface ExecutionRequest {
  tool: string;
  arguments: Record<string, JsonValue>;
}

interface ExecutionResult {
  success: boolean;
  content?: JsonValue;
  error?: string;
}

class PlaywrightMCPWrapper {
  private client: Client;
  private transport: StdioClientTransport;
  private connected = false;
  private tools: MCPTool[] = [];

  constructor() {
    this.client = new Client({
      name: "atlas-playwright-wrapper",
      version: "1.0.0",
    });

    // Create stdio transport to communicate with Playwright MCP server
    this.transport = new StdioClientTransport({
      command: "npx",
      args: ["-y", "@playwright/mcp"],
      env: Deno.env.toObject(),
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;

    try {
      await this.client.connect(this.transport);
      this.connected = true;

      // Load available tools
      await this.loadTools();

      console.log(`🎭 Connected to Playwright MCP server with ${this.tools.length} tools`);
    } catch (error) {
      console.error("Failed to connect to Playwright MCP:", error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`MCP connection failed: ${errorMessage}`);
    }
  }

  private async loadTools(): Promise<void> {
    try {
      const response = await this.client.request(
        {
          method: "tools/list",
          params: {},
        },
        z.object({
          tools: z.array(z.object({
            name: z.string(),
            description: z.string().optional(),
            inputSchema: z.object({
              type: z.string(),
              properties: z.record(z.unknown()).optional(),
              required: z.array(z.string()).optional(),
            }),
          })),
        }),
      ) as MCPToolsListResponse;

      this.tools = (response.tools || []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    } catch (error) {
      console.error("Failed to load MCP tools:", error);
      throw error;
    }
  }

  async getTools(): Promise<MCPTool[]> {
    await this.connect();
    return this.tools;
  }

  async executeTool(request: ExecutionRequest): Promise<ExecutionResult> {
    await this.connect();

    try {
      const response = await this.client.request(
        {
          method: "tools/call",
          params: {
            name: request.tool,
            arguments: request.arguments,
          },
        },
        z.object({
          content: z.unknown(),
          isError: z.boolean().optional(),
        }),
      ) as MCPToolCallResponse;

      return {
        success: !response.isError,
        content: response.content,
        error: response.isError ? "Tool execution failed" : undefined,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  async getHealth(): Promise<{ status: string; tools_count: number }> {
    try {
      await this.connect();
      return {
        status: "healthy",
        tools_count: this.tools.length,
      };
    } catch (_error) {
      return {
        status: "unhealthy",
        tools_count: 0,
      };
    }
  }

  async dispose(): Promise<void> {
    if (this.connected && this.transport) {
      await this.transport.close();
      this.connected = false;
    }
  }
}

const mcpWrapper = new PlaywrightMCPWrapper();
const app = new Hono();

// Middleware
app.use("*", cors());
app.use("*", logger());
app.use("*", prettyJSON());

// Error handler
app.onError((err, c) => {
  console.error("Server error:", err);

  if (err instanceof HTTPException) {
    return c.json({ error: err.message }, err.status);
  }

  return c.json({ error: "Internal server error" }, 500);
});

// Health check endpoint
app.get("/ping", async (c) => {
  const health = await mcpWrapper.getHealth();
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    mcp: health,
  });
});

// List available tools (MCP capabilities)
app.get("/tools", async (c) => {
  try {
    const tools = await mcpWrapper.getTools();
    return c.json({ tools });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new HTTPException(500, { message: `Failed to get tools: ${errorMessage}` });
  }
});

// Execute a Playwright tool
app.post("/execute", async (c) => {
  try {
    const body = await c.req.json() as ExecutionRequest;

    if (!body.tool) {
      throw new HTTPException(400, { message: "Missing 'tool' field" });
    }

    const result = await mcpWrapper.executeTool(body);

    if (!result.success) {
      return c.json({
        error: result.error,
        success: false,
      }, 400);
    }

    return c.json({
      success: true,
      content: result.content,
      tool: body.tool,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error;
    }
    throw new HTTPException(400, { message: "Invalid request body" });
  }
});

// MCP JSON-RPC 2.0 endpoint - this is what Atlas MCP adapter expects
app.post("/", async (c) => {
  try {
    const body = await c.req.json();

    // Validate JSON-RPC 2.0 structure
    if (!body.jsonrpc || body.jsonrpc !== "2.0" || !body.method) {
      return c.json({
        jsonrpc: "2.0",
        error: {
          code: -32600,
          message: "Invalid Request",
        },
        id: body.id || null,
      }, 400);
    }

    try {
      let result;

      switch (body.method) {
        case "initialize":
          // MCP initialization handshake
          result = {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: "playwright-mcp-wrapper",
              version: "1.0.0",
            },
          };
          break;

        case "tools/list":
          const tools = await mcpWrapper.getTools();
          result = {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description || `Playwright tool: ${tool.name}`,
              inputSchema: tool.inputSchema,
            })),
          };
          break;

        case "notifications/initialized":
          // MCP client notification that initialization is complete
          // This is a notification, so no JSON-RPC response should be sent
          return new Response("", { status: 200 });

        case "tools/call":
          if (!body.params || !body.params.name) {
            return c.json({
              jsonrpc: "2.0",
              error: {
                code: -32602,
                message: "Invalid params: missing tool name",
              },
              id: body.id,
            }, 400);
          }

          const toolResult = await mcpWrapper.executeTool({
            tool: body.params.name,
            arguments: body.params.arguments || {},
          });

          if (!toolResult.success) {
            result = {
              content: [{ type: "text", text: toolResult.error || "Tool execution failed" }],
              isError: true,
            };
          } else {
            // Convert tool result to MCP format - handle different content types
            let contentText: string;

            if (typeof toolResult.content === "string") {
              contentText = toolResult.content;
            } else if (toolResult.content === null || toolResult.content === undefined) {
              contentText = "Tool executed successfully";
            } else if (typeof toolResult.content === "object") {
              // Handle objects properly - check if it has meaningful properties
              try {
                contentText = JSON.stringify(toolResult.content, null, 2);
              } catch {
                contentText = String(toolResult.content);
              }
            } else {
              contentText = String(toolResult.content);
            }

            result = {
              content: [{ type: "text", text: contentText }],
              isError: false,
            };
          }
          break;

        default:
          return c.json({
            jsonrpc: "2.0",
            error: {
              code: -32601,
              message: `Method not found: ${body.method}`,
            },
            id: body.id,
          }, 404);
      }

      return c.json({
        jsonrpc: "2.0",
        result,
        id: body.id,
      });
    } catch (error) {
      console.error("MCP method execution error:", error);
      return c.json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal error",
          data: error instanceof Error ? error.message : String(error),
        },
        id: body.id,
      }, 500);
    }
  } catch (error) {
    console.error("MCP request parsing error:", error);
    return c.json({
      jsonrpc: "2.0",
      error: {
        code: -32700,
        message: "Parse error",
      },
      id: null,
    }, 400);
  }
});

// Get tool details
app.get("/tools/:name", async (c) => {
  try {
    const toolName = c.req.param("name");
    const tools = await mcpWrapper.getTools();
    const tool = tools.find((t) => t.name === toolName);

    if (!tool) {
      throw new HTTPException(404, { message: `Tool '${toolName}' not found` });
    }

    return c.json(tool);
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new HTTPException(500, { message: `Failed to get tool: ${errorMessage}` });
  }
});

// Graceful shutdown
Deno.addSignalListener("SIGINT", async () => {
  console.log("🛑 Shutting down Playwright MCP wrapper...");
  await mcpWrapper.dispose();
  Deno.exit(0);
});

Deno.addSignalListener("SIGTERM", async () => {
  console.log("🛑 Shutting down Playwright MCP wrapper...");
  await mcpWrapper.dispose();
  Deno.exit(0);
});

// Start server
const port = parseInt(Deno.env.get("PORT") || "8001");

console.log(`🎭 Playwright MCP Wrapper starting on port ${port}`);
console.log(`📡 Available endpoints:`);
console.log(`   GET  /ping               - Health check`);
console.log(`   GET  /tools              - List available Playwright tools`);
console.log(`   GET  /tools/{name}       - Get tool details`);
console.log(`   POST /execute            - Execute Playwright tool (HTTP API)`);
console.log(`   POST /                   - MCP JSON-RPC 2.0 endpoint (for Atlas)`);
console.log(`\n🤖 This server wraps the Playwright MCP from @microsoft/playwright-mcp`);
console.log(`\n📚 Example usage (HTTP API):`);
console.log(`   curl -X POST http://localhost:${port}/execute \\`);
console.log(`     -H "Content-Type: application/json" \\`);
console.log(`     -d '{"tool":"navigate","arguments":{"url":"https://example.com"}}'`);
console.log(`\n📚 Example usage (MCP JSON-RPC):`);
console.log(`   curl -X POST http://localhost:${port}/ \\`);
console.log(`     -H "Content-Type: application/json" \\`);
console.log(`     -d '{"jsonrpc":"2.0","method":"tools/list","params":{},"id":1}'`);

Deno.serve({ port }, app.fetch);
