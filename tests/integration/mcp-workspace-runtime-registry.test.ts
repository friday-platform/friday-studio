import { assertEquals, assertExists } from "@std/assert";
import { expect } from "@std/expect";
import { delay } from "../utils/test-utils.ts";
import { PlatformMCPServer } from "../../src/core/mcp/platform-mcp-server.ts";
import { WorkspaceRuntimeRegistry } from "../../src/core/workspace-runtime-registry.ts";
// import { EnhancedTestEnvironment } from "../utils/test-environment.ts";

/**
 * Integration tests for MCP WorkspaceRuntimeRegistry integration
 * Tests the complete MCP flow through the runtime registry
 */

// Mock configuration for testing - use type casting for simplicity
const mockAtlasConfig = {
  version: "1.0.0",
  workspace: { id: "test", name: "Test" },
  supervisors: {
    workspace: { model: "test", prompts: { system: "test" } },
    session: { model: "test", prompts: { system: "test" } },
    agent: { model: "test", prompts: { system: "test" } },
  },
  memory: {
    default: { enabled: true, storage: "memory", cognitive_loop: false, retention: { max_age_days: 30, cleanup_interval_hours: 24 } },
    agent: { enabled: true, scope: "agent" as const, include_in_context: true, context_limits: { relevant_memories: 10, past_successes: 5, past_failures: 5 }, memory_types: {} },
    session: { enabled: true, scope: "session" as const, include_in_context: true, context_limits: { relevant_memories: 10, past_successes: 5, past_failures: 5 }, memory_types: {} },
    workspace: { enabled: true, scope: "workspace" as const, include_in_context: true, context_limits: { relevant_memories: 10, past_successes: 5, past_failures: 5 }, memory_types: {} },
  },
  planning: {
    execution: { precomputation: "minimal" as const, cache_enabled: false, cache_ttl_hours: 1, invalidate_on_job_change: true, strategy_selection: { simple_jobs: "direct", complex_jobs: "planning", optimization_jobs: "optimization", planning_jobs: "meta-planning" }, strategy_thresholds: { complexity: 0.5, uncertainty: 0.3, optimization: 0.7 } },
    validation: { precomputation: "minimal" as const, functional_validators: false, smoke_tests: false, content_safety: false, llm_threshold: 0.8, llm_fallback: true, cache_enabled: false, cache_ttl_hours: 1, fail_fast: false, external_services: { openai_moderation: false, perspective_api: false, deepeval_service: null } },
  },
  jobs: {},
} as any; // Type cast to avoid complex type construction in tests

