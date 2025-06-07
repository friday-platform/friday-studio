#!/usr/bin/env -S deno run --allow-read --allow-write

import { AtlasWorkspaceManager } from "../src/core/manager.ts";
import type { IWorkspaceSignal } from "../src/types/core.ts";

// Simple example signal for testing
class TestSignal implements IWorkspaceSignal {
  public readonly id: string = crypto.randomUUID();
  public parentScopeId?: string;
  public supervisor = undefined;
  public context: any;
  public memory: any;
  public messages: any;
  public prompts = { system: "", user: "" };
  public gates: any[] = [];
  
  public provider = {
    id: "test",
    name: "Test Signal Provider"
  };

  async trigger(): Promise<void> {
    console.log(`[TestSignal] Triggered signal ${this.id}`);
    // Simulate some async work
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  configure(config: any): void {
    console.log(`[TestSignal] Configured with:`, config);
  }

  // IAtlasScope methods
  newConversation(): any { return this.messages; }
  getConversation(): any { return this.messages; }
  archiveConversation(): void {}
  deleteConversation(): void {}
}

async function runExample() {
  console.log("🚀 Atlas Example - Local Dev Tool");
  console.log("=================================\n");

  // Initialize Atlas manager
  const manager = new AtlasWorkspaceManager();

  // Create a workspace
  console.log("1. Creating workspace...");
  const workspace = await manager.createWorkspace("example-project", "alice");
  console.log(`✓ Created workspace: ${workspace.id}\n`);

  // Add a test signal
  console.log("2. Adding test signal...");
  const signal = new TestSignal();
  const result = workspace.addSignal(signal);
  if (result) {
    console.error("Failed to add signal:", result);
    return;
  }
  console.log(`✓ Added signal: ${signal.id}\n`);

  // Get workspace status
  console.log("3. Workspace status:");
  console.log(JSON.stringify(workspace.snapshot(), null, 2));
  console.log();

  // Trigger signal processing via supervisor
  console.log("4. Processing signal via supervisor...");
  if (workspace.supervisor) {
    const session = workspace.supervisor.spawnSession(signal);
    await session.start();
    console.log(`✓ Session completed: ${session.summarize()}\n`);
  }

  // Show final status
  console.log("5. Final workspace status:");
  const finalSnapshot = workspace.snapshot();
  console.log(`- Active sessions: ${finalSnapshot.activeSessionCount}`);
  console.log(`- Artifacts: ${finalSnapshot.artifactCount}`);
  console.log(`- Memory items: ${finalSnapshot.memorySize}`);
  console.log(`- Context items: ${finalSnapshot.contextSize}`);

  console.log("\n✨ Example completed! Check .atlas/ directory for stored data.");
}

if (import.meta.main) {
  await runExample();
}