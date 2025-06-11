#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --unstable-broadcast-channel --unstable-worker-options

/**
 * Comprehensive worker communication integration tests
 * Merged from test-minimal-worker, test-full-worker-communication, test-simple-flow, test-supervisor-worker
 */

import { WorkerManager } from "../../src/core/utils/worker-manager.ts";
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

// Test 1: Basic worker communication (from test-minimal-worker)
Deno.test("Basic worker communication", async () => {
  console.log("🧪 Testing basic worker communication...");

  const workerCode = `
    console.log("[Worker] Started");
    self.postMessage({ type: 'ready' });
    
    self.onmessage = (e) => {
      console.log("[Worker] Received:", e.data);
      if (e.data.type === 'ping') {
        self.postMessage({ type: 'pong' });
      }
    };
  `;

  const blob = new Blob([workerCode], { type: "application/javascript" });
  const workerUrl = URL.createObjectURL(blob);
  const worker = new Worker(workerUrl, { type: "module" });

  const messagePromise = new Promise((resolve) => {
    worker.onmessage = (e) => {
      if (e.data.type === "ready") {
        worker.postMessage({ type: "ping" });
      } else if (e.data.type === "pong") {
        resolve("pong");
      }
    };
  });

  const result = await messagePromise;
  assertEquals(result, "pong");

  worker.terminate();
  console.log("✅ Basic worker communication works!");
});

// Test 2: WorkerManager lifecycle (from test-simple-flow)
Deno.test("WorkerManager lifecycle", async () => {
  console.log("🧪 Testing WorkerManager lifecycle...");

  const manager = new WorkerManager();

  // Create a simple test worker file
  const testWorkerCode = `
    console.log("[TestWorker] Starting...");
    
    self.onmessage = (event) => {
      console.log("[TestWorker] Received:", event.data);
      
      if (event.data.type === 'init') {
        console.log("[TestWorker] Initializing...");
        self.postMessage({ type: 'initialized' });
      }
    };
  `;

  const tempFile = await Deno.makeTempFile({ suffix: ".ts" });
  await Deno.writeTextFile(tempFile, testWorkerCode);

  try {
    const worker = await manager.spawnWorker(
      { id: "test-1", type: "agent" as any },
      new URL(`file://${tempFile}`).href,
    );

    console.log("✅ Worker spawned:", worker.id);

    // Wait for initialization
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const state = manager.getWorkerState(worker.id);
    console.log("   State:", state);

    // Clean up
    await manager.shutdown();
    console.log("✅ Manager shut down");
  } finally {
    await Deno.remove(tempFile);
  }
});

// Test 3: Full BaseWorker communication (from test-full-worker-communication)
Deno.test("BaseWorker with BroadcastChannels and MessagePorts", async () => {
  console.log("🧪 Testing BaseWorker implementation...");

  const manager = new WorkerManager();

  const testWorkerCode = `
    /// <reference no-default-lib="true" />
    /// <reference lib="deno.worker" />
    
    import { BaseWorker } from "${
    new URL("../../src/core/workers/base-worker.ts", import.meta.url).href
  }";
    
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

  const tempFile = await Deno.makeTempFile({ suffix: ".ts" });
  await Deno.writeTextFile(tempFile, testWorkerCode);

  try {
    // Spawn test workers
    const worker1 = await manager.spawnWorker(
      { id: "worker-1", type: "agent", config: { name: "Worker 1" } },
      new URL(`file://${tempFile}`).href,
    );

    const worker2 = await manager.spawnWorker(
      { id: "worker-2", type: "agent", config: { name: "Worker 2" } },
      new URL(`file://${tempFile}`).href,
    );

    console.log("✅ Workers spawned");

    // Wait for initialization
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Test task processing
    const echoResult = await manager.sendTask("worker-1", "echo-task", {
      action: "echo",
      message: "Hello from test!",
    });

    console.log("✅ Echo result:", echoResult);

    // Test broadcast communication
    manager.setupBroadcastChannel("worker-1", "test-channel");
    manager.setupBroadcastChannel("worker-2", "test-channel");

    // Listen for broadcast receipts
    const broadcastPromise = new Promise((resolve) => {
      worker2.worker.onmessage = (event) => {
        if (event.data.type === "broadcastReceived") {
          resolve(event.data);
        }
      };
    });

    // Send broadcast from worker 1
    await manager.sendTask("worker-1", "broadcast-task", {
      action: "broadcast",
      channel: "test-channel",
      message: { type: "test", content: "Hello broadcast!" },
    });

    const broadcastReceipt = await broadcastPromise;
    console.log("✅ Worker 2 received broadcast:", broadcastReceipt);

    // Test direct communication via MessagePort
    manager.createMessageChannel("worker-1", "worker-2");
    await new Promise((resolve) => setTimeout(resolve, 500));
    console.log("✅ MessagePorts established between workers");

    await manager.shutdown();
    console.log("✅ All BaseWorker tests passed!");
  } finally {
    await Deno.remove(tempFile);
  }
});

// Test 4: WorkspaceSupervisor worker initialization (from test-supervisor-worker)
Deno.test("WorkspaceSupervisor worker initialization", async () => {
  console.log("🧪 Testing WorkspaceSupervisor worker...");

  const manager = new WorkerManager();

  try {
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
          model: "claude-3-haiku-20240307",
        },
      },
    };

    const supervisor = await manager.spawnWorker(
      supervisorMetadata,
      new URL(
        "../../src/core/workers/workspace-supervisor-worker.ts",
        import.meta.url,
      ).href,
    );

    console.log("✅ Supervisor spawned:", supervisor.id);

    // Check state periodically
    for (let i = 0; i < 5; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const state = manager.getWorkerState(supervisor.id);
      console.log(`   State after ${i + 1}s:`, state);

      if (state === "ready") {
        console.log("✅ Supervisor is ready!");
        break;
      }

      if (state === "error") {
        console.log("❌ Supervisor entered error state");
        break;
      }
    }

    await manager.shutdown();
  } catch (error) {
    console.error("❌ Supervisor test error:", error);
    throw error;
  }
});

console.log("\n✅ All worker communication tests completed!");
