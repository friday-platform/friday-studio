/**
 * Tests for PlatformMCPServer mode-based tool filtering
 */

import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { PlatformMCPServer } from "../src/platform-server.ts";
import { ServerMode } from "../src/types.ts";
import { INTERNAL_TOOLS, PUBLIC_TOOLS } from "../src/tool-categories.ts";
// Mock logger for testing
const mockLogger = {
  info: (message: string, context?: Record<string, unknown>) => {
    console.log(`[INFO] ${message}`, context);
  },
  warn: (message: string, context?: Record<string, unknown>) => {
    console.warn(`[WARN] ${message}`, context);
  },
  error: (message: string, context?: Record<string, unknown>) => {
    console.error(`[ERROR] ${message}`, context);
  },
  debug: (message: string, context?: Record<string, unknown>) => {
    console.debug(`[DEBUG] ${message}`, context);
  },
};

// Mock daemon server for testing
class MockDaemonServer {
  private port: number;
  private server?: Deno.HttpServer;

  constructor() {
    // Use a random port to avoid conflicts
    this.port = Math.floor(Math.random() * 10000) + 8000;
  }

  async start() {
    let attempts = 0;
    while (attempts < 10) {
      try {
        this.server = Deno.serve({ port: this.port }, () => {
          return new Response(JSON.stringify({ status: "ok" }));
        });
        return; // Success
      } catch (error) {
        if (error instanceof Error && error.message.includes("already in use")) {
          this.port++; // Try next port
          attempts++;
        } else {
          throw error;
        }
      }
    }
    throw new Error("Unable to find available port after 10 attempts");
  }

  async stop() {
    if (this.server) {
      await this.server.shutdown();
    }
  }

  get daemonUrl() {
    return `http://localhost:${this.port}`;
  }
}

Deno.test("PlatformMCPServer constructor accepts mode parameter", async () => {
  const mockDaemon = new MockDaemonServer();
  await mockDaemon.start();

  try {
    const server = new PlatformMCPServer({
      daemonUrl: mockDaemon.daemonUrl,
      logger: mockLogger,
      mode: ServerMode.INTERNAL,
    });

    // Test that server was created successfully
    assertEquals(server.getMode(), ServerMode.INTERNAL);
    assertEquals(server.getServerName(), "atlas-internal");
  } finally {
    await mockDaemon.stop();
  }
});

Deno.test("PlatformMCPServer defaults to internal mode", async () => {
  const mockDaemon = new MockDaemonServer();
  await mockDaemon.start();

  try {
    const server = new PlatformMCPServer({
      daemonUrl: mockDaemon.daemonUrl,
      logger: mockLogger,
    });

    // Test that server defaults to internal mode
    assertEquals(server.getMode(), ServerMode.INTERNAL);
    assertEquals(server.getServerName(), "atlas-internal");
  } finally {
    await mockDaemon.stop();
  }
});

Deno.test("PlatformMCPServer in internal mode exposes all tools", async () => {
  const mockDaemon = new MockDaemonServer();
  await mockDaemon.start();

  try {
    const server = new PlatformMCPServer({
      daemonUrl: mockDaemon.daemonUrl,
      logger: mockLogger,
      mode: ServerMode.INTERNAL,
    });

    const availableTools = server.getAvailableTools();

    // Should include both internal and public tools
    for (const toolName of INTERNAL_TOOLS) {
      assertEquals(availableTools.includes(toolName), true, `Missing internal tool: ${toolName}`);
    }

    for (const toolName of PUBLIC_TOOLS) {
      assertEquals(availableTools.includes(toolName), true, `Missing public tool: ${toolName}`);
    }
  } finally {
    await mockDaemon.stop();
  }
});

Deno.test("PlatformMCPServer in public mode exposes only public tools", async () => {
  const mockDaemon = new MockDaemonServer();
  await mockDaemon.start();

  try {
    const server = new PlatformMCPServer({
      daemonUrl: mockDaemon.daemonUrl,
      logger: mockLogger,
      mode: ServerMode.PUBLIC,
    });

    const availableTools = server.getAvailableTools();

    // Should include only public tools
    for (const toolName of PUBLIC_TOOLS) {
      assertEquals(availableTools.includes(toolName), true, `Missing public tool: ${toolName}`);
    }

    // Should NOT include any internal tools
    for (const toolName of INTERNAL_TOOLS) {
      assertEquals(
        availableTools.includes(toolName),
        false,
        `Should not include internal tool: ${toolName}`,
      );
    }

    // Should be exactly the public tools
    assertEquals(availableTools.length, PUBLIC_TOOLS.length);
  } finally {
    await mockDaemon.stop();
  }
});

Deno.test("PlatformMCPServer public mode server name is correct", async () => {
  const mockDaemon = new MockDaemonServer();
  await mockDaemon.start();

  try {
    const server = new PlatformMCPServer({
      daemonUrl: mockDaemon.daemonUrl,
      logger: mockLogger,
      mode: ServerMode.PUBLIC,
    });

    assertEquals(server.getMode(), ServerMode.PUBLIC);
    assertEquals(server.getServerName(), "atlas-public");
  } finally {
    await mockDaemon.stop();
  }
});

Deno.test("PlatformMCPServer rejects invalid mode", async () => {
  const mockDaemon = new MockDaemonServer();
  await mockDaemon.start();

  try {
    assertRejects(
      async () => {
        new PlatformMCPServer({
          daemonUrl: mockDaemon.daemonUrl,
          logger: mockLogger,
          mode: "invalid" as ServerMode,
        });
      },
      Error,
      "Invalid server mode",
    );
  } finally {
    await mockDaemon.stop();
  }
});
