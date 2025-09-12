/**
 * MCP Pool Core Integration Tests
 *
 * These integration tests validate the GlobalMCPServerPool's core functionality with time and git
 * servers via uvx. This provides comprehensive coverage of:
 *
 * ## Test Coverage Overview
 *
 * ### 1. Connection Pooling and Reuse
 * - Pool creation for single server configurations
 * - Connection reuse for identical server configurations
 * - Reference counting accuracy and lifecycle management
 * - Pool key generation consistency (server ordering normalization)
 * - Separate pool creation for different server combinations
 *
 * ### 2. Multiple Server Configuration Handling
 * - Multiple servers within single configuration (combo configs)
 * - Different server combinations creating separate pools
 * - Server ID ordering consistency in pool key generation
 * - Mixed server types (time + git) in single configuration
 *
 * ### 3. Pool Lifecycle Management
 * - Reference counting accuracy across get/release cycles
 * - Empty server configuration handling (bypass pooling)
 * - Pool cleanup and disposal with active references
 * - Graceful pool termination and resource cleanup
 *
 * ### 4. Error Handling and Recovery
 * - Invalid server configuration graceful handling
 * - Mixed valid/invalid server configurations
 * - Pool state consistency during server registration failures
 * - Error isolation (one bad server doesn't break the pool)
 *
 * ### 5. Configuration Key Generation
 * - Consistent keys for identical configurations
 * - Different keys for different server IDs (even same config)
 * - Server ordering normalization (a,b same as b,a)
 * - Configuration serialization and comparison accuracy
 *
 * ## Relationship to Other Test Files
 *
 * - `mcp-pool-real-servers.test.ts`: Tests pool with real MCP server processes (echo, time)
 * - `mcp-context-provider-integration.test.ts`: Tests MCP context provider abstraction layer
 * - `agent-server-mcp-e2e.test.ts`: Full end-to-end agent execution with MCP tools
 *
 * This file specifically focuses on the **core pooling logic and connection management** using
 * standard uvx-based MCP servers (time, git) that are commonly available in development environments.
 *
 * ## Test Servers Used
 *
 * - **Time Server**: mcp-server-time via uvx
 *   - Tools: get_current_time, convert_time
 *   - Tests basic connection pooling and lifecycle
 *
 * - **Git Server**: mcp-server-git via uvx
 *   - Tools: git_status, git_log, git_diff
 *   - Tests multi-server configurations and key generation
 *
 * ## Key Integration Points
 *
 * 1. **Pool Manager**: Connection pooling and reference counting
 * 2. **Configuration Keys**: Server configuration serialization and comparison
 * 3. **Lifecycle Management**: Resource cleanup and disposal
 * 4. **Error Recovery**: Graceful handling of server registration failures
 */

import type { MCPServerConfig } from "@atlas/config";
import { GlobalMCPServerPool } from "@atlas/core";
import { logger } from "@atlas/logger";
import { assertEquals, assertExists } from "@std/assert";

Deno.env.set("DENO_TESTING", "true");

// Check if uvx is available for running MCP servers
const checkUvxAvailable = async (): Promise<boolean> => {
  try {
    const command = new Deno.Command("which", { args: ["uvx"], stdout: "piped", stderr: "piped" });
    const { success } = await command.output();
    return success;
  } catch {
    return false;
  }
};

// Skip tests in CI or when uvx is not available
const skipTests =
  Deno.env.get("CI") === "true" ||
  Deno.env.get("GITHUB_ACTIONS") === "true" ||
  !(await checkUvxAvailable());

if (skipTests) {
  console.log("Skipping MCP pool integration tests - uvx not available or running in CI");
}

/**
 * Test fixture for creating real MCP server configurations
 */
function createTimeServerConfig(): MCPServerConfig {
  return {
    transport: {
      type: "stdio",
      command: "uvx",
      args: ["mcp-server-time", "--local-timezone", "UTC"],
    },
    tools: { allow: ["get_current_time", "convert_time"] },
    client_config: { timeout: { progressTimeout: "30s", maxTotalTimeout: "60s" } },
  };
}

function createGitServerConfig(): MCPServerConfig {
  return {
    transport: { type: "stdio", command: "uvx", args: ["mcp-server-git", "--repository", "."] },
    tools: { allow: ["git_status", "git_log", "git_diff"] },
    client_config: { timeout: { progressTimeout: "30s", maxTotalTimeout: "60s" } },
  };
}

/**
 * Helper to create fresh pool and clear logs for each test
 */
function setupFreshTest(): GlobalMCPServerPool {
  return new GlobalMCPServerPool(logger);
}

/**
 * Helper to cleanup pool after test
 */
async function cleanupTest(pool: GlobalMCPServerPool): Promise<void> {
  if (pool) {
    await pool.dispose();
  }
}

// =============================================================================
// Single Server Connection and Pooling Tests
// =============================================================================

Deno.test(
  "should create MCP manager for single server",
  { sanitizeOps: false, sanitizeResources: false, ignore: skipTests },
  async () => {
    const pool = setupFreshTest();

    const serverConfigs = { time: createTimeServerConfig() };

    const manager = await pool.getMCPManager(serverConfigs);
    assertExists(manager);

    // Verify pool stats
    const stats = pool.getPoolStats();
    assertEquals(stats.totalPooledManagers, 1);
    assertEquals(stats.activeReferences, 1);
    assertEquals(stats.serverConfigurations.length, 1);
    assertEquals(stats.serverConfigurations[0]?.serverCount, 1);

    // Release the manager
    pool.releaseMCPManager(serverConfigs);

    // Stats should show no active references
    const statsAfterRelease = pool.getPoolStats();
    assertEquals(statsAfterRelease.activeReferences, 0);

    await cleanupTest(pool);
  },
);

Deno.test(
  "should reuse existing manager for same config",
  { sanitizeOps: false, sanitizeResources: false, ignore: skipTests },
  async () => {
    const pool = setupFreshTest();

    const serverConfigs = { time: createTimeServerConfig() };

    // Get manager first time
    const manager1 = await pool.getMCPManager(serverConfigs);

    // Get manager second time with same config
    const manager2 = await pool.getMCPManager(serverConfigs);
    const stats2 = pool.getPoolStats();

    // Should be same manager instance and increased ref count
    assertEquals(manager1, manager2);
    assertEquals(stats2.totalPooledManagers, 1); // Still only one pool entry
    assertEquals(stats2.activeReferences, 2); // But two references

    // Release both
    pool.releaseMCPManager(serverConfigs);
    pool.releaseMCPManager(serverConfigs);

    await cleanupTest(pool);
  },
);

Deno.test(
  "should create separate managers for different configs",
  { sanitizeOps: false, sanitizeResources: false, ignore: skipTests },
  async () => {
    const pool = setupFreshTest();

    const timeConfig = { time: createTimeServerConfig() };
    const gitConfig = { git: createGitServerConfig() };

    const timeManager = await pool.getMCPManager(timeConfig);
    const gitManager = await pool.getMCPManager(gitConfig);

    // Should be different managers
    assertEquals(timeManager === gitManager, false);

    const stats = pool.getPoolStats();
    assertEquals(stats.totalPooledManagers, 2);
    assertEquals(stats.activeReferences, 2);

    pool.releaseMCPManager(timeConfig);
    pool.releaseMCPManager(gitConfig);

    await cleanupTest(pool);
  },
);

// =============================================================================
// Multiple Server Configuration Tests
// =============================================================================

Deno.test(
  "should handle multiple servers in single config",
  { sanitizeOps: false, sanitizeResources: false, ignore: skipTests },
  async () => {
    const pool = setupFreshTest();

    const multiServerConfig = { time: createTimeServerConfig(), git: createGitServerConfig() };

    const manager = await pool.getMCPManager(multiServerConfig);
    assertExists(manager);

    const stats = pool.getPoolStats();
    assertEquals(stats.totalPooledManagers, 1);
    assertEquals(stats.serverConfigurations[0]?.serverCount, 2);

    pool.releaseMCPManager(multiServerConfig);
    await cleanupTest(pool);
  },
);

Deno.test(
  "should generate different keys for different server combinations",
  { sanitizeOps: false, sanitizeResources: false, ignore: skipTests },
  async () => {
    const pool = setupFreshTest();

    const config1 = { time: createTimeServerConfig() };
    const config2 = { git: createGitServerConfig() };
    const config3 = { time: createTimeServerConfig(), git: createGitServerConfig() };

    const manager1 = await pool.getMCPManager(config1);
    const manager2 = await pool.getMCPManager(config2);
    const manager3 = await pool.getMCPManager(config3);

    // All should be different managers
    assertEquals(manager1 === manager2, false);
    assertEquals(manager1 === manager3, false);
    assertEquals(manager2 === manager3, false);

    const stats = pool.getPoolStats();
    assertEquals(stats.totalPooledManagers, 3);

    pool.releaseMCPManager(config1);
    pool.releaseMCPManager(config2);
    pool.releaseMCPManager(config3);

    await cleanupTest(pool);
  },
);

// =============================================================================
// Connection Pooling Lifecycle Tests
// =============================================================================

Deno.test(
  "should track reference counts correctly",
  { sanitizeOps: false, sanitizeResources: false, ignore: skipTests },
  async () => {
    const pool = setupFreshTest();

    const config = { time: createTimeServerConfig() };

    // Get multiple references to same config
    await pool.getMCPManager(config);
    await pool.getMCPManager(config);
    await pool.getMCPManager(config);

    const stats = pool.getPoolStats();
    assertEquals(stats.activeReferences, 3);
    assertEquals(stats.totalPooledManagers, 1);

    // Release one by one
    pool.releaseMCPManager(config);
    assertEquals(pool.getPoolStats().activeReferences, 2);

    pool.releaseMCPManager(config);
    assertEquals(pool.getPoolStats().activeReferences, 1);

    pool.releaseMCPManager(config);
    assertEquals(pool.getPoolStats().activeReferences, 0);

    await cleanupTest(pool);
  },
);

Deno.test(
  "should handle empty server configs",
  { sanitizeOps: false, sanitizeResources: false, ignore: skipTests },
  async () => {
    const pool = setupFreshTest();

    const emptyConfig = {};
    const manager = await pool.getMCPManager(emptyConfig);
    assertExists(manager);

    // Empty configs don't get pooled - they return fresh managers
    const stats = pool.getPoolStats();
    assertEquals(stats.totalPooledManagers, 0);

    // Release should not throw (even though nothing was pooled)
    pool.releaseMCPManager(emptyConfig);

    await cleanupTest(pool);
  },
);

// =============================================================================
// Error Handling and Recovery Tests
// =============================================================================

Deno.test(
  "should handle server registration failures gracefully",
  { sanitizeOps: false, sanitizeResources: false, ignore: skipTests },
  async () => {
    const pool = setupFreshTest();

    const invalidConfig = {
      invalid: {
        transport: {
          type: "stdio",
          command: "nonexistent-command-that-will-fail",
          args: ["--invalid"],
        },
        tools: { allow: ["*"] },
      },
    };

    // Should not throw, but may log errors
    const manager = await pool.getMCPManager(invalidConfig);
    assertExists(manager);

    pool.releaseMCPManager(invalidConfig);
    await cleanupTest(pool);
  },
);

Deno.test(
  "should handle mixed valid/invalid servers",
  { sanitizeOps: false, sanitizeResources: false, ignore: skipTests },
  async () => {
    const pool = setupFreshTest();

    const mixedConfig = {
      time: createTimeServerConfig(),
      invalid: {
        transport: { type: "stdio", command: "nonexistent-command", args: [] },
        tools: { allow: ["*"] },
      },
    };

    const manager = await pool.getMCPManager(mixedConfig);
    assertExists(manager);

    pool.releaseMCPManager(mixedConfig);
    await cleanupTest(pool);
  },
);

// =============================================================================
// Pool Cleanup and Disposal Tests
// =============================================================================

Deno.test(
  "should clean up pool on disposal",
  { sanitizeOps: false, sanitizeResources: false, ignore: skipTests },
  async () => {
    const pool = setupFreshTest();

    const config1 = { time: createTimeServerConfig() };
    const config2 = { git: createGitServerConfig() };

    await pool.getMCPManager(config1);
    await pool.getMCPManager(config2);

    const stats = pool.getPoolStats();
    assertEquals(stats.totalPooledManagers, 2);

    // Dispose should clean up everything
    await pool.dispose();

    const statsAfterDispose = pool.getPoolStats();
    assertEquals(statsAfterDispose.totalPooledManagers, 0);
    assertEquals(statsAfterDispose.activeReferences, 0);

    // Note: pool is already disposed, no need to cleanup
  },
);

// =============================================================================
// Configuration Key Generation Tests
// =============================================================================

Deno.test(
  "should generate consistent keys for same configs",
  { sanitizeOps: false, sanitizeResources: false, ignore: skipTests },
  async () => {
    const pool = setupFreshTest();

    const config1 = { time: createTimeServerConfig() };
    const config2 = { time: createTimeServerConfig() };

    const manager1 = await pool.getMCPManager(config1);
    const manager2 = await pool.getMCPManager(config2);

    // Should reuse same manager (same config = same key)
    assertEquals(manager1, manager2);

    const stats = pool.getPoolStats();
    assertEquals(stats.totalPooledManagers, 1);
    assertEquals(stats.activeReferences, 2);

    pool.releaseMCPManager(config1);
    pool.releaseMCPManager(config2);

    await cleanupTest(pool);
  },
);

Deno.test(
  "should generate different keys for different server IDs",
  { sanitizeOps: false, sanitizeResources: false, ignore: skipTests },
  async () => {
    const pool = setupFreshTest();

    const config1 = { server1: createTimeServerConfig() };
    const config2 = { server2: createTimeServerConfig() };

    const manager1 = await pool.getMCPManager(config1);
    const manager2 = await pool.getMCPManager(config2);

    // Should be different managers (different server IDs)
    assertEquals(manager1 === manager2, false);

    const stats = pool.getPoolStats();
    assertEquals(stats.totalPooledManagers, 2);

    pool.releaseMCPManager(config1);
    pool.releaseMCPManager(config2);

    await cleanupTest(pool);
  },
);

Deno.test(
  "should handle server ID ordering consistently",
  { sanitizeOps: false, sanitizeResources: false, ignore: skipTests },
  async () => {
    const pool = setupFreshTest();

    const config1 = { a: createTimeServerConfig(), b: createGitServerConfig() };
    const config2 = { b: createGitServerConfig(), a: createTimeServerConfig() };

    const manager1 = await pool.getMCPManager(config1);
    const manager2 = await pool.getMCPManager(config2);

    // Should reuse same manager (same servers, different order)
    assertEquals(manager1, manager2);

    const stats = pool.getPoolStats();
    assertEquals(stats.totalPooledManagers, 1);
    assertEquals(stats.activeReferences, 2);

    pool.releaseMCPManager(config1);
    pool.releaseMCPManager(config2);

    await cleanupTest(pool);
  },
);
