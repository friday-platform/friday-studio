#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --unstable-broadcast-channel --unstable-worker-options

/**
 * Integration test for workspace flow
 * Tests: Create workspace → Start runtime → Process signal → Get session
 */

import { Workspace } from "./src/core/workspace.ts";
import { WorkspaceRuntime } from "./src/core/workspace-runtime.ts";
import { WorkspaceServer } from "./src/core/workspace-server.ts";
import { AtlasScope } from "./src/core/scope.ts";
import type { IWorkspaceSignal } from "./src/types/core.ts";

// Mock signal implementation
class TestSignal extends AtlasScope implements IWorkspaceSignal {
  provider = { id: "test", name: "Test Signal" };
  
  constructor(id: string) {
    super();
    (this as any).id = id;
  }
  
  async trigger(): Promise<void> {
    console.log("[Signal] Triggered");
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
      system: "You are a test supervisor. When you receive a signal, create a simple execution plan.",
      user: ""
    }
  },
  signals: [
    {
      id: "test-message",
      provider: { id: "test", name: "Test Signal" },
      description: "Test signal for integration test"
      // Note: Functions can't be sent to workers, so we omit trigger
    }
  ]
};

async function runTest() {
  console.log("🧪 Starting workspace integration test...\n");

  try {
    // 1. Create workspace from config
    console.log("1️⃣ Creating workspace...");
    const workspace = Workspace.fromConfig(testConfig, { 
      id: "test-owner",
      name: testConfig.owner,
      role: "owner" as any
    });
    
    // Add a proper signal instance
    const testSignal = new TestSignal("test-message");
    workspace.addSignal(testSignal);
    
    console.log("✅ Workspace created:", workspace.id);
    console.log("   Signals:", Object.keys(workspace.signals));
    
    // 2. Create runtime
    console.log("\n2️⃣ Creating runtime...");
    const runtime = new WorkspaceRuntime(workspace, testConfig, { lazy: false });
    
    // Wait a bit for supervisor to initialize
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log("✅ Runtime created");
    console.log("   Status:", runtime.getStatus());
    
    // 3. Process a signal
    console.log("\n3️⃣ Processing signal...");
    const signal = workspace.signals["test-message"];
    if (!signal) {
      throw new Error("Test signal not found");
    }
    
    const session = await runtime.processSignal(signal, {
      message: "Hello from integration test"
    });
    console.log("✅ Signal processed");
    console.log("   Session ID:", session.id);
    console.log("   Session status:", session.status);
    
    // 4. Check session exists
    console.log("\n4️⃣ Verifying session...");
    const retrievedSession = runtime.getSession(session.id);
    if (!retrievedSession) {
      throw new Error("Session not found after creation");
    }
    console.log("✅ Session verified");
    console.log("   Progress:", retrievedSession.progress(), "%");
    console.log("   Summary:", retrievedSession.summarize());
    
    // 5. Test HTTP server (optional)
    console.log("\n5️⃣ Testing HTTP server...");
    const server = new WorkspaceServer(runtime, { port: 8082 });
    
    // Start server in background
    const serverPromise = server.start();
    
    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Make a test request
    const healthResponse = await fetch("http://localhost:8082/health");
    const health = await healthResponse.json();
    console.log("✅ Server health check:", health.status);
    
    // Test signal endpoint
    const signalResponse = await fetch("http://localhost:8082/signals/test-message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Test via HTTP" })
    });
    const signalResult = await signalResponse.json();
    console.log("✅ Signal via HTTP:", signalResult.message);
    
    // 6. Cleanup
    console.log("\n6️⃣ Cleaning up...");
    await runtime.shutdown();
    console.log("✅ Runtime shut down");
    
    console.log("\n✨ All tests passed!");
    
  } catch (error) {
    console.error("\n❌ Test failed:", error);
    Deno.exit(1);
  }
  
  Deno.exit(0);
}

// Run the test
runTest();