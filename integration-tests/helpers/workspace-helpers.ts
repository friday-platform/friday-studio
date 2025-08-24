/**
 * Workspace Configuration Helpers for Integration Testing
 *
 * Provides utilities for creating mock workspace configurations
 * with MCP server setups for testing agent-workspace interactions.
 */

import type { MCPServerConfig, WorkspaceConfig } from "@atlas/config";

/**
 * Creates a test workspace configuration
 */
export function createTestWorkspace(config: {
  id: string;
  name: string;
  path?: string;
  mcpServers?: Record<string, MCPServerConfig>;
  agents?: string[];
}): WorkspaceConfig {
  return {
    name: config.name,
    version: "1.0.0",
    description: `Test workspace: ${config.name}`,
    metadata: { id: config.id, path: config.path || `/test/workspaces/${config.id}` },
    tools: { mcp: { servers: config.mcpServers || {} } },
    agents: config.agents || [],
  };
}

/**
 * Creates an MCP server configuration for stdio transport
 */
export function createStdioMCPConfig(
  command: string,
  args: string[],
  tools?: { allow?: string[]; deny?: string[] },
): MCPServerConfig {
  return { transport: { type: "stdio", command, args }, tools };
}

/**
 * Creates an MCP server configuration for SSE/HTTP transport
 */
export function createHttpMCPConfig(
  url: string,
  tools?: { allow?: string[]; deny?: string[] },
): MCPServerConfig {
  return { transport: { type: "sse", url }, tools };
}

/**
 * Creates a workspace with filesystem MCP server
 */
export function createWorkspaceWithFilesystemServer(id: string): WorkspaceConfig {
  return createTestWorkspace({
    id,
    name: `Workspace with Filesystem - ${id}`,
    mcpServers: {
      filesystem: createStdioMCPConfig("deno", [
        "run",
        "--allow-all",
        "./integration-tests/mocks/file-tools-mcp-server.ts",
      ]),
    },
  });
}

/**
 * Creates a workspace with multiple MCP servers
 */
export function createWorkspaceWithMultipleServers(id: string): WorkspaceConfig {
  return createTestWorkspace({
    id,
    name: `Multi-Server Workspace - ${id}`,
    mcpServers: {
      filesystem: createStdioMCPConfig("deno", [
        "run",
        "--allow-all",
        "./integration-tests/mocks/file-tools-mcp-server.ts",
      ]),
      weather: createStdioMCPConfig("deno", [
        "run",
        "--allow-all",
        "./integration-tests/mocks/weather-mcp-server.ts",
      ]),
      math: createStdioMCPConfig("deno", [
        "run",
        "--allow-all",
        "./integration-tests/mocks/math-mcp-server.ts",
      ]),
    },
  });
}

/**
 * Creates a workspace with filtered MCP servers
 */
export function createWorkspaceWithFilteredServers(id: string): WorkspaceConfig {
  return createTestWorkspace({
    id,
    name: `Filtered Workspace - ${id}`,
    mcpServers: {
      // Server with deny list
      filesystem: createStdioMCPConfig(
        "deno",
        ["run", "--allow-all", "./integration-tests/mocks/file-tools-mcp-server.ts"],
        { deny: ["file_write", "file_delete"] },
      ),
      // Server with allow list
      echo: createStdioMCPConfig(
        "deno",
        ["run", "--allow-all", "./integration-tests/mocks/echo-mcp-server.ts"],
        { allow: ["echo", "reverse"] },
      ),
    },
  });
}

/**
 * Mock workspace manager for testing
 */
export class MockWorkspaceManager {
  private workspaces = new Map<string, WorkspaceConfig>();

  addWorkspace(workspace: WorkspaceConfig): void {
    const id = workspace.metadata?.id || workspace.name;
    this.workspaces.set(id, workspace);
  }

  getWorkspace(id: string): WorkspaceConfig | undefined {
    return this.workspaces.get(id);
  }

  listWorkspaces(): WorkspaceConfig[] {
    return Array.from(this.workspaces.values());
  }

  clear(): void {
    this.workspaces.clear();
  }
}
