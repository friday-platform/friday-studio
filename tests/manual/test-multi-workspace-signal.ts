#!/usr/bin/env -S deno run --allow-all

/**
 * Manual test for multi-workspace signal triggering
 * This creates actual workspaces and tests the signal trigger functionality
 */

import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { WorkspaceRegistryManager } from "../../src/core/workspace-registry.ts";

async function createTestWorkspace(baseDir: string, name: string, port: number) {
  const wsDir = join(baseDir, name);
  await ensureDir(wsDir);

  // Create workspace.yml
  const workspaceYaml = `version: "1.0"

workspace:
  id: "${crypto.randomUUID()}"
  name: "${name}"
  description: "Test workspace for multi-workspace signal testing"

signals:
  test-signal:
    description: "Test signal"
    provider: "http"
    path: "/test-signal"
    method: "POST"
  deploy:
    description: "Deploy signal"
    provider: "http"
    path: "/deploy"
    method: "POST"

jobs:
  test-job:
    name: "test-job"
    description: "Test job"
    triggers:
      - signal: "test-signal"
      - signal: "deploy"
    execution:
      strategy: "sequential"
      agents:
        - id: "test-agent"

agents:
  test-agent:
    type: "llm"
    model: "claude-3-5-haiku-20241022"
    purpose: "Test agent"
`;

  await Deno.writeTextFile(join(wsDir, "workspace.yml"), workspaceYaml);

  // Create atlas.yml
  const atlasYaml = `supervisors:
  workspace:
    model: claude-3-5-sonnet-20241022
  session:
    model: claude-3-5-sonnet-20241022
`;

  await Deno.writeTextFile(join(wsDir, "atlas.yml"), atlasYaml);

  // Start a mock HTTP server for this workspace
  const server = Deno.serve({
    port,
    onListen: () => console.log(`Mock workspace '${name}' listening on port ${port}`),
  }, (req) => {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/signals/") && req.method === "POST") {
      const signalName = url.pathname.split("/")[2];
      console.log(`[${name}] Received signal: ${signalName}`);
      return new Response(
        JSON.stringify({ sessionId: `session-${crypto.randomUUID()}` }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response("Not Found", { status: 404 });
  });

  return { wsDir, server };
}

async function main() {
  console.log("🧪 Manual test for multi-workspace signal triggering\n");

  // Create test directory
  const testDir = await Deno.makeTempDir({ prefix: "atlas-multi-ws-test-" });
  console.log(`Test directory: ${testDir}`);

  // Set up test registry
  const originalHome = Deno.env.get("HOME");
  Deno.env.set("HOME", testDir);
  Deno.env.set("DENO_TEST", "true");

  const registry = new WorkspaceRegistryManager();
  await registry.initialize();

  try {
    // Create and start test workspaces
    console.log("\n📁 Creating test workspaces...");
    const ws1 = await createTestWorkspace(testDir, "prod-api", 9091);
    const ws2 = await createTestWorkspace(testDir, "prod-web", 9092);
    const ws3 = await createTestWorkspace(testDir, "dev-api", 9093);

    // Register workspaces
    console.log("\n📝 Registering workspaces...");
    const entry1 = await registry.register(ws1.wsDir, { name: "prod-api" });
    const entry2 = await registry.register(ws2.wsDir, { name: "prod-web" });
    const entry3 = await registry.register(ws3.wsDir, { name: "dev-api" });

    // Update to running status
    await registry.updateStatus(entry1.id, "running", { port: 9091, pid: Deno.pid });
    await registry.updateStatus(entry2.id, "running", { port: 9092, pid: Deno.pid });
    await registry.updateStatus(entry3.id, "running", { port: 9093, pid: Deno.pid });

    // List running workspaces
    const running = await registry.getRunning();
    console.log(`\n✅ Running workspaces: ${running.length}`);
    running.forEach((ws) => {
      console.log(`   - ${ws.name} (${ws.id}) on port ${ws.port}`);
    });

    // Test signal triggering
    console.log("\n🚀 Testing signal triggers...\n");

    // Test 1: Trigger on all workspaces
    console.log("Test 1: Triggering 'test-signal' on all workspaces");
    console.log("Run: atlas signal trigger test-signal --all\n");

    // Test 2: Trigger on specific workspaces
    console.log("Test 2: Triggering 'deploy' on prod workspaces only");
    console.log("Run: atlas signal trigger deploy --workspace prod-api,prod-web\n");

    // Test 3: Trigger with exclusion
    console.log("Test 3: Triggering 'test-signal' on all except dev");
    console.log("Run: atlas signal trigger test-signal --all --exclude dev-api\n");

    console.log("Press Ctrl+C to stop the test servers and cleanup...");

    // Keep servers running
    await new Promise(() => {});
  } finally {
    // Cleanup
    if (originalHome) {
      Deno.env.set("HOME", originalHome);
    }
    Deno.env.delete("DENO_TEST");
    await Deno.remove(testDir, { recursive: true });
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
