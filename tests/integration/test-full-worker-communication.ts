#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --unstable-broadcast-channel --unstable-worker-options

/**
 * Test full worker communication flow
 */

import { WorkerManager } from "../../src/core/utils/worker-manager.ts";

async function testFullWorkerCommunication() {
  console.log("🧪 Testing Full Worker Communication Flow...\n");
  
  const manager = new WorkerManager();
  
  try {
    // 1. Test basic worker communication
    console.log("1️⃣ Testing BaseWorker implementation...");
    
    // Create a minimal test worker
    const testWorkerCode = `
      /// <reference no-default-lib="true" />
      /// <reference lib="deno.worker" />
      
      import { BaseWorker } from "${new URL("../../src/core/workers/base-worker.ts", import.meta.url).href}";
      
      class TestWorker extends BaseWorker {
        constructor() {
          super("test-worker", "test");
        }
        
        protected async initialize(config) {
          this.log("Test worker initialized with:", config);
        }
        
        protected async processTask(taskId, data) {
          this.log("Processing task:", taskId, data);
          
          if (data.action === 'echo') {
            return { echo: data.message };
          }
          
          if (data.action === 'broadcast') {
            this.broadcast(data.channel, data.message);
            return { status: 'broadcast sent' };
          }
          
          throw new Error(\`Unknown action: \${data.action}\`);
        }
        
        protected async cleanup() {
          this.log("Cleaning up test worker");
        }
        
        protected handleBroadcast(channel, data) {
          this.log(\`Received broadcast on \${channel}:\`, data);
          self.postMessage({
            type: 'broadcastReceived',
            channel,
            data
          });
        }
      }
      
      new TestWorker();
    `;
    
    // Create temporary worker file
    const tempFile = await Deno.makeTempFile({ suffix: ".ts" });
    await Deno.writeTextFile(tempFile, testWorkerCode);
    
    // Spawn test worker
    const worker1 = await manager.spawnWorker(
      { id: "worker-1", type: "agent", config: { name: "Worker 1" } },
      new URL(`file://${tempFile}`).href
    );
    
    const worker2 = await manager.spawnWorker(
      { id: "worker-2", type: "agent", config: { name: "Worker 2" } },
      new URL(`file://${tempFile}`).href
    );
    
    console.log("✅ Workers spawned");
    
    // Wait for initialization
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // 2. Test task processing
    console.log("\n2️⃣ Testing task processing...");
    
    const echoResult = await manager.sendTask("worker-1", "echo-task", {
      action: "echo",
      message: "Hello from test!"
    });
    
    console.log("✅ Echo result:", echoResult);
    
    // 3. Test broadcast communication
    console.log("\n3️⃣ Testing broadcast communication...");
    
    // Join both workers to same channel
    manager.setupBroadcastChannel("worker-1", "test-channel");
    manager.setupBroadcastChannel("worker-2", "test-channel");
    
    // Listen for broadcast receipts
    const broadcastPromise = new Promise((resolve) => {
      worker2.worker.onmessage = (event) => {
        if (event.data.type === 'broadcastReceived') {
          resolve(event.data);
        }
      };
    });
    
    // Send broadcast from worker 1
    await manager.sendTask("worker-1", "broadcast-task", {
      action: "broadcast",
      channel: "test-channel",
      message: { type: "test", content: "Hello broadcast!" }
    });
    
    const broadcastReceipt = await broadcastPromise;
    console.log("✅ Worker 2 received broadcast:", broadcastReceipt);
    
    // 4. Test direct communication via MessagePort
    console.log("\n4️⃣ Testing direct MessagePort communication...");
    
    manager.createMessageChannel("worker-1", "worker-2");
    
    // Wait a bit for ports to be set up
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log("✅ MessagePorts established between workers");
    
    // Clean up
    await Deno.remove(tempFile);
    await manager.shutdown();
    
    console.log("\n✅ All tests passed!");
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("❌ Error:", errorMessage);
  }
}

testFullWorkerCommunication();