#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --unstable-broadcast-channel --unstable-worker-options

/**
 * Test supervisor worker initialization
 */

import { WorkerManager } from "../../src/core/utils/worker-manager.ts";

async function testSupervisorWorker() {
  console.log("🧪 Testing Supervisor Worker...\n");
  
  const manager = new WorkerManager();
  
  try {
    console.log("1️⃣ Spawning supervisor worker...");
    
    const supervisorMetadata = {
      id: "test-supervisor",
      type: "supervisor" as const,
      config: {
        id: "test-workspace",
        workspace: {
          id: "test-workspace",
          signals: 0,
          agents: 0,
        },
        config: {
          model: "claude-3-haiku-20240307"
        }
      }
    };
    
    const supervisor = await manager.spawnWorker(
      supervisorMetadata,
      new URL("../../src/core/workers/workspace-supervisor-worker.ts", import.meta.url).href
    );
    
    console.log("✅ Supervisor spawned:", supervisor.id);
    
    // Check state periodically
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const state = manager.getWorkerState(supervisor.id);
      console.log(`   State after ${i+1}s:`, state);
      
      if (state === 'ready') {
        console.log("✅ Supervisor is ready!");
        break;
      }
      
      if (state === 'error') {
        console.log("❌ Supervisor entered error state");
        break;
      }
    }
    
    // Clean up
    await manager.shutdown();
    console.log("✅ Manager shut down");
    
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

testSupervisorWorker();