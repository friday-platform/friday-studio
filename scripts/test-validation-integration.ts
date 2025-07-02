#!/usr/bin/env -S deno run --allow-all

/**
 * Test the validation integration by simulating conversation supervisor actions
 */

import { AtlasDaemon } from "../apps/atlasd/src/atlas-daemon.ts";
import { WorkspaceConfigSchema } from "@atlas/config";

console.log("🧪 Testing Workspace Validation Integration\n");

// Start daemon in background
const daemon = new AtlasDaemon({ port: 8082 });
const { finished } = await daemon.startNonBlocking();

// Wait a moment for daemon to fully start
await new Promise((resolve) => setTimeout(resolve, 1000));

const daemonUrl = "http://localhost:8082";

// Test configurations to validate
const testConfigs = [
  {
    name: "Valid minimal config",
    config: {
      version: "1.0",
      workspace: {
        name: "test-workspace",
        description: "A test workspace",
      },
    },
  },
  {
    name: "Invalid agent model",
    config: {
      version: "1.0",
      workspace: {
        name: "test-workspace",
        description: "Workspace with invalid model",
      },
      agents: {
        "analyzer": {
          type: "llm",
          model: "gpt-invalid-model",
          provider: "openai",
          purpose: "Analyze data",
        },
      },
    },
  },
  {
    name: "Invalid job name with dots",
    config: {
      version: "1.0",
      workspace: {
        name: "test-workspace",
      },
      jobs: {
        "process.data": {
          description: "Process incoming data",
          execution: {
            strategy: "sequential",
            agents: ["agent1"],
          },
        },
      },
    },
  },
];

// Test validation endpoint
for (const test of testConfigs) {
  console.log(`\n📋 Testing: ${test.name}`);
  console.log("─".repeat(50));

  try {
    const response = await fetch(`${daemonUrl}/api/workspaces/validate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ config: test.config }),
    });

    if (!response.ok) {
      console.error(`❌ Request failed: ${response.status} ${response.statusText}`);
      continue;
    }

    const result = await response.json();

    if (result.valid) {
      console.log("✅ Configuration is VALID");
    } else {
      console.log("❌ Configuration is INVALID");
      if (result.formattedError) {
        console.log("\n📍 Validation Error:");
        console.log(result.formattedError);
      }
    }
  } catch (error) {
    console.error("Error calling validation endpoint:", error);
  }
}

// Test a complete draft workflow simulation
console.log("\n\n🔄 Simulating Draft Workflow with Validation");
console.log("─".repeat(50));

// Create a draft with invalid config
const draftConfig = {
  version: "1.0",
  workspace: {
    name: "telephone-game",
    description: "A telephone game workspace",
  },
  agents: {
    "listener": {
      type: "llm",
      model: "claude-3-invalid", // Invalid model
      purpose: "Listen and mishear",
    },
  },
  jobs: {
    "play.game": { // Invalid job name with dot
      description: "Play the game",
      execution: {
        strategy: "sequential",
        agents: ["listener"],
      },
    },
  },
};

console.log("\n1️⃣ Validating draft configuration...");
const validateResponse = await fetch(`${daemonUrl}/api/workspaces/validate`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ config: draftConfig }),
});

const validateResult = await validateResponse.json();
if (!validateResult.valid) {
  console.log("❌ Validation failed (as expected)");
  console.log("\n📍 Errors found:");
  if (validateResult.formattedError) {
    console.log(validateResult.formattedError);
  }

  console.log("\n2️⃣ Fixing configuration based on errors...");

  // Fix the configuration
  draftConfig.agents.listener.model = "claude-3-5-haiku-20241022";
  draftConfig.jobs = {
    "play_game": { // Fixed: no dots
      description: "Play the game",
      execution: {
        strategy: "sequential",
        agents: ["listener"],
      },
    },
  };

  console.log("\n3️⃣ Re-validating fixed configuration...");
  const revalidateResponse = await fetch(`${daemonUrl}/api/workspaces/validate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ config: draftConfig }),
  });

  const revalidateResult = await revalidateResponse.json();
  if (revalidateResult.valid) {
    console.log("✅ Configuration is now VALID!");
    console.log("   Ready to publish!");
  }
}

// Cleanup
console.log("\n\n🧹 Shutting down test daemon...");
await fetch(`${daemonUrl}/api/daemon/shutdown`, { method: "POST" });
await finished;

console.log("\n✨ Validation integration test complete!");
