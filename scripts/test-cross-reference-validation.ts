#!/usr/bin/env -S deno run --allow-all

/**
 * Test cross-reference validation for signal/job relationships
 */

import { WorkspaceConfigSchema } from "@atlas/config";
import { validateCrossReferences } from "../src/core/services/workspace-conversation-helpers.ts";

console.log("🧪 Testing Cross-Reference Validation\n");

// Test configurations
const testConfigs = [
  {
    name: "Valid References",
    config: {
      version: "1.0",
      workspace: {
        name: "test-workspace",
        description: "Test workspace with valid references",
      },
      agents: {
        "agent1": {
          type: "llm",
          model: "claude-3-5-haiku-20241022",
          purpose: "Test agent",
        },
      },
      signals: {
        "test-trigger": {
          description: "Test trigger",
          provider: "atlas",
        },
      },
      jobs: {
        "test-job": {
          description: "Test job",
          triggers: [{ signal: "test-trigger" }],
          execution: {
            strategy: "sequential",
            agents: ["agent1"],
          },
        },
      },
    },
  },
  {
    name: "Invalid Signal Reference (elizabethan example)",
    config: {
      version: "1.0",
      workspace: {
        name: "elizabethan-sonnet-generator",
        description: "Transforms messages into sonnets",
      },
      agents: {
        "sonnet-composer": {
          type: "llm",
          model: "claude-3-5-sonnet-20241022",
          purpose: "Compose sonnets",
        },
      },
      signals: {
        "elizabethan-sonnet-generator-trigger": {
          description: "Trigger sonnet generation",
          provider: "atlas",
        },
      },
      jobs: {
        "create-sonnet": {
          description: "Create a sonnet",
          triggers: [{ signal: "sonnet-trigger" }], // WRONG - should be elizabethan-sonnet-generator-trigger
          execution: {
            strategy: "sequential",
            agents: ["sonnet-composer"],
          },
        },
      },
    },
  },
  {
    name: "Invalid Agent Reference",
    config: {
      version: "1.0",
      workspace: {
        name: "test-workspace",
      },
      agents: {
        "analyzer": {
          type: "llm",
          model: "claude-3-5-haiku-20241022",
          purpose: "Analyze data",
        },
      },
      signals: {
        "trigger": {
          description: "Trigger",
          provider: "atlas",
        },
      },
      jobs: {
        "process": {
          description: "Process data",
          triggers: [{ signal: "trigger" }],
          execution: {
            strategy: "sequential",
            agents: ["processor", "analyzer"], // processor doesn't exist
          },
        },
      },
    },
  },
];

// Test each configuration
for (const test of testConfigs) {
  console.log(`\n📋 Test: ${test.name}`);
  console.log("─".repeat(50));

  // Schema validation
  const schemaResult = WorkspaceConfigSchema.safeParse(test.config);
  const schemaValid = schemaResult.success;

  // Cross-reference validation
  const crossRefErrors = validateCrossReferences(test.config);
  const crossRefValid = crossRefErrors.length === 0;

  // Overall validation
  const isValid = schemaValid && crossRefValid;

  if (isValid) {
    console.log("✅ Configuration is VALID");
    console.log("   - Schema: ✅ Valid");
    console.log("   - Cross-references: ✅ All references valid");
  } else {
    console.log("❌ Configuration is INVALID");
    console.log(`   - Schema: ${schemaValid ? "✅ Valid" : "❌ Invalid"}`);
    console.log(`   - Cross-references: ${crossRefValid ? "✅ Valid" : "❌ Invalid"}`);

    if (crossRefErrors.length > 0) {
      console.log("\n📍 Cross-Reference Errors:");
      crossRefErrors.forEach((error) => console.log(`   • ${error}`));
    }

    if (!schemaValid) {
      console.log("\n📍 Schema Errors:");
      schemaResult.error?.issues.forEach((issue) => {
        console.log(`   • ${issue.path.join(".")}: ${issue.message}`);
      });
    }
  }
}

console.log("\n\n🎯 Key Takeaways:");
console.log("─".repeat(50));
console.log("1. Job triggers must reference existing signal names exactly");
console.log("2. Job agents must reference existing agent IDs");
console.log("3. The elizabethan example shows the exact error we're preventing");
console.log("4. Cross-reference validation catches these errors before publishing");
