import { assertEquals, assertRejects } from "@std/assert";
import { WorkspaceRuntimeRegistry } from "../../src/core/workspace-runtime-registry.ts";
import { WorkspaceRuntime } from "../../src/core/workspace-runtime.ts";
import { Workspace } from "../../src/core/workspace.ts";

/**
 * Unit tests for WorkspaceRuntimeRegistry
 * Tests the core registry functionality without external dependencies
 */

// Mock WorkspaceRuntime for testing
class MockWorkspaceRuntime {
  private sessions = new Map();
  private workers: any[] = [];
  private state = "ready";

  constructor(public workspaceId: string) {}

  getState(): string {
    return this.state;
  }

  getStatus() {
    return {
      workspace: this.workspaceId,
      supervisor: "supervisor-123",
      sessions: this.sessions.size,
      workers: {
        total: this.workers.length,
        byType: {
          supervisor: 1,
          session: 0,
          agent: 0,
        },
      },
      state: this.state,
    };
  }

  getSessions() {
    return Array.from(this.sessions.values());
  }

  getWorkers() {
    return this.workers;
  }

  async listJobs() {
    return [
      { name: "test-job", description: "Test job" },
    ];
  }

  async listSessions() {
    return [
      { id: "session-123", status: "running", startedAt: new Date().toISOString() },
    ];
  }

  async listSignals() {
    return [
      { name: "test-signal", description: "Test signal" },
    ];
  }

  async listAgents() {
    return [
      { id: "agent-123", type: "llm", purpose: "Test agent" },
    ];
  }

  async triggerJob(jobName: string, payload?: any) {
    return { sessionId: "session-" + crypto.randomUUID() };
  }

  async processSignal(signal: any, payload: any) {
    return { id: "session-" + crypto.randomUUID() };
  }

  async shutdown() {
    this.state = "terminated";
  }
}

// Mock Workspace for testing
class MockWorkspace {
  constructor(public id: string) {}

  snapshot() {
    return { id: this.id };
  }
}

