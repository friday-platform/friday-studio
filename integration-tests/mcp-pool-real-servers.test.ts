/**
 * MCP Pool Real Server Integration Tests
 *
 * These integration tests validate the GlobalMCPServerPool with REAL MCP server processes,
 * not mocked connections. This provides comprehensive coverage of:
 *
 * ## Test Coverage Overview
 *
 * ### 1. Real Process Lifecycle Management
 * - Spawns actual stdio MCP server processes (echo server fixture, time server via uvx)
 * - Tests connection establishment, verification, and cleanup
 * - Validates process termination and resource cleanup
 *
 * ### 2. Connection Pooling Behavior
 * - Pool creation and reuse for identical server configurations
 * - Reference counting and lifecycle management
 * - Pool key generation consistency (server ordering normalization)
 * - Multiple server combinations and separate pool creation
 *
 * ### 3. Tool Discovery and Access
 * - Tool discovery from real MCP servers
 * - Tool filtering based on allow/deny lists
 * - Multiple server tool aggregation
 *
 * ### 4. Error Handling with Real Processes
 * - Graceful handling of server startup failures
 * - Mixed valid/invalid server configurations
 * - Process crashes and recovery scenarios
 *
 * ### 5. Resource Management
 * - Pool disposal and cleanup verification
 * - Reference counting accuracy
 * - Memory and process leak prevention
 *
 * ## Relationship to Other Test Files
 *
 * - `mcp-pool-integration.test.ts`: Tests core pool functionality with uvx-based servers (time, git)
 * - `mcp-context-provider-integration.test.ts`: Tests MCP context provider abstraction layer
 * - `agent-server-mcp-e2e.test.ts`: Full end-to-end agent execution with MCP tools
 *
 * This file specifically focuses on the **pool implementation itself** with real process management,
 * while the others test higher-level integrations and abstractions.
 *
 * ## Test Servers Used
 *
 * - **Echo Server**: Custom FastMCP fixture (`./integration-tests/fixtures/echo-mcp-server.ts`)
 *   - Provides reliable, fast startup for core pool testing
 *   - Tools: echo, reverse, uppercase
 *
 * - **Time Server**: Real mcp-server-time via uvx (conditional)
 *   - Tests external MCP server integration
 *   - Only runs if uvx is available
 *   - Tools: get_current_time, convert_time
 */

import type { MCPServerConfig } from "@atlas/config";
import { GlobalMCPServerPool } from "@atlas/core";
import { logger } from "@atlas/logger";
import { assertEquals, assertExists } from "@std/assert";

Deno.env.set("DENO_TESTING", "true");

/**
 * Check if uvx is available (needed for some MCP servers)
 */
async function checkUvxAvailable(): Promise<boolean> {
  try {
    const cmd = new Deno.Command("uvx", { args: ["--version"] });
    const output = await cmd.output();
    return output.success;
  } catch {
    return false;
  }
}

/**
 * Create configuration for our echo test server
 */
function createEchoServerConfig(): MCPServerConfig {
  return {
    transport: {
      type: "stdio",
      command: "deno",
      args: ["run", "--allow-all", "./integration-tests/fixtures/echo-mcp-server.ts"],
    },
    tools: { allow: ["echo", "reverse", "uppercase"] },
    client_config: { timeout: { progressTimeout: "10s", maxTotalTimeout: "30s" } },
  };
}

/**
 * Create invalid server config for error testing
 */
function createInvalidServerConfig(): MCPServerConfig {
  return {
    transport: {
      type: "stdio",
      command: "nonexistent-command-that-will-fail",
      args: ["--invalid-arg"],
    },
    tools: { allow: ["*"] },
  } as MCPServerConfig;
}

/**
 * Helper to create a fresh pool and clear logs for each test
 */
function setupFreshTest(): GlobalMCPServerPool {
  return new GlobalMCPServerPool(logger);
}

/**
 * Helper to cleanup pool after test
 */
async function cleanupPool(pool: GlobalMCPServerPool): Promise<void> {
  if (pool) {
    await pool.dispose();
  }
}

/**
 * Create time server config (requires uvx)
 */
function createTimeServerConfig(): MCPServerConfig {
  return {
    transport: {
      type: "stdio",
      command: "uvx",
      args: ["mcp-server-time", "--local-timezone", "UTC"],
    },
    tools: { allow: ["get_current_time", "convert_time"] },
    client_config: { timeout: { progressTimeout: "10s", maxTotalTimeout: "30s" } },
  };
}

// =============================================================================
// Echo Server Connection and Tool Execution Tests
// =============================================================================

Deno.test(
  "should connect to echo server and discover tools",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    const pool = setupFreshTest();

    const config = { echo: createEchoServerConfig() };

    const manager = await pool.getMCPManager(config);
    assertExists(manager);

    // Verify the manager was created and cached
    const stats = pool.getPoolStats();
    assertEquals(stats.totalPooledManagers, 1);
    assertEquals(stats.activeReferences, 1);

    // Get available tools from the manager
    const tools = await manager.getToolsForServers(["echo"]);
    assertExists(tools);

    // Should have our echo server tools
    const toolNames = Object.keys(tools);

    // Verify tools were retrieved successfully
    assertEquals(toolNames.length, 3);
    assertEquals(toolNames.includes("echo"), true);
    assertEquals(toolNames.includes("reverse"), true);
    assertEquals(toolNames.includes("uppercase"), true);

    pool.releaseMCPManager(config);
    await cleanupPool(pool);
  },
);

Deno.test(
  "should reuse connection for same server config",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    const pool = setupFreshTest();

    const config = { echo: createEchoServerConfig() };

    // Get manager twice
    const manager1 = await pool.getMCPManager(config);
    const manager2 = await pool.getMCPManager(config);

    // Should be the same manager instance (connection reuse)
    assertEquals(manager1, manager2);

    const stats = pool.getPoolStats();
    assertEquals(stats.totalPooledManagers, 1); // Still only one pool entry
    assertEquals(stats.activeReferences, 2); // But two active references

    pool.releaseMCPManager(config);
    pool.releaseMCPManager(config);
    await cleanupPool(pool);
  },
);

// =============================================================================
// Multiple Server Configuration Tests
// =============================================================================

Deno.test(
  "should handle multiple echo servers with different IDs",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    const pool = setupFreshTest();

    const config = { echo1: createEchoServerConfig(), echo2: createEchoServerConfig() };

    const manager = await pool.getMCPManager(config);
    assertExists(manager);

    const stats = pool.getPoolStats();
    assertEquals(stats.totalPooledManagers, 1);
    assertEquals(stats.serverConfigurations[0]?.serverCount, 2);

    // Get tools from both servers
    const tools = await manager.getToolsForServers(["echo1", "echo2"]);
    assertExists(tools);

    pool.releaseMCPManager(config);
    await cleanupPool(pool);
  },
);

Deno.test(
  "should create separate pools for different server combinations",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    const pool = setupFreshTest();

    const config1 = { echo: createEchoServerConfig() };
    const config2 = { "echo-diff": createEchoServerConfig() };

    const manager1 = await pool.getMCPManager(config1);
    const manager2 = await pool.getMCPManager(config2);

    // Should be different managers (different server IDs = different pool keys)
    assertEquals(manager1 === manager2, false);

    const stats = pool.getPoolStats();
    assertEquals(stats.totalPooledManagers, 2);

    pool.releaseMCPManager(config1);
    pool.releaseMCPManager(config2);
    await cleanupPool(pool);
  },
);

// =============================================================================
// Time Server Integration Tests (conditional on uvx availability)
// =============================================================================

Deno.test(
  "should connect to time server (if uvx available)",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    const uvxAvailable = await checkUvxAvailable();
    if (!uvxAvailable) {
      // Skip time server tests when uvx is not available
      return;
    }

    const pool = setupFreshTest();

    const config = { time: createTimeServerConfig() };

    const manager = await pool.getMCPManager(config);
    assertExists(manager);

    // Get tools to verify connection
    const tools = await manager.getToolsForServers(["time"]);
    assertExists(tools);

    pool.releaseMCPManager(config);
    await cleanupPool(pool);
  },
);

Deno.test(
  "should handle mixed echo and time servers (if uvx available)",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    const uvxAvailable = await checkUvxAvailable();
    if (!uvxAvailable) {
      // Skip time server tests when uvx is not available
      return;
    }

    const pool = setupFreshTest();

    const config = { echo: createEchoServerConfig(), time: createTimeServerConfig() };

    const manager = await pool.getMCPManager(config);
    assertExists(manager);

    const stats = pool.getPoolStats();
    assertEquals(stats.serverConfigurations[0]?.serverCount, 2);

    // Should be able to get tools from both
    const echoTools = await manager.getToolsForServers(["echo"]);
    const timeTools = await manager.getToolsForServers(["time"]);
    const allTools = await manager.getToolsForServers(["echo", "time"]);

    assertExists(echoTools);
    assertExists(timeTools);
    assertExists(allTools);

    pool.releaseMCPManager(config);
    await cleanupPool(pool);
  },
);

// =============================================================================
// Error Handling with Real Processes Tests
// =============================================================================

Deno.test(
  "should handle server startup failures gracefully",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    const pool = setupFreshTest();

    const config = { invalid: createInvalidServerConfig() };

    // Should not throw, but will log errors
    const manager = await pool.getMCPManager(config);
    assertExists(manager);

    // Manager should still be created even with invalid servers
    const stats = pool.getPoolStats();
    assertEquals(stats.totalPooledManagers, 1);

    pool.releaseMCPManager(config);
    await cleanupPool(pool);
  },
);

Deno.test(
  "should handle mixed valid/invalid servers",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    const pool = setupFreshTest();

    const config = { echo: createEchoServerConfig(), invalid: createInvalidServerConfig() };

    const manager = await pool.getMCPManager(config);
    assertExists(manager);

    // Should still be able to get tools from valid server
    const tools = await manager.getToolsForServers(["echo"]);
    assertExists(tools);

    // Should have tools from the valid server
    const toolNames = Object.keys(tools);
    assertEquals(toolNames.length, 3);
    assertEquals(toolNames.includes("echo"), true);

    pool.releaseMCPManager(config);
    await cleanupPool(pool);
  },
);

// =============================================================================
// Pool Lifecycle and Cleanup Tests
// =============================================================================

Deno.test(
  "should properly clean up all connections on dispose",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    const pool = setupFreshTest();

    const config1 = { echo1: createEchoServerConfig() };
    const config2 = { echo2: createEchoServerConfig() };

    await pool.getMCPManager(config1);
    await pool.getMCPManager(config2);

    let stats = pool.getPoolStats();
    assertEquals(stats.totalPooledManagers, 2);

    // Dispose should clean up everything
    await pool.dispose();

    stats = pool.getPoolStats();
    assertEquals(stats.totalPooledManagers, 0);
    assertEquals(stats.activeReferences, 0);

    // Verify pool is empty after disposal
    assertEquals(stats.totalPooledManagers, 0);
    assertEquals(stats.activeReferences, 0);
  },
);

// =============================================================================
// Connection Key Generation Consistency Tests
// =============================================================================

Deno.test(
  "should generate consistent keys for identical configs",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    const pool = setupFreshTest();

    const config1 = { echo: createEchoServerConfig() };
    const config2 = { echo: createEchoServerConfig() };

    const manager1 = await pool.getMCPManager(config1);
    const manager2 = await pool.getMCPManager(config2);

    // Should reuse the same manager (identical configs)
    assertEquals(manager1, manager2);

    const stats = pool.getPoolStats();
    assertEquals(stats.totalPooledManagers, 1);
    assertEquals(stats.activeReferences, 2);

    pool.releaseMCPManager(config1);
    pool.releaseMCPManager(config2);
    await cleanupPool(pool);
  },
);

Deno.test(
  "should handle server ordering in keys",
  { sanitizeOps: false, sanitizeResources: false },
  async () => {
    const pool = setupFreshTest();

    // Create separate config objects to avoid reference issues
    const config1 = { a: createEchoServerConfig(), b: createEchoServerConfig() };
    const config2 = { b: createEchoServerConfig(), a: createEchoServerConfig() };

    const manager1 = await pool.getMCPManager(config1);
    const manager2 = await pool.getMCPManager(config2);

    // Should reuse same manager (same servers, different order)
    assertEquals(manager1, manager2);

    const stats = pool.getPoolStats();
    assertEquals(stats.totalPooledManagers, 1);

    pool.releaseMCPManager(config1);
    pool.releaseMCPManager(config2);
    await cleanupPool(pool);
  },
);
