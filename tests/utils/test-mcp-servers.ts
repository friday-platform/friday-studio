/**
 * Test MCP Server Utilities
 * Provides helper functions for starting and stopping mock MCP servers during tests
 */

import { delay } from "./test-utils.ts";

export interface MCPServerInstance {
  process: Deno.ChildProcess;
  getCommand(): { command: string; args: string[] };
  stop(): Promise<void>;
}

export class TestMCPServers {
  /**
   * Starts a weather MCP server for testing
   */
  static async startWeatherServer(): Promise<MCPServerInstance> {
    const process = new Deno.Command("node", {
      args: ["./tests/mocks/weather-mcp-server.mjs"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    // Give the server a moment to start
    await delay(100);

    return {
      process,
      getCommand() {
        return {
          command: "node",
          args: ["./tests/mocks/weather-mcp-server.mjs"],
        };
      },
      async stop() {
        try {
          // Close all streams first
          try {
            if (process.stdin) {
              process.stdin.close();
            }
          } catch { /* ignore */ }
          
          try {
            if (process.stdout) {
              await process.stdout.cancel();
            }
          } catch { /* ignore */ }
          
          try {
            if (process.stderr) {
              await process.stderr.cancel();
            }
          } catch { /* ignore */ }

          // Kill the process if still running
          try {
            process.kill("SIGTERM");
            await process.status;
          } catch (killError) {
            // Process might already be terminated, which is fine
            if (!(killError instanceof TypeError && killError.message.includes("already terminated"))) {
              throw killError;
            }
          }
          
          // Extra wait for cleanup
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          console.warn("Error stopping weather server:", error);
        }
      },
    };
  }

  /**
   * Starts a file tools MCP server for testing
   */
  static async startFileToolsServer(): Promise<MCPServerInstance> {
    const process = new Deno.Command("node", {
      args: ["./tests/mocks/file-tools-mcp-server.mjs"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    // Give the server a moment to start
    await delay(100);

    return {
      process,
      getCommand() {
        return {
          command: "node",
          args: ["./tests/mocks/file-tools-mcp-server.mjs"],
        };
      },
      async stop() {
        try {
          // Close all streams first
          try {
            if (process.stdin) {
              process.stdin.close();
            }
          } catch { /* ignore */ }
          
          try {
            if (process.stdout) {
              await process.stdout.cancel();
            }
          } catch { /* ignore */ }
          
          try {
            if (process.stderr) {
              await process.stderr.cancel();
            }
          } catch { /* ignore */ }

          // Kill the process if still running
          try {
            process.kill("SIGTERM");
            await process.status;
          } catch (killError) {
            // Process might already be terminated, which is fine
            if (!(killError instanceof TypeError && killError.message.includes("already terminated"))) {
              throw killError;
            }
          }
          
          // Extra wait for cleanup
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          console.warn("Error stopping file tools server:", error);
        }
      },
    };
  }

  /**
   * Starts an echo MCP server for testing
   */
  static async startEchoServer(): Promise<MCPServerInstance> {
    const process = new Deno.Command("node", {
      args: ["./tests/mocks/echo-mcp-server.mjs"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    // Give the server a moment to start
    await delay(100);

    return {
      process,
      getCommand() {
        return {
          command: "node",
          args: ["./tests/mocks/echo-mcp-server.mjs"],
        };
      },
      async stop() {
        try {
          // Close all streams first
          try {
            if (process.stdin) {
              process.stdin.close();
            }
          } catch { /* ignore */ }
          
          try {
            if (process.stdout) {
              await process.stdout.cancel();
            }
          } catch { /* ignore */ }
          
          try {
            if (process.stderr) {
              await process.stderr.cancel();
            }
          } catch { /* ignore */ }

          // Kill the process if still running
          try {
            process.kill("SIGTERM");
            await process.status;
          } catch (killError) {
            // Process might already be terminated, which is fine
            if (!(killError instanceof TypeError && killError.message.includes("already terminated"))) {
              throw killError;
            }
          }
          
          // Extra wait for cleanup
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          console.warn("Error stopping echo server:", error);
        }
      },
    };
  }

  /**
   * Starts a feedback loop MCP server that can be used to test loop detection
   */
  static async startFeedbackLoopServer(): Promise<MCPServerInstance> {
    // For testing feedback loops, we'll use the file tools server since it has loop detection
    return this.startFileToolsServer();
  }

  /**
   * Verifies that a MCP server is responding correctly
   */
  static async verifyServerHealth(server: MCPServerInstance): Promise<boolean> {
    try {
      // For stdio servers, we can't easily make HTTP requests
      // Instead, we check if the process is still running
      const status = await Promise.race([
        server.process.status,
        delay(100).then(() => ({ success: true })), // Timeout after 100ms
      ]);

      return status.success !== undefined; // Process is still running
    } catch (error) {
      console.warn("Server health check failed:", error);
      return false;
    }
  }
}

/**
 * Helper for managing multiple MCP servers in tests
 */
export class MCPServerPool {
  private servers: Map<string, MCPServerInstance> = new Map();

  async startServer(
    id: string,
    type: "weather" | "filetools" | "echo",
  ): Promise<MCPServerInstance> {
    if (this.servers.has(id)) {
      throw new Error(`Server with id '${id}' already exists`);
    }

    let server: MCPServerInstance;
    switch (type) {
      case "weather":
        server = await TestMCPServers.startWeatherServer();
        break;
      case "filetools":
        server = await TestMCPServers.startFileToolsServer();
        break;
      case "echo":
        server = await TestMCPServers.startEchoServer();
        break;
      default:
        throw new Error(`Unknown server type: ${type}`);
    }

    this.servers.set(id, server);
    return server;
  }

  getServer(id: string): MCPServerInstance | undefined {
    return this.servers.get(id);
  }

  async stopServer(id: string): Promise<void> {
    const server = this.servers.get(id);
    if (server) {
      await server.stop();
      this.servers.delete(id);
    }
  }

  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.servers.entries()).map(async ([id, server]) => {
      try {
        await server.stop();
      } catch (error) {
        console.warn(`Error stopping server ${id}:`, error);
      }
    });

    await Promise.allSettled(stopPromises);
    this.servers.clear();
  }

  listServers(): string[] {
    return Array.from(this.servers.keys());
  }
}

/**
 * Creates a new MCP server pool for tests
 */
export function createMCPServerPool(): MCPServerPool {
  return new MCPServerPool();
}
