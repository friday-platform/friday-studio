import { assertEquals, assertExists } from "@std/assert";
import { WorkspaceServer } from "../../src/core/workspace-server.ts";
import { WorkspaceRuntime } from "../../src/core/workspace-runtime.ts";
import { AtlasLogger } from "../../src/utils/logger.ts";
import { join } from "@std/path";

// Mock runtime for testing
class MockWorkspaceRuntime {
  workspace = { id: "test-workspace" };

  getStatus() {
    return { activeSessions: 2 };
  }

  getSessions() {
    return [];
  }

  getWorkers() {
    return [];
  }

  async shutdown() {
    // Mock shutdown
  }
}

Deno.test("WorkspaceServer - detached mode initialization", async () => {
  const tempDir = await Deno.makeTempDir();
  const logFile = join(tempDir, "test-workspace.log");

  // Temporarily disable test mode to allow file logging
  const originalTestMode = Deno.env.get("DENO_TESTING");
  Deno.env.delete("DENO_TESTING");

  // Reset logger AFTER changing env var to ensure clean state
  AtlasLogger.resetInstance();

  try {
    // Set environment variables for detached mode
    Deno.env.set("ATLAS_DETACHED", "true");
    Deno.env.set("ATLAS_WORKSPACE_ID", "test-workspace-123");
    Deno.env.set("ATLAS_WORKSPACE_NAME", "Test Workspace");
    Deno.env.set("ATLAS_LOG_FILE", logFile);

    const runtime = new MockWorkspaceRuntime() as any;
    const server = new WorkspaceServer(runtime, {
      port: 0, // Use port 0 to get a random available port
      hostname: "127.0.0.1",
    });

    // Start server non-blocking
    const { finished } = await server.startNonBlocking();

    // Wait for logs to be written
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify log file was created
    let logContent: string;
    try {
      logContent = await Deno.readTextFile(logFile);
    } catch (e) {
      // If file doesn't exist, log error and fail test
      console.error("Log file not found:", logFile);
      throw new Error(`Log file not created: ${logFile}`);
    }
    const lines = logContent.trim().split("\n");

    // Should have startup message
    const firstEntry = JSON.parse(lines[0]);
    assertEquals(firstEntry.level, "info");
    assertEquals(firstEntry.message, "Workspace starting in detached mode");

    // Should have server start messages
    const hasServerStarting = lines.some((line) => {
      const entry = JSON.parse(line);
      return entry.message.includes("Starting server");
    });
    assertEquals(hasServerStarting, true);

    // Shutdown the server
    await server.shutdown();
  } finally {
    // Clean up environment variables
    Deno.env.delete("ATLAS_DETACHED");
    Deno.env.delete("ATLAS_WORKSPACE_ID");
    Deno.env.delete("ATLAS_WORKSPACE_NAME");
    Deno.env.delete("ATLAS_LOG_FILE");

    // Restore test mode
    if (originalTestMode) {
      Deno.env.set("DENO_TESTING", originalTestMode);
    }

    // Clean up logger
    AtlasLogger.getInstance().close();

    // Clean up temp dir
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("WorkspaceServer - health endpoint in detached mode", async () => {
  const tempDir = await Deno.makeTempDir();
  const logFile = join(tempDir, "test-workspace-health.log");

  // Temporarily disable test mode to allow file logging
  const originalTestMode = Deno.env.get("DENO_TESTING");
  Deno.env.delete("DENO_TESTING");

  // Reset logger AFTER changing env var to ensure clean state
  AtlasLogger.resetInstance();

  try {
    // Set environment variables for detached mode
    Deno.env.set("ATLAS_DETACHED", "true");
    Deno.env.set("ATLAS_WORKSPACE_ID", "test-workspace-health");
    Deno.env.set("ATLAS_WORKSPACE_NAME", "Test Health");
    Deno.env.set("ATLAS_LOG_FILE", logFile);

    const runtime = new MockWorkspaceRuntime() as any;
    const server = new WorkspaceServer(runtime, {
      port: 0,
      hostname: "127.0.0.1",
    });

    // Start server and get the actual port
    const { finished } = await server.startNonBlocking();

    // Wait a bit for server to start
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Get the actual port from the server
    // The server's Deno.serve instance is stored as this.server
    const actualPort = (server as any).server?.addr?.port || 8080;

    // Test health endpoint
    const response = await fetch(`http://127.0.0.1:${actualPort}/api/health`);
    assertEquals(response.status, 200);

    const health = await response.json();
    assertEquals(health.status, "healthy");
    assertEquals(health.workspaceId, "test-workspace-health");
    assertEquals(health.workspaceName, "Test Health");
    assertEquals(health.detached, true);
    assertExists(health.uptime);
    assertExists(health.memory);
    assertExists(health.timestamp);
    assertExists(health.version);

    // Shutdown
    await server.shutdown();
  } finally {
    // Clean up
    Deno.env.delete("ATLAS_DETACHED");
    Deno.env.delete("ATLAS_WORKSPACE_ID");
    Deno.env.delete("ATLAS_WORKSPACE_NAME");
    Deno.env.delete("ATLAS_LOG_FILE");

    // Restore test mode
    if (originalTestMode) {
      Deno.env.set("DENO_TESTING", originalTestMode);
    }

    AtlasLogger.getInstance().close();
    await Deno.remove(tempDir, { recursive: true });
  }
});
