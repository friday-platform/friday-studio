#!/usr/bin/env -S deno run --allow-all

/**
 * Test script for workspace configuration validation
 * Demonstrates how validation would work in the conversation supervisor
 */

import { formatZodError, WorkspaceConfigSchema } from "@atlas/config";

// Test configurations
const testConfigs = [
  {
    name: "Valid Configuration",
    config: {
      version: "1.0",
      workspace: {
        name: "test-workspace",
        description: "A valid test workspace",
      },
      agents: {
        "analyzer": {
          type: "llm",
          model: "claude-3-5-haiku-20241022",
          purpose: "Analyze data",
        },
      },
      jobs: {
        "analyze_data": {
          description: "Analyze incoming data",
          execution: {
            strategy: "sequential",
            agents: ["analyzer"],
          },
        },
      },
    },
  },
  {
    name: "Invalid Model",
    config: {
      version: "1.0",
      workspace: {
        name: "test-workspace",
        description: "Workspace with invalid model",
      },
      agents: {
        "analyzer": {
          type: "llm",
          model: "claude-3-invalid-model", // Invalid model
          purpose: "Analyze data",
        },
      },
    },
  },
  {
    name: "Invalid Job Name (with dots)",
    config: {
      version: "1.0",
      workspace: {
        name: "test-workspace",
        description: "Workspace with invalid job name",
      },
      jobs: {
        "analyze.data": { // Dots not allowed in MCP tool names
          description: "Analyze incoming data",
          execution: {
            strategy: "sequential",
            agents: ["analyzer"],
          },
        },
      },
    },
  },
  {
    name: "Remote Agent Missing Endpoint",
    config: {
      version: "1.0",
      workspace: {
        name: "test-workspace",
        description: "Remote agent without endpoint",
      },
      agents: {
        "remote-agent": {
          type: "remote",
          purpose: "Remote processing",
          protocol: "acp",
          // Missing required endpoint field
        },
      },
    },
  },
];

// Simulate the validation function that would be in the daemon
function validateWorkspaceConfig(config: any): {
  valid: boolean;
  errors?: any[];
  formattedError?: string;
  data?: any;
} {
  const validationResult = WorkspaceConfigSchema.safeParse(config);

  if (validationResult.success) {
    return {
      valid: true,
      data: validationResult.data,
    };
  } else {
    return {
      valid: false,
      errors: validationResult.error.issues,
      formattedError: formatZodError(validationResult.error, "workspace.yml"),
    };
  }
}

// Generate fix suggestions based on validation errors
function generateFixSuggestions(errors: any[]): string[] {
  const suggestions: string[] = [];

  for (const error of errors) {
    const path = error.path?.join(".");

    if (error.code === "invalid_type") {
      suggestions.push(
        `✏️  Fix type at ${path}: expected ${error.expected}, got ${error.received}`,
      );
    } else if (error.code === "unrecognized_keys") {
      suggestions.push(`🗑️  Remove unrecognized fields: ${error.keys?.join(", ")}`);
    } else if (error.code === "custom") {
      if (path?.includes("model")) {
        suggestions.push(`🤖 Use a supported model from the error message list`);
      } else if (error.message?.includes("MCP tool names")) {
        suggestions.push(
          `📝 Rename to follow MCP rules: start with letter, use only letters/numbers/underscores/hyphens (no dots)`,
        );
      } else if (error.message?.includes("Remote agents require")) {
        suggestions.push(`🔧 Add missing required field: ${error.message}`);
      } else {
        suggestions.push(`⚠️  ${error.message}`);
      }
    }
  }

  return suggestions;
}

// Run tests
console.log("🧪 Testing Workspace Configuration Validation\n");

for (const test of testConfigs) {
  console.log(`\n📋 Test: ${test.name}`);
  console.log("─".repeat(50));

  const result = validateWorkspaceConfig(test.config);

  if (result.valid) {
    console.log("✅ Configuration is VALID");
    console.log("   Ready to publish!");
  } else {
    console.log("❌ Configuration is INVALID");
    console.log("\n📍 Validation Errors:");

    if (result.formattedError) {
      console.log(result.formattedError);
    }

    const suggestions = generateFixSuggestions(result.errors || []);
    if (suggestions.length > 0) {
      console.log("\n💡 Fix Suggestions:");
      suggestions.forEach((s) => console.log(`   ${s}`));
    }
  }
}

console.log("\n\n🎯 Summary:");
console.log("─".repeat(50));
console.log("This demonstrates how workspace validation would work:");
console.log("1. Configurations are validated against WorkspaceConfigSchema");
console.log("2. Clear error messages are provided for invalid configs");
console.log("3. Specific fix suggestions guide users to correct issues");
console.log("4. Validation happens before publishing to prevent failures");
