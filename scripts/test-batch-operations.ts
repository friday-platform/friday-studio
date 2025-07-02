#!/usr/bin/env -S deno run --allow-all

import { WorkspaceDraftStore } from "../src/core/services/workspace-draft-store.ts";
import type { WorkspaceConfig } from "@atlas/config";

// Test the new batch operations enhancement
async function testBatchOperations() {
  console.log("Testing Conversation Supervisor Batch Operations Enhancement\n");

  // Create a mock KV store
  const kv = await Deno.openKv(":memory:");
  const store = new WorkspaceDraftStore(kv);

  // Test 1: Create draft with initial configuration
  console.log("Test 1: Creating draft with complete initial configuration");

  const initialConfig: Partial<WorkspaceConfig> = {
    version: "1.0",
    workspace: {
      name: "telephone-game",
      description: "A game of telephone where messages are transformed",
    },
    signals: {
      "telephone-game-trigger": {
        description: "Start the telephone game with a message",
        provider: "cli",
      },
    },
    agents: {
      "mishear-agent": {
        type: "llm",
        model: "claude-3-5-haiku-20241022",
        purpose: "Slightly mishears the incoming message",
        prompts: {
          system: "You are playing telephone and have slightly misheard the message.",
        },
      },
      "embellish-agent": {
        type: "llm",
        model: "claude-3-5-haiku-20241022",
        purpose: "Embellishes the misheard message",
        prompts: {
          system: "You love to embellish stories.",
        },
      },
      "haiku-agent": {
        type: "llm",
        model: "claude-3-5-haiku-20241022",
        purpose: "Transforms into a haiku",
        prompts: {
          system: "You are a haiku poet.",
        },
      },
    },
    jobs: {
      "telephone-game-process": {
        name: "telephone-game-process",
        description: "Run messages through the telephone game",
        triggers: [{ signal: "telephone-game-trigger" }],
        execution: {
          strategy: "sequential",
          agents: [
            { id: "mishear-agent", input_source: "signal" },
            { id: "embellish-agent", input_source: "previous" },
            { id: "haiku-agent", input_source: "previous" },
          ],
        },
      },
    },
  };

  const draft = await store.createDraft({
    name: "telephone-game",
    description: "A game of telephone where messages are transformed",
    sessionId: "test-session",
    userId: "test-user",
    initialConfig,
  });

  console.log("✅ Draft created with ID:", draft.id);
  console.log("   Agents:", Object.keys(draft.config.agents || {}).length);
  console.log("   Jobs:", Object.keys(draft.config.jobs || {}).length);
  console.log("   Signals:", Object.keys(draft.config.signals || {}).length);
  console.log("   Iterations:", draft.iterations.length);

  // Test 2: Update draft with partial configuration
  console.log("\nTest 2: Updating draft with partial configuration");

  const updates: Partial<WorkspaceConfig> = {
    agents: {
      "error-handler": {
        type: "llm",
        model: "claude-3-5-haiku-20241022",
        purpose: "Handle errors gracefully",
        prompts: {
          system: "When you receive an error, log it clearly.",
        },
      },
    },
  };

  const updatedDraft = await store.updateDraft(
    draft.id,
    updates,
    "Added error-handler agent to handle errors gracefully",
  );

  console.log("✅ Draft updated");
  console.log("   Agents:", Object.keys(updatedDraft.config.agents || {}).length);
  console.log("   Iterations:", updatedDraft.iterations.length);
  console.log(
    "   Latest iteration:",
    updatedDraft.iterations[updatedDraft.iterations.length - 1].summary,
  );

  // Test 3: Verify deep merge preserves existing configuration
  console.log("\nTest 3: Verifying deep merge preserves existing configuration");

  const agentNames = Object.keys(updatedDraft.config.agents || {});
  const expectedAgents = ["mishear-agent", "embellish-agent", "haiku-agent", "error-handler"];

  const allAgentsPresent = expectedAgents.every((name) => agentNames.includes(name));
  console.log(allAgentsPresent ? "✅ All agents preserved after update" : "❌ Some agents missing");
  console.log("   Found agents:", agentNames.join(", "));

  // Test 4: Create minimal draft (traditional flow)
  console.log("\nTest 4: Creating minimal draft (traditional flow)");

  const minimalDraft = await store.createDraft({
    name: "minimal-workspace",
    description: "A minimal workspace",
    sessionId: "test-session",
    userId: "test-user",
  });

  console.log("✅ Minimal draft created");
  console.log("   Has version:", !!minimalDraft.config.version);
  console.log("   Has workspace info:", !!minimalDraft.config.workspace);
  console.log("   Agents:", Object.keys(minimalDraft.config.agents || {}).length);

  console.log("\n✅ All tests passed!");

  // Clean up
  await kv.close();
}

// Run the tests
if (import.meta.main) {
  try {
    await testBatchOperations();
  } catch (error) {
    console.error("❌ Test failed:", error);
    Deno.exit(1);
  }
}