Deno.test("WorkspaceRuntimeRegistry", async (t) => {
  let registry: WorkspaceRuntimeRegistry;

  await t.step("setup", () => {
    // Get fresh registry instance for each test
    registry = WorkspaceRuntimeRegistry.getInstance();
    
    // Clear any existing registrations from other tests
    const workspaceIds = registry.getWorkspaceIds();
    for (const id of workspaceIds) {
      registry.unregister(id);
    }
  });

  await t.step("should start with empty registry", () => {
    assertEquals(registry.getActiveCount(), 0);
    assertEquals(registry.getWorkspaceIds().length, 0);
  });

  await t.step("should register workspace runtime", () => {
    const runtime = new MockWorkspaceRuntime("test-workspace-1") as any;
    const workspace = new MockWorkspace("test-workspace-1") as any;
    const metadata = { name: "Test Workspace", description: "A test workspace" };

    registry.register("test-workspace-1", runtime, workspace, metadata);

    assertEquals(registry.getActiveCount(), 1);
    assertEquals(registry.isRunning("test-workspace-1"), true);
    assertEquals(registry.getWorkspaceIds(), ["test-workspace-1"]);
  });

  await t.step("should list registered workspaces", () => {
    const workspaces = registry.listWorkspaces();

    assertEquals(workspaces.length, 1);
    assertEquals(workspaces[0].id, "test-workspace-1");
    assertEquals(workspaces[0].name, "Test Workspace");
    assertEquals(workspaces[0].description, "A test workspace");
    assertEquals(workspaces[0].status, "ready");
    assertEquals(workspaces[0].sessions, 0);
    assertEquals(workspaces[0].workers, 0);
  });

  await t.step("should get workspace by id", () => {
    const workspace = registry.getWorkspace("test-workspace-1");

    assertEquals(workspace?.id, "test-workspace-1");
    assertEquals(workspace?.name, "Test Workspace");
    assertEquals(workspace?.runtime, registry.getWorkspace("test-workspace-1")?.runtime);
  });

  await t.step("should describe workspace with detailed info", async () => {
    const description = await registry.describeWorkspace("test-workspace-1");

    assertEquals(description.id, "test-workspace-1");
    assertEquals(description.name, "Test Workspace");
    assertEquals(description.description, "A test workspace");
    assertEquals(description.status, "ready");
    assertEquals(Array.isArray(description.sessions), true);
    assertEquals(Array.isArray(description.jobs), true);
    assertEquals(Array.isArray(description.signals), true);
    assertEquals(Array.isArray(description.agents), true);
    assertEquals(description.runtime.supervisor, "supervisor-123");
  });

  await t.step("should process signal through runtime", async () => {
    const result = await registry.processSignal("test-workspace-1", "test-signal", { data: "test" });

    assertEquals(typeof result.sessionId, "string");
    assertEquals(result.sessionId.startsWith("session-"), true);
  });

  await t.step("should trigger job through runtime", async () => {
    const result = await registry.triggerJob("test-workspace-1", "test-job", { input: "test" });

    assertEquals(typeof result.sessionId, "string");
    assertEquals(result.sessionId.startsWith("session-"), true);
  });

  await t.step("should unregister workspace runtime", () => {
    registry.unregister("test-workspace-1");

    assertEquals(registry.getActiveCount(), 0);
    assertEquals(registry.isRunning("test-workspace-1"), false);
    assertEquals(registry.getWorkspaceIds().length, 0);
  });

  await t.step("should handle multiple workspace registrations", () => {
    const runtime1 = new MockWorkspaceRuntime("workspace-1") as any;
    const runtime2 = new MockWorkspaceRuntime("workspace-2") as any;
    const workspace1 = new MockWorkspace("workspace-1") as any;
    const workspace2 = new MockWorkspace("workspace-2") as any;

    registry.register("workspace-1", runtime1, workspace1, { name: "Workspace 1" });
    registry.register("workspace-2", runtime2, workspace2, { name: "Workspace 2" });

    assertEquals(registry.getActiveCount(), 2);
    assertEquals(registry.isRunning("workspace-1"), true);
    assertEquals(registry.isRunning("workspace-2"), true);

    const workspaces = registry.listWorkspaces();
    assertEquals(workspaces.length, 2);

    // Cleanup
    registry.unregister("workspace-1");
    registry.unregister("workspace-2");
  });

  await t.step("should throw error for nonexistent workspace", async () => {
    await assertRejects(
      () => registry.describeWorkspace("nonexistent-workspace"),
      Error,
      "Workspace 'nonexistent-workspace' not found or not running",
    );

    await assertRejects(
      () => registry.processSignal("nonexistent-workspace", "signal", {}),
      Error,
      "Workspace 'nonexistent-workspace' not found or not running",
    );

    await assertRejects(
      () => registry.triggerJob("nonexistent-workspace", "job"),
      Error,
      "Workspace 'nonexistent-workspace' not found or not running",
    );
  });

  await t.step("should delete workspace and shutdown runtime", async () => {
    const runtime = new MockWorkspaceRuntime("delete-test") as any;
    const workspace = new MockWorkspace("delete-test") as any;

    registry.register("delete-test", runtime, workspace, { name: "Delete Test" });
    assertEquals(registry.isRunning("delete-test"), true);

    await registry.deleteWorkspace("delete-test");
    assertEquals(registry.isRunning("delete-test"), false);
    assertEquals(runtime.getState(), "terminated");
  });

  await t.step("should handle singleton pattern correctly", () => {
    const instance1 = WorkspaceRuntimeRegistry.getInstance();
    const instance2 = WorkspaceRuntimeRegistry.getInstance();

    assertEquals(instance1, instance2);
    assertEquals(instance1 === instance2, true);
  });
});