#!/usr/bin/env -S deno run --allow-read --allow-write

import { AtlasWorkspaceManager } from "../src/core/manager.ts";
import { EchoAgent } from "./agents/echo-agent.ts";
import { LLMAgent } from "./agents/llm-agent.ts";

async function streamingExample() {
  console.log("🌊 Atlas Streaming Example");
  console.log("==========================\n");

  // Create workspace
  const manager = new AtlasWorkspaceManager();
  const workspace = await manager.createWorkspace("streaming-test", "alice");
  console.log(`✓ Created workspace: ${workspace.id}\n`);

  // Create agents
  const echoAgent = new EchoAgent(workspace.id);
  const llmAgent = new LLMAgent({
    model: "gpt-4",
    temperature: 0.7,
  }, workspace.id);

  // Add agents to workspace
  workspace.addAgent(echoAgent);
  workspace.addAgent(llmAgent);

  console.log("🤖 Created agents:");
  console.log(`  - ${echoAgent.name()}: ${echoAgent.purpose()}`);
  console.log(`  - ${llmAgent.name()}: ${llmAgent.purpose()}\n`);

  // Test streaming with echo agent
  console.log("📡 Streaming with EchoAgent:");
  console.log("Input: 'Hello Atlas!'");
  console.log("Output: ");

  for await (const chunk of echoAgent.invokeStream("Hello Atlas!")) {
    await Deno.stdout.write(new TextEncoder().encode(chunk));
  }
  console.log("\n");

  // Test streaming with LLM agent
  console.log("📡 Streaming with LLMAgent:");
  console.log("Input: 'Help me deploy my code'");
  console.log("Output: ");

  for await (const chunk of llmAgent.invokeStream("Help me deploy my code")) {
    await Deno.stdout.write(new TextEncoder().encode(chunk));
  }
  console.log("\n");

  // Test non-streaming (should collect all chunks)
  console.log("📄 Non-streaming invoke:");
  const response = await echoAgent.invoke("Testing non-streaming mode");
  console.log(response);

  console.log("\n✨ Streaming example completed!");
}

if (import.meta.main) {
  await streamingExample();
}
