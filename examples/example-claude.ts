#!/usr/bin/env -S deno run --allow-read --allow-write --allow-net --allow-env

import { AtlasWorkspaceManager } from "../src/core/manager.ts";
import { ClaudeAgent } from "./agents/claude-agent.ts";

async function claudeExample() {
  console.log("🧠 Atlas + Claude Example");
  console.log("==========================\n");

  // Create workspace
  const manager = new AtlasWorkspaceManager();
  const workspace = await manager.createWorkspace("claude-test", "developer");
  console.log(`✓ Created workspace: ${workspace.id}\n`);

  // Create Claude agent (using Haiku for speed/cost)
  const claude = new ClaudeAgent("claude-3-haiku-20240307", workspace.id);

  // Add agent to workspace
  workspace.addAgent(claude);

  console.log("🤖 Created Claude agent:");
  console.log(`  - ${claude.name()}: ${claude.purpose()}\n`);

  // Test streaming with real Claude
  console.log("📡 Streaming with Claude:");
  console.log("Input: 'Help me write a simple TypeScript function that validates email addresses'");
  console.log("Output: ");
  
  for await (const chunk of claude.invokeStream("Help me write a simple TypeScript function that validates email addresses")) {
    await Deno.stdout.write(new TextEncoder().encode(chunk));
  }
  console.log("\n\n");

  // Test another query
  console.log("📡 Another Claude query:");
  console.log("Input: 'What are the key principles of good software deployment?'");
  console.log("Output: ");
  
  for await (const chunk of claude.invokeStream("What are the key principles of good software deployment?")) {
    await Deno.stdout.write(new TextEncoder().encode(chunk));
  }
  console.log("\n\n");

  // Test non-streaming
  console.log("📄 Non-streaming Claude:");
  const response = await claude.invoke("Explain what Atlas agent orchestration is in one sentence.");
  console.log(response);

  console.log("\n✨ Claude example completed!");
}

if (import.meta.main) {
  await claudeExample();
}