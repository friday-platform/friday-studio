#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --unstable-broadcast-channel --unstable-worker-options

/**
 * Test supervisor-mediated agent communication
 */

import { WorkerManager } from "../../src/core/utils/worker-manager.ts";

async function testSupervisorAgentCommunication() {
  console.log("🧪 Testing Supervisor-Mediated Agent Communication...\n");
  
  const manager = new WorkerManager();
  
  try {
    // 1. Spawn supervisor
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
      new URL("../../src/core/workers/supervisor-worker.ts", import.meta.url).href
    );
    
    console.log("✅ Supervisor spawned:", supervisor.id);
    
    // Wait for supervisor to be ready
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // 2. Process a signal (which should spawn a session)
    console.log("\n2️⃣ Processing signal to create session...");
    
    const taskId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    
    const resultPromise = manager.sendTask(supervisor.id, taskId, {
      action: 'processSignal',
      signal: {
        id: 'test-signal',
        provider: { id: 'test', name: 'Test Provider' }
      },
      payload: { message: "Hello agents!" },
      sessionId
    });
    
    const result = await resultPromise;
    console.log("✅ Session created:", result);
    
    // 3. Test broadcast channel communication
    console.log("\n3️⃣ Testing broadcast channel communication...");
    
    // Create our own broadcast channel to listen
    const sessionChannel = new BroadcastChannel(`session-${sessionId}`);
    const messages: any[] = [];
    
    sessionChannel.onmessage = (event) => {
      console.log("📡 Broadcast received:", event.data);
      messages.push(event.data);
    };
    
    // Simulate agent message broadcast
    setTimeout(() => {
      sessionChannel.postMessage({
        type: 'agentMessage',
        from: 'test-agent-1',
        message: 'Hello from agent 1!',
        timestamp: new Date().toISOString()
      });
    }, 500);
    
    setTimeout(() => {
      sessionChannel.postMessage({
        type: 'agentMessage',
        from: 'test-agent-2',
        message: 'Hello from agent 2!',
        timestamp: new Date().toISOString()
      });
    }, 1000);
    
    // Wait for messages
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log(`\n📊 Received ${messages.length} broadcast messages`);
    
    // 4. Get supervisor status
    console.log("\n4️⃣ Getting supervisor status...");
    
    const statusTaskId = crypto.randomUUID();
    const status = await manager.sendTask(supervisor.id, statusTaskId, {
      action: 'getStatus'
    });
    
    console.log("✅ Supervisor status:", status);
    
    // Clean up
    sessionChannel.close();
    await manager.shutdown();
    console.log("\n✅ Test completed successfully!");
    
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

testSupervisorAgentCommunication();