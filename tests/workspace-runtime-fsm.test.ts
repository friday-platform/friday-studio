import { assertEquals, assertExists } from "@std/assert";
import { WorkspaceRuntime } from "../src/core/workspace-runtime.ts";
import { createMockWorkspace } from "./fixtures/mocks.ts";

// Mock workspace for testing
const mockWorkspace = createMockWorkspace("test-workspace", "Test Workspace");

Deno.test({
  name: "WorkspaceRuntime FSM - Initial state",
  sanitizeResources: false, // Logger opens files that persist across tests
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
  fn: async () => {
    const runtime = new WorkspaceRuntime(mockWorkspace, {}, { lazy: false });

    try {
      // Should start initializing immediately when lazy is false
      // Give it a moment to start the initialization
      await new Promise((resolve) => setTimeout(resolve, 100));

      const state = runtime.getState();
      console.log("Current state:", state);

      // Should be either initializing or ready (if initialization was fast)
      const validStates = ["initializing", "ready"];
      assertEquals(validStates.includes(state), true);
    } finally {
      // Always shutdown to clean up resources
      await runtime.shutdown();

      // Give time for cleanup to complete
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  },
});

Deno.test({
  name: "WorkspaceRuntime FSM - Shutdown transitions",
  sanitizeResources: false, // Logger opens files that persist across tests
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
