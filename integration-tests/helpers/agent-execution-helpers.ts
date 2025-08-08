/**
 * Agent Execution Helpers for Integration Testing
 *
 * Utilities for executing agents and capturing results during testing.
 */

import type { AgentExecutionResult, AgentSessionData, AtlasAgent } from "@atlas/agent-sdk";
import { createAgent } from "@atlas/agent-sdk";
import type { MCPServerConfig } from "@atlas/config";
import type { AtlasAgentsMCPServer } from "../../packages/core/src/agent-server/server.ts";

/**
 * Create a test agent with optional MCP server configuration
 */
export function createTestAgent(config: {
  id: string;
  name?: string;
  mcpServers?: Record<string, MCPServerConfig>;
  handler?: (prompt: string, context: any) => Promise<any>;
}): AtlasAgent {
  return createAgent({
    id: config.id,
    name: config.name || config.id,
    version: "1.0.0",
    description: `Test agent: ${config.id}`,
    expertise: {
      domains: ["testing"],
      capabilities: ["test execution"],
      examples: ["test something"],
    },
    mcp: config.mcpServers,
    handler: config.handler || (async (prompt, context) => {
      // Default handler that lists available MCP tools
      const tools: Record<string, any> = {};

      // Get tools from all MCP servers
      if (context.mcp) {
        const servers = config.mcpServers ? Object.keys(config.mcpServers) : [];
        for (const serverName of servers) {
          try {
            const serverTools = await context.mcp.getTools(serverName);
            Object.assign(tools, serverTools);
          } catch (error) {
            console.error(`Error getting tools from ${serverName}:`, error);
          }
        }
      }

      return {
        type: "text",
        content: JSON.stringify({
          prompt,
          availableTools: Object.keys(tools),
          mcpServers: config.mcpServers ? Object.keys(config.mcpServers) : [],
        }),
      };
    }),
  });
}

/**
 * Create an agent that uses specific MCP tools
 */
export function createMCPToolAgent(config: {
  id: string;
  mcpServers: Record<string, MCPServerConfig>;
  toolHandlers: Record<string, (prompt: string, context: any) => Promise<any>>;
}): AtlasAgent {
  return createAgent({
    id: config.id,
    name: config.id,
    version: "1.0.0",
    description: `MCP tool agent: ${config.id}`,
    expertise: {
      domains: ["testing", "mcp"],
      capabilities: Object.keys(config.toolHandlers),
      examples: Object.keys(config.toolHandlers).map((tool) => `use ${tool}`),
    },
    mcp: config.mcpServers,
    handler: async (prompt, context) => {
      // Match prompt to tool handler
      for (const [toolName, handler] of Object.entries(config.toolHandlers)) {
        if (prompt.includes(toolName)) {
          return await handler(prompt, context);
        }
      }

      // Default: list available tools
      const tools: string[] = [];
      for (const serverName of Object.keys(config.mcpServers)) {
        try {
          const serverTools = await context.mcp.getTools(serverName);
          tools.push(...Object.keys(serverTools));
        } catch {
          // Ignore errors
        }
      }

      return {
        type: "text",
        content: `Available tools: ${tools.join(", ")}`,
      };
    },
  });
}

/**
 * Execute an agent and capture the result
 */
export async function executeAgent(
  server: AtlasAgentsMCPServer,
  agentId: string,
  prompt: string,
  sessionData?: Partial<AgentSessionData>,
): Promise<AgentExecutionResult> {
  const defaultSession: AgentSessionData = {
    sessionId: sessionData?.sessionId || `test-session-${Date.now()}`,
    workspaceId: sessionData?.workspaceId || "test-workspace",
    userId: sessionData?.userId || "test-user",
  };

  const mergedSession = { ...defaultSession, ...sessionData };

  return await server.executeAgent(agentId, prompt, mergedSession);
}

/**
 * Create session data factory for testing
 */
export function createSessionData(overrides?: Partial<AgentSessionData>): AgentSessionData {
  return {
    sessionId: `session-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    workspaceId: "test-workspace",
    userId: "test-user",
    ...overrides,
  };
}

/**
 * Result validator for agent execution
 */
export class AgentExecutionValidator {
  private result: AgentExecutionResult;

  constructor(result: AgentExecutionResult) {
    this.result = result;
  }

  hasResponse(): boolean {
    return !!this.result.response;
  }

  getResponseText(): string | undefined {
    if (this.result.response && this.result.response.type === "text") {
      return this.result.response.content;
    }
    return undefined;
  }

  getResponseJson<T = any>(): T | undefined {
    const text = this.getResponseText();
    if (!text) return undefined;

    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }

  hasError(): boolean {
    return !!this.result.error;
  }

  getError(): any {
    return this.result.error;
  }

  hasMetadata(): boolean {
    return !!this.result.metadata;
  }

  getMetadata(): any {
    return this.result.metadata;
  }
}

/**
 * Batch execute multiple agents for testing
 */
export async function batchExecuteAgents(
  server: AtlasAgentsMCPServer,
  executions: Array<{
    agentId: string;
    prompt: string;
    sessionData?: Partial<AgentSessionData>;
  }>,
): Promise<AgentExecutionResult[]> {
  return await Promise.all(
    executions.map(({ agentId, prompt, sessionData }) =>
      executeAgent(server, agentId, prompt, sessionData)
    ),
  );
}

/**
 * Execute agent with timeout
 */
export async function executeAgentWithTimeout(
  server: AtlasAgentsMCPServer,
  agentId: string,
  prompt: string,
  sessionData: Partial<AgentSessionData>,
  timeoutMs: number,
): Promise<AgentExecutionResult> {
  const timeoutPromise = new Promise<AgentExecutionResult>((_, reject) => {
    setTimeout(
      () => reject(new Error(`Agent execution timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  const executionPromise = executeAgent(server, agentId, prompt, sessionData);

  return await Promise.race([executionPromise, timeoutPromise]);
}
