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
import { expect } from "jsr:@std/expect";

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

  async trigger(): Promise<void> {
  }

  configure(config: any): void {
    // No-op for test
  }
}

// Test configuration matching telephone game
const testConfig = {
  id: "test-telephone-workspace",
  name: "Test Telephone Game",
  owner: "test-user",
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

Deno.test("Workspace integration flow", async () => {
  // 1. Create workspace from config
  const workspace = Workspace.fromConfig(testConfig, {
    id: "test-owner",
    name: testConfig.owner,
    role: "owner" as any,
  });

  // Add a proper signal instance
  const testSignal = new TestSignal("test-message");
  workspace.addSignal(testSignal);

  expect(workspace.id).toBe("test-telephone-workspace");
  expect(Object.keys(workspace.signals)).toContain("test-message");

  // 2. Create runtime
  const runtime = new WorkspaceRuntime(workspace, testConfig, {
    lazy: false,
  });

  // Wait a bit for supervisor to initialize
  await new Promise((resolve) => setTimeout(resolve, 2000));
  expect(runtime).toBeDefined();
  expect(runtime.getStatus()).toBeDefined();

  // 3. Process a signal
  const signal = workspace.signals["test-message"];
  expect(signal).toBeDefined();

  const session = await runtime.processSignal(signal, {
    message: "Hello from integration test",
  });
  expect(session).toBeDefined();
  expect(session.id).toBeDefined();
  expect(session.status).toBeDefined();

  // 4. Check session exists
  const retrievedSession = runtime.getSession(session.id);
  expect(retrievedSession).toBeDefined();
  expect(retrievedSession?.id).toBe(session.id);
  expect(retrievedSession?.progress()).toBeGreaterThanOrEqual(0);
  expect(retrievedSession?.summarize()).toBeDefined();

  // 5. Test HTTP server (optional)
  const server = new WorkspaceServer(runtime, { port: 8082 });

  // Start server in background
  const serverPromise = server.start();

  // Wait for server to start
  await new Promise((resolve) => setTimeout(resolve, 1000));

  // Make a test request
  const healthResponse = await fetch("http://localhost:8082/health");
  expect(healthResponse.status).toBe(200);
  const health = await healthResponse.json();
  expect(health.status).toBeDefined();

  // Test signal endpoint
  const signalResponse = await fetch(
    "http://localhost:8082/signals/test-message",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Test via HTTP" }),
    }
  );
  expect(signalResponse.status).toBe(200);
  const signalResult = await signalResponse.json();
  expect(signalResult).toBeDefined();

  // 6. Cleanup
  await runtime.shutdown();

});

