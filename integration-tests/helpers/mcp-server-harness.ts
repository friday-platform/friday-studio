/**
 * MCP Server Test Harness
 *
 * Utilities for spawning, managing, and cleaning up test MCP servers
 * during integration testing.
 */

import { findAvailablePort } from "../../src/utils/port-finder.ts";
import type { MCPServerConfig } from "@atlas/config";

export interface TestMCPServerInstance {
  id: string;
  config: MCPServerConfig;
  process?: Deno.ChildProcess;
  port?: number;
  url?: string;
  startTime: number;
  isRunning: boolean;
}

/**
 * Manages lifecycle of test MCP servers
 */
export class MCPServerTestHarness {
  private servers = new Map<string, TestMCPServerInstance>();
  private cleanupFns: Array<() => Promise<void>> = [];

  /**
   * Spawn a stdio-based MCP server
   */
  async spawnStdioServer(
    id: string,
    command: string,
    args: string[],
  ): Promise<TestMCPServerInstance> {
    const config: MCPServerConfig = {
      transport: {
        type: "stdio",
        command,
        args,
      },
    };

    const processCommand = new Deno.Command(command, {
      args,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });

    const process = processCommand.spawn();

    const instance: TestMCPServerInstance = {
      id,
      config,
      process,
      startTime: Date.now(),
      isRunning: true,
    };

    this.servers.set(id, instance);

    // Add cleanup function
    this.cleanupFns.push(async () => {
      if (instance.process) {
        try {
          instance.process.kill();
          await instance.process.status;
        } catch {
          // Process may have already exited
        }
      }
    });

    return instance;
  }

  /**
   * Spawn an HTTP/SSE-based MCP server
   */
  async spawnHttpServer(
    id: string,
    serverModule: string,
  ): Promise<TestMCPServerInstance> {
    const port = findAvailablePort();
    const url = `http://localhost:${port}/mcp`;

    const config: MCPServerConfig = {
      transport: {
        type: "sse",
        url,
      },
    };

    // For HTTP servers, we'd need to spawn them differently
    // This is a simplified version - in practice you'd spawn a Deno process
    const processCommand = new Deno.Command("deno", {
      args: ["run", "--allow-all", serverModule, "--port", port.toString()],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });

    const process = processCommand.spawn();

    const instance: TestMCPServerInstance = {
      id,
      config,
      process,
      port,
      url,
      startTime: Date.now(),
      isRunning: true,
    };

    this.servers.set(id, instance);

    // Wait for server to be ready
    await this.waitForServerReady(url, 5000);

    // Add cleanup function
    this.cleanupFns.push(async () => {
      if (instance.process) {
        try {
          instance.process.kill();
          await instance.process.status;
        } catch {
          // Process may have already exited
        }
      }
    });

    return instance;
  }

  /**
   * Wait for HTTP server to be ready
   */
  private async waitForServerReady(url: string, timeout: number): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        const response = await fetch(`${url}/health`);
        if (response.ok) {
          return;
        }
      } catch {
        // Server not ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new Error(`Server at ${url} did not become ready within ${timeout}ms`);
  }

  /**
   * Get server instance by ID
   */
  getServer(id: string): TestMCPServerInstance | undefined {
    return this.servers.get(id);
  }

  /**
   * Check if server is running
   */
  async isServerRunning(id: string): Promise<boolean> {
    const instance = this.servers.get(id);
    if (!instance || !instance.process) {
      return false;
    }

    try {
      // Check if process is still running
      const status = await instance.process.status;
      return !status.success;
    } catch {
      // Process is still running if we can't get status
      return true;
    }
  }

  /**
   * Stop a specific server
   */
  async stopServer(id: string): Promise<void> {
    const instance = this.servers.get(id);
    if (!instance || !instance.process) {
      return;
    }

    try {
      instance.process.kill();
      await instance.process.status;
    } catch {
      // Process may have already exited
    }

    instance.isRunning = false;
  }

  /**
   * Get statistics about running servers
   */
  getStats(): {
    total: number;
    running: number;
    stopped: number;
  } {
    let running = 0;
    let stopped = 0;

    for (const instance of this.servers.values()) {
      if (instance.isRunning) {
        running++;
      } else {
        stopped++;
      }
    }

    return {
      total: this.servers.size,
      running,
      stopped,
    };
  }

  /**
   * Cleanup all servers and resources
   */
  async cleanup(): Promise<void> {
    // Execute all cleanup functions
    for (const cleanupFn of this.cleanupFns) {
      try {
        await cleanupFn();
      } catch (error) {
        console.error("Error during cleanup:", error);
      }
    }

    // Clear internal state
    this.servers.clear();
    this.cleanupFns = [];
  }
}
