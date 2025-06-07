import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { WorkspaceRuntime } from "../src/core/workspace-runtime.ts";
import type { IWorkspace } from "../src/types/core.ts";

// Mock workspace for testing
const mockWorkspace: IWorkspace = {
  id: "test-workspace",
  name: "Test Workspace",
  snapshot: () => ({
    id: "test-workspace",
    name: "Test Workspace",
    description: "Test workspace for FSM",
    agents: {},
    signals: {},
    workflows: {},
    sources: {},
    actions: {},
    members: []
  }),
  // Add other required IWorkspace properties as needed
} as IWorkspace;

Deno.test("WorkspaceRuntime FSM - Initial state", async () => {
  const runtime = new WorkspaceRuntime(mockWorkspace, {}, { lazy: true });
  
  assertEquals(runtime.getState(), "uninitialized");
  
  const status = runtime.getStatus();
  assertEquals(status.state, "uninitialized");
  assertEquals(status.sessions, 0);
  
  // Since we're lazy, shutdown should transition directly from uninitialized to terminated
  await runtime.shutdown();
  assertEquals(runtime.getState(), "terminated");
});

Deno.test("WorkspaceRuntime FSM - State transitions", async () => {
  const runtime = new WorkspaceRuntime(mockWorkspace, {}, { lazy: false });
  
  try {
    // Should start initializing immediately when lazy is false
    // Give it a moment to start the initialization
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const state = runtime.getState();
    console.log("Current state:", state);
    
    // Should be either initializing or ready (if initialization was fast)
    const validStates = ["initializing", "ready"];
    assertEquals(validStates.includes(state), true);
  } finally {
    // Always shutdown to clean up resources
    await runtime.shutdown();
    
    // Give time for cleanup to complete
    await new Promise(resolve => setTimeout(resolve, 200));
  }
});

Deno.test("WorkspaceRuntime FSM - Shutdown transitions", async () => {
  const runtime = new WorkspaceRuntime(mockWorkspace, {}, { lazy: true });
  
  // Start in uninitialized
  assertEquals(runtime.getState(), "uninitialized");
  
  // Trigger shutdown
  const shutdownPromise = runtime.shutdown();
  
  // Should transition through draining to terminated
  await shutdownPromise;
  
  // Final state should be terminated
  assertEquals(runtime.getState(), "terminated");
});

Deno.test("WorkspaceRuntime FSM - Status includes state", () => {
  const runtime = new WorkspaceRuntime(mockWorkspace, {}, { lazy: true });
  
  const status = runtime.getStatus();
  
  assertExists(status.state);
  assertEquals(status.state, "uninitialized");
  assertEquals(status.workspace, "test-workspace");
  assertEquals(status.sessions, 0);
  assertExists(status.workers);
});