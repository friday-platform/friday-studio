#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env --unstable-broadcast-channel --unstable-worker-options

/**
 * Minimal test to verify our integration works
 */

console.log("🧪 Running minimal integration test...\n");

// Test 1: Basic worker communication
console.log("1️⃣ Testing basic worker...");
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

worker.onmessage = (e) => {
  console.log("[Main] Received:", e.data);
  if (e.data.type === "ready") {
    worker.postMessage({ type: "ping" });
  } else if (e.data.type === "pong") {
    console.log("✅ Basic worker communication works!");
    worker.terminate();
    runWorkspaceTest();
  }
};

// Test 2: Workspace flow without workers
async function runWorkspaceTest() {
  console.log("\n2️⃣ Testing workspace flow without workers...");

  const { Workspace } = await import("../../src/core/workspace.ts");
  const { Session } = await import("../../src/core/session.ts");

  // Create workspace
  const workspace = new Workspace({
    id: "test",
    name: "Test User",
    role: "owner" as any,
  });
  console.log("✅ Workspace created:", workspace.id);

  // Create session
  const session = new Session(workspace.id, {
    triggers: [],
    callback: async (result) => console.log("Session callback:", result),
  });
  console.log("✅ Session created:", session.id);
  console.log("   Status:", session.status);

  console.log("\n✨ Basic integration tests passed!");
  console.log(
    "\n⚠️  The worker FSM initialization appears to be stuck - this needs investigation",
  );
  Deno.exit(0);
}

worker.onerror = (e) => {
  console.error("Worker error:", e);
};
