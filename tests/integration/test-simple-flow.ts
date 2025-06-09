#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --unstable-broadcast-channel --unstable-worker-options

/**
 * Simplified integration test focusing on the core issue
 */

import { WorkerManager } from "../../src/core/utils/worker-manager.ts";

async function testWorkerManager() {
  console.log("🧪 Testing WorkerManager...\n");
  
  const manager = new WorkerManager();
  
  try {
    // Test spawning a simple worker
    console.log("1️⃣ Spawning test worker...");
    
    const workerUrl = new URL("./test-worker.ts", import.meta.url).href;
    
    // Create a simple test worker file first
    await Deno.writeTextFile("./test-worker.ts", `
      console.log("[TestWorker] Starting...");
      
      self.onmessage = (event) => {
        console.log("[TestWorker] Received:", event.data);
        
        if (event.data.type === 'init') {
          console.log("[TestWorker] Initializing...");
          self.postMessage({ type: 'initialized' });
        }
      };
    `);
    
    const worker = await manager.spawnWorker(
      { id: "test-1", type: "agent" as any },
      workerUrl
    );
    
    console.log("✅ Worker spawned:", worker.id);
    
    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const state = manager.getWorkerState(worker.id);
    console.log("   State:", state);
    
    // Clean up
    await manager.shutdown();
    console.log("✅ Manager shut down");
    
    // Remove test file
    await Deno.remove("./test-worker.ts");
    
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

testWorkerManager();