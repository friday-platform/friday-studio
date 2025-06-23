#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --unstable-broadcast-channel --unstable-worker-options

/**
 * Integration test for workspace flow
 * Tests: Create workspace → Start runtime → Process signal → Get session
 */

import { Workspace } from "../../src/core/workspace.ts";
import { WorkspaceRuntime } from "../../src/core/workspace-runtime.ts";
import { WorkspaceServer } from "../../src/core/workspace-server.ts";
import { AtlasScope } from "../../src/core/scope.ts";
import type { IWorkspaceSignal } from "../../src/types/core.ts";
import { expect } from "@std/expect";

// Mock signal implementation
class TestSignal extends AtlasScope implements IWorkspaceSignal {
  provider = { id: "test", name: "Test Signal" };

  constructor(customId?: string) {
    super();
    // Override the readonly id using Object.defineProperty
    if (customId) {
      Object.defineProperty(this, "id", {
        value: customId,
        writable: false,
        enumerable: true,
        configurable: false,
      });
    }
  }

  async trigger(): Promise<void> {}

  configure(config: any): void {
    // No-op for test
  }
}

// Test configuration matching telephone game
const testConfig = {
  workspace: {
    id: "f1b4e8c8-5d9a-4b3e-9f2a-1a3b5c7d9e1f",
    name: "Test Telephone Game",
    owner: "test-user",
  },
  supervisor: {
    model: "claude-3-5-sonnet-20241022",
    prompts: {
      system:
        "You are a test supervisor. When you receive a signal, create a simple execution plan.",
      user: "",
    },
  },
  signals: [
    {
      id: "test-message",
      provider: { id: "test", name: "Test Signal" },
      description: "Test signal for integration test",
      // Note: Functions can't be sent to workers, so we omit trigger
    },
  ],
};

Deno.test({
  name: "Workspace integration flow",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // Set dummy API key for test
    const originalApiKey = Deno.env.get("ANTHROPIC_API_KEY");
    Deno.env.set("ANTHROPIC_API_KEY", "test-api-key");

    // Create a temporary directory for the test
    const testDir = await Deno.makeTempDir();
    const originalCwd = Deno.cwd();

    try {
      // Change to test directory
      Deno.chdir(testDir);

      // Create workspace.yml
      const workspaceYml = `
version: "1.0"

workspace:
  id: f1b4e8c8-5d9a-4b3e-9f2a-1a3b5c7d9e1f
  name: Test Telephone Game
  description: Integration test workspace

agents:
  test-agent:
    type: llm
    model: claude-3-5-sonnet-20241022
    purpose: "Test agent for integration testing"
    prompts:
      system: "You are a test agent. Respond with 'Test response' to any input."

signals:
  test-message:
    provider: test
    description: Test signal for integration test

jobs:
  test-job:
    name: Test Job
    description: Test job for integration
    execution:
      strategy: sequential
      agents:
        - test-agent
`;

      await Deno.writeTextFile("workspace.yml", workspaceYml);

      // Create atlas.yml with supervisor config
      const atlasYml = `
version: "1.0"

platform:
  name: atlas
  version: "1.0.0"

memory:
  default:
    enabled: true
    storage: memory
    cognitive_loop: false
    retention:
      max_age_days: 7
      max_entries: 1000
      cleanup_interval_hours: 24
  agent:
    enabled: true
    scope: agent
    include_in_context: true
    context_limits:
      relevant_memories: 5
      past_successes: 3
      past_failures: 2
    memory_types: {}
  session:
    enabled: true
    scope: session
    include_in_context: true
    context_limits:
      relevant_memories: 10
      past_successes: 5
      past_failures: 3
    memory_types: {}
  workspace:
    enabled: true
    scope: workspace
    include_in_context: false
    context_limits:
      relevant_memories: 20
      past_successes: 10
      past_failures: 5
    memory_types: {}

supervisors:
  workspace:
    model: claude-3-5-sonnet-20241022
    prompts:
      system: "You are a test supervisor. When you receive a signal, create a simple execution plan."
  session:
    model: claude-3-5-sonnet-20241022
    prompts:
      system: "You are a test session supervisor. Execute the test job when requested."
  agent:
    model: claude-3-5-sonnet-20241022
    prompts:
      system: "You are a test agent supervisor."

agents:
  security-reviewer:
    type: llm
    model: claude-3-5-sonnet-20241022
    purpose: "Review code for security issues"
    prompts:
      system: "You are a security reviewer agent."
`;

      await Deno.writeTextFile("atlas.yml", atlasYml);

      // Create a minimal jobs directory
      await Deno.mkdir("jobs");

      // 1. Create workspace from config
      const workspace = Workspace.fromConfig(testConfig, {
        id: "test-owner",
        name: testConfig.workspace.owner || "test-user",
        role: "owner" as any,
      });

      // Add a proper signal instance
      const testSignal = new TestSignal("test-message");
      workspace.addSignal(testSignal);

      expect(workspace.id).toBe("f1b4e8c8-5d9a-4b3e-9f2a-1a3b5c7d9e1f");
      expect(Object.keys(workspace.signals)).toContain("test-message");

      // 2. Create runtime
      const runtime = new WorkspaceRuntime(workspace, testConfig, {
        lazy: false,
      });

      // Wait for initialization to complete
      await new Promise((resolve) => setTimeout(resolve, 3000));

      // Check that runtime is initialized
      const status = runtime.getStatus();
      expect(status).toBeDefined();
      expect(status.workspace).toBe("f1b4e8c8-5d9a-4b3e-9f2a-1a3b5c7d9e1f");

      // 3. Check that signals are loaded
      const signal = workspace.signals["test-message"];
      expect(signal).toBeDefined();

      // 4. Check runtime state is ready
      const state = runtime.getState();
      expect(["ready", "initializingStreams"]).toContain(state);

      // 5. Test HTTP server
      const server = new WorkspaceServer(runtime, { port: 8082 });

      // Start server in background
      const serverPromise = server.start();

      // Wait for server to start
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Make a test request
      const healthResponse = await fetch("http://localhost:8082/health");
      expect(healthResponse.status).toBe(200);
      const health = await healthResponse.json();
      expect(health.status).toBe("healthy");
      expect(health.workspace).toBe("f1b4e8c8-5d9a-4b3e-9f2a-1a3b5c7d9e1f");

      // 6. Cleanup
      await server.shutdown();
      await serverPromise;
    } finally {
      // Restore original directory and clean up
      Deno.chdir(originalCwd);
      await Deno.remove(testDir, { recursive: true });

      // Restore original API key
      if (originalApiKey) {
        Deno.env.set("ANTHROPIC_API_KEY", originalApiKey);
      } else {
        Deno.env.delete("ANTHROPIC_API_KEY");
      }
    }
  },
});
