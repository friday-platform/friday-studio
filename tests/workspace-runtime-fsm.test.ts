import { assertEquals, assertExists } from "@std/assert";
import { WorkspaceRuntime } from "../src/core/workspace-runtime.ts";
import { createMockWorkspace } from "./fixtures/mocks.ts";

// Mock workspace for testing
const mockWorkspace = createMockWorkspace("test-workspace", "Test Workspace");

Deno.test({
  name: "WorkspaceRuntime FSM - Initial state",
  sanitizeResources: false, // Logger opens files that persist across tests
  sanitizeOps: false,
  fn: async () => {
    const runtime = new WorkspaceRuntime(mockWorkspace, {}, { lazy: true });

    try {
      assertEquals(runtime.getState(), "uninitialized");

      const status = runtime.getStatus();
      assertEquals(status.state, "uninitialized");
      assertEquals(status.sessions, 0);

      // Since we're lazy, shutdown should transition directly from uninitialized to terminated
      await runtime.shutdown();
      assertEquals(runtime.getState(), "terminated");
    } finally {
      // Cleanup is handled by runtime.shutdown()
    }
  },
});

Deno.test({
  name: "WorkspaceRuntime FSM - State transitions",
  sanitizeResources: false, // Logger opens files that persist across tests
  sanitizeOps: false,
  fn: async () => {
    // Create temporary directory for test
    const testDir = await Deno.makeTempDir();
    const originalCwd = Deno.cwd();

    try {
      // Change to test directory
      Deno.chdir(testDir);

      // Create minimal config files
      await Deno.writeTextFile(
        "workspace.yml",
        `
version: "1.0"
workspace:
  id: "f1b4e8c8-5d9a-4b3e-9f2a-1a3b5c7d9e1f"
  name: "Test Workspace"
  description: Test workspace
agents: {}
signals: {}
`,
      );

      await Deno.writeTextFile(
        "atlas.yml",
        `
version: "1.0"
platform:
  name: atlas
  version: "1.0.0"
memory:
  default:
    enabled: false
    storage: memory
    cognitive_loop: false
    retention:
      max_age_days: 7
      max_entries: 100
      cleanup_interval_hours: 24
  agent:
    enabled: false
    scope: agent
    include_in_context: false
    context_limits:
      relevant_memories: 5
      past_successes: 3
      past_failures: 2
    memory_types: {}
  session:
    enabled: false
    scope: session
    include_in_context: false
    context_limits:
      relevant_memories: 10
      past_successes: 5
      past_failures: 3
    memory_types: {}
  workspace:
    enabled: false
    scope: workspace
    include_in_context: false
    context_limits:
      relevant_memories: 20
      past_successes: 10
      past_failures: 5
    memory_types: {}
supervisors:
  workspace:
    model: claude-3-haiku-20240307
    prompts:
      system: "Test supervisor"
  session:
    model: claude-3-haiku-20240307
    prompts:
      system: "Test session supervisor"
  agent:
    model: claude-3-haiku-20240307
    prompts:
      system: "Test agent supervisor"
agents: {}
`,
      );

      await Deno.mkdir("jobs");

      // Set a dummy API key
      const originalApiKey = Deno.env.get("ANTHROPIC_API_KEY");
      Deno.env.set("ANTHROPIC_API_KEY", "test-api-key");

      const runtime = new WorkspaceRuntime(mockWorkspace, {}, { lazy: false });

      try {
        // Wait for initialization to start
        await new Promise((resolve) => setTimeout(resolve, 1000));

        const state = runtime.getState();
        console.log("Current state:", state);

        // Should be either initializing, initializingStreams, or ready
        const validStates = ["initializing", "initializingStreams", "ready"];
        assertEquals(validStates.includes(state), true);
      } finally {
        // Always shutdown to clean up resources
        await runtime.shutdown();

        // Give time for cleanup to complete
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Restore API key
        if (originalApiKey) {
          Deno.env.set("ANTHROPIC_API_KEY", originalApiKey);
        } else {
          Deno.env.delete("ANTHROPIC_API_KEY");
        }
      }
    } finally {
      // Restore original directory and clean up
      Deno.chdir(originalCwd);
      await Deno.remove(testDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "WorkspaceRuntime FSM - Shutdown transitions",
  sanitizeResources: false, // Logger opens files that persist across tests
  sanitizeOps: false,
  fn: async () => {
    const runtime = new WorkspaceRuntime(mockWorkspace, {}, { lazy: true });

    // Start in uninitialized
    assertEquals(runtime.getState(), "uninitialized");

    // Trigger shutdown
    const shutdownPromise = runtime.shutdown();

    // Should transition through draining to terminated
    await shutdownPromise;

    // Final state should be terminated
    assertEquals(runtime.getState(), "terminated");
  },
});

Deno.test({
  name: "WorkspaceRuntime FSM - Status includes state",
  sanitizeResources: false, // Logger opens files that persist across tests
  sanitizeOps: false,
  fn: async () => {
    const runtime = new WorkspaceRuntime(mockWorkspace, {}, { lazy: true });

    const status = runtime.getStatus();

    assertExists(status.state);
    assertEquals(status.state, "uninitialized");
    assertEquals(status.workspace, "test-workspace");
    assertEquals(status.sessions, 0);
    assertExists(status.workers);

    // Cleanup
    await runtime.shutdown();
  },
});