Deno.test("MCP Platform Server - WorkspaceRuntimeRegistry Integration", async (t) => {
  let mcpServer: PlatformMCPServer;
  let registry: WorkspaceRuntimeRegistry;

  await t.step("setup test environment", async () => {
    // Simple setup without EnhancedTestEnvironment
    
    // Get registry instance and clear any existing workspaces
    registry = WorkspaceRuntimeRegistry.getInstance();
    const existingIds = registry.getWorkspaceIds();
    for (const id of existingIds) {
      registry.unregister(id);
    }

    // Create MCP server with runtime registry
    mcpServer = new PlatformMCPServer({
      runtimeRegistry: registry,
      atlasConfig: mockAtlasConfig,
    });
  });

  await t.step("should initialize MCP server with runtime registry", () => {
    assertExists(mcpServer);
    assertEquals(registry.getActiveCount(), 0);
    
    const availableTools = mcpServer.getAvailableTools();
    expect(availableTools).toContain("workspace_list");
    expect(availableTools).toContain("workspace_describe");
    expect(availableTools).toContain("workspace_trigger_job");
    expect(availableTools).toContain("workspace_process_signal");
  });

  await t.step("workspace_list should return empty registry", async () => {
    // Test that workspace_list tool is available
    const availableTools = mcpServer.getAvailableTools();
    expect(availableTools).toContain("workspace_list");
    
    // Test empty registry response
    const workspaces = registry.listWorkspaces();
    assertEquals(workspaces.length, 0);
  });

  await t.step("should register mock workspace runtime", async () => {
    // Create mock workspace runtime
    const mockRuntime = {
      getState: () => "ready",
      getStatus: () => ({
        workspace: "test-integration-workspace",
        supervisor: "supervisor-456",
        sessions: 0,
        workers: {
          total: 1,
          byType: { supervisor: 1, session: 0, agent: 0 },
        },
        state: "ready",
      }),
      getSessions: () => [],
      getWorkers: () => [],
      listJobs: async () => [
        { name: "integration-job", description: "Integration test job" },
      ],
      listSessions: async () => [],
      listSignals: async () => [
        { name: "test-signal", description: "Test signal for integration" },
      ],
      listAgents: async () => [
        { id: "test-agent", type: "llm", purpose: "Integration test agent" },
      ],
      triggerJob: async (jobName: string, payload?: any) => ({
        sessionId: `session-${crypto.randomUUID()}`,
      }),
      processSignal: async (signal: any, payload: any) => ({
        id: `session-${crypto.randomUUID()}`,
      }),
      shutdown: async () => {},
    };

    const mockWorkspace = {
      id: "test-integration-workspace",
      snapshot: () => ({ id: "test-integration-workspace" }),
    };

    const metadata = {
      name: "Integration Test Workspace",
      description: "Workspace created for MCP integration testing",
    };

    // Register the mock runtime
    registry.register(
      "test-integration-workspace",
      mockRuntime as any,
      mockWorkspace as any,
      metadata,
    );

    assertEquals(registry.getActiveCount(), 1);
    assertEquals(registry.isRunning("test-integration-workspace"), true);
  });

  await t.step("workspace_list should return registered workspace", async () => {
    const workspaces = registry.listWorkspaces();
    
    assertEquals(workspaces.length >= 1, true); // At least one workspace
    const testWorkspace = workspaces.find(w => w.id === "test-integration-workspace");
    assertEquals(testWorkspace !== undefined, true);
    assertEquals(testWorkspace?.name, "Integration Test Workspace");
    assertEquals(testWorkspace?.status, "ready");
  });

  await t.step("workspace_describe should return detailed runtime info", async () => {
    const description = await registry.describeWorkspace("test-integration-workspace");
    
    assertEquals(description.id, "test-integration-workspace");
    assertEquals(description.name, "Integration Test Workspace");
    assertEquals(description.status, "ready");
    assertEquals(description.runtime.supervisor, "supervisor-456");
    assertEquals(description.runtime.workers.total, 1);
    assertEquals(Array.isArray(description.jobs), true);
    assertEquals(description.jobs.length, 1);
    assertEquals(description.jobs[0].name, "integration-job");
    assertEquals(Array.isArray(description.signals), true);
    assertEquals(description.signals.length, 1);
    assertEquals(description.signals[0].name, "test-signal");
    assertEquals(Array.isArray(description.agents), true);
    assertEquals(description.agents.length, 1);
    assertEquals(description.agents[0].id, "test-agent");
  });

  await t.step("should trigger job through runtime registry", async () => {
    const result = await registry.triggerJob(
      "test-integration-workspace",
      "integration-job",
      { testData: "integration-payload" },
    );
    
    assertExists(result.sessionId);
    assertEquals(typeof result.sessionId, "string");
    assertEquals(result.sessionId.startsWith("session-"), true);
  });

  await t.step("should process signal through runtime registry", async () => {
    const result = await registry.processSignal(
      "test-integration-workspace",
      "test-signal",
      { eventData: "signal-payload" },
    );
    
    assertExists(result.sessionId);
    assertEquals(typeof result.sessionId, "string");
    assertEquals(result.sessionId.startsWith("session-"), true);
  });

  await t.step("should handle multiple concurrent workspace operations", async () => {
    // Register second workspace
    const mockRuntime2 = {
      getState: () => "processing",
      getStatus: () => ({
        workspace: "concurrent-workspace",
        supervisor: "supervisor-789",
        sessions: 2,
        workers: {
          total: 3,
          byType: { supervisor: 1, session: 1, agent: 1 },
        },
        state: "processing",
      }),
      getSessions: () => [],
      getWorkers: () => [],
      listJobs: async () => [
        { name: "concurrent-job", description: "Concurrent test job" },
      ],
      listSessions: async () => [
        { id: "session-1", status: "running", startedAt: new Date().toISOString() },
        { id: "session-2", status: "running", startedAt: new Date().toISOString() },
      ],
      listSignals: async () => [
        { name: "concurrent-signal", description: "Concurrent signal" },
      ],
      listAgents: async () => [
        { id: "concurrent-agent", type: "remote", purpose: "Concurrent agent" },
      ],
      triggerJob: async () => ({ sessionId: `session-${crypto.randomUUID()}` }),
      processSignal: async () => ({ id: `session-${crypto.randomUUID()}` }),
      shutdown: async () => {},
    };

    const mockWorkspace2 = {
      id: "concurrent-workspace",
      snapshot: () => ({ id: "concurrent-workspace" }),
    };

    registry.register(
      "concurrent-workspace",
      mockRuntime2 as any,
      mockWorkspace2 as any,
      { name: "Concurrent Workspace", description: "Second workspace" },
    );

    // Test concurrent operations
    const operations = await Promise.all([
      registry.describeWorkspace("test-integration-workspace"),
      registry.describeWorkspace("concurrent-workspace"),
      registry.triggerJob("test-integration-workspace", "integration-job"),
      registry.triggerJob("concurrent-workspace", "concurrent-job"),
    ]);

    assertEquals(operations.length, 4);
    assertEquals(operations[0].id, "test-integration-workspace");
    assertEquals(operations[1].id, "concurrent-workspace");
    assertEquals(operations[1].runtime.sessions, 2);
    assertEquals(operations[1].runtime.workers.total, 3);
    assertExists(operations[2].sessionId);
    assertExists(operations[3].sessionId);

    // Verify registry state
    assertEquals(registry.getActiveCount(), 2);
    const workspacesList = registry.listWorkspaces();
    assertEquals(workspacesList.length, 2);
  });

  await t.step("should handle workspace deletion and cleanup", async () => {
    // Delete one workspace
    await registry.deleteWorkspace("concurrent-workspace");
    
    assertEquals(registry.getActiveCount(), 1);
    assertEquals(registry.isRunning("concurrent-workspace"), false);
    assertEquals(registry.isRunning("test-integration-workspace"), true);
    
    const remainingWorkspaces = registry.listWorkspaces();
    assertEquals(remainingWorkspaces.length, 1);
    assertEquals(remainingWorkspaces[0].id, "test-integration-workspace");
  });

  await t.step("teardown", async () => {
    // Clean up remaining workspace
    registry.unregister("test-integration-workspace");
    assertEquals(registry.getActiveCount(), 0);
    
    // Stop MCP server
    await mcpServer.stop();
  });
});