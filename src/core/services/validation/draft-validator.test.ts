/**
 * Tests for the AtlasDraftValidator reference validation system
 */

import { assertEquals, assertExists, assertGreater } from "@std/assert";
import { AtlasDraftValidator } from "./draft-validator.ts";
import type { ValidationContext } from "./types.ts";
import type { WorkspaceDraft } from "../workspace-draft-store.ts";

// Test utilities
function createMockDraft(config: any): WorkspaceDraft {
  return {
    id: "test-draft-id",
    name: "test-draft",
    description: "Test draft for validation",
    conversationId: "test-conversation",
    sessionId: "test-session",
    userId: "test-user",
    status: "draft",
    config,
    iterations: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function createValidationContext(draft: WorkspaceDraft): ValidationContext {
  return {
    draftId: draft.id,
    draft,
    config: draft.config,
    validateReferences: true,
    checkBestPractices: true,
    strictMode: false,
  };
}

Deno.test("AtlasDraftValidator - Reference Validation - Basic References", async () => {
  const validator = new AtlasDraftValidator();

  // Test configuration with valid references
  const validConfig = {
    version: "1.0",
    workspace: {
      name: "test-workspace",
      description: "Test workspace with valid references",
    },
    agents: {
      "agent-1": {
        type: "llm",
        model: "claude-3-5-haiku-latest",
        purpose: "Test agent",
        prompts: { system: "Test prompt" },
      },
      "agent-2": {
        type: "llm",
        model: "claude-3-5-haiku-latest",
        purpose: "Another test agent",
        prompts: { system: "Another test prompt" },
      },
    },
    signals: {
      "test-signal": {
        description: "Test signal",
        provider: "cli",
      },
    },
    jobs: {
      "test-job": {
        name: "test-job",
        description: "Test job",
        triggers: [{ signal: "test-signal" }],
        execution: {
          strategy: "sequential",
          agents: [
            { id: "agent-1", input_source: "signal" },
            { id: "agent-2", input_source: "previous" },
          ],
        },
      },
    },
  };

  const validDraft = createMockDraft(validConfig);
  const result = await validator.validateReferences(validDraft);

  assertEquals(result.valid, true, "Valid configuration should pass reference validation");
  assertEquals(result.brokenReferences.length, 0, "Should have no broken references");
  assertEquals(result.circularDependencies.length, 0, "Should have no circular dependencies");

  console.log("✅ Basic reference validation passed");
});

Deno.test("AtlasDraftValidator - Reference Validation - Broken References", async () => {
  const validator = new AtlasDraftValidator();

  // Test configuration with broken references
  const invalidConfig = {
    version: "1.0",
    workspace: {
      name: "test-workspace",
      description: "Test workspace with broken references",
    },
    agents: {
      "agent-1": {
        type: "llm",
        model: "claude-3-5-haiku-latest",
        purpose: "Test agent",
        prompts: { system: "Test prompt" },
      },
    },
    signals: {
      "test-signal": {
        description: "Test signal",
        provider: "cli",
      },
    },
    jobs: {
      "test-job": {
        name: "test-job",
        description: "Test job with broken references",
        triggers: [
          { signal: "test-signal" },
          { signal: "missing-signal" }, // Broken reference
        ],
        execution: {
          strategy: "sequential",
          agents: [
            { id: "agent-1", input_source: "signal" },
            { id: "missing-agent", input_source: "previous" }, // Broken reference
          ],
        },
      },
    },
  };

  const invalidDraft = createMockDraft(invalidConfig);
  const result = await validator.validateReferences(invalidDraft);

  assertEquals(result.valid, false, "Invalid configuration should fail reference validation");
  assertEquals(result.brokenReferences.length, 2, "Should have exactly 2 broken references");

  // Check broken signal reference
  const brokenSignalRef = result.brokenReferences.find((ref) => ref.toId === "missing-signal");
  assertExists(brokenSignalRef, "Should detect broken signal reference");
  assertEquals(brokenSignalRef.referenceType, "signal");
  assertEquals(brokenSignalRef.fromComponent, "test-job");

  // Check broken agent reference
  const brokenAgentRef = result.brokenReferences.find((ref) => ref.toId === "missing-agent");
  assertExists(brokenAgentRef, "Should detect broken agent reference");
  assertEquals(brokenAgentRef.referenceType, "agent");
  assertEquals(brokenAgentRef.fromComponent, "test-job");

  console.log("✅ Broken reference detection working correctly");
});

Deno.test("AtlasDraftValidator - Reference Validation - Orphaned Components", async () => {
  const validator = new AtlasDraftValidator();

  // Test configuration with orphaned components
  const configWithOrphans = {
    version: "1.0",
    workspace: {
      name: "test-workspace",
      description: "Test workspace with orphaned components",
    },
    agents: {
      "used-agent": {
        type: "llm",
        model: "claude-3-5-haiku-latest",
        purpose: "Used agent",
        prompts: { system: "Used prompt" },
      },
      "orphaned-agent": {
        type: "llm",
        model: "claude-3-5-haiku-latest",
        purpose: "Orphaned agent - never used",
        prompts: { system: "Orphaned prompt" },
      },
    },
    signals: {
      "used-signal": {
        description: "Used signal",
        provider: "cli",
      },
      "orphaned-signal": {
        description: "Orphaned signal - never used",
        provider: "cli",
      },
    },
    jobs: {
      "test-job": {
        name: "test-job",
        description: "Job that uses only some components",
        triggers: [{ signal: "used-signal" }],
        execution: {
          strategy: "sequential",
          agents: [{ id: "used-agent", input_source: "signal" }],
        },
      },
    },
  };

  const draftWithOrphans = createMockDraft(configWithOrphans);
  const result = await validator.validateReferences(draftWithOrphans);

  assertEquals(result.valid, true, "Orphaned components don't invalidate configuration");
  assertEquals(result.orphanedComponents.length, 2, "Should detect 2 orphaned components");

  // Check orphaned agent
  const orphanedAgent = result.orphanedComponents.find((comp) => comp.id === "orphaned-agent");
  assertExists(orphanedAgent, "Should detect orphaned agent");
  assertEquals(orphanedAgent.type, "agent");

  // Check orphaned signal
  const orphanedSignal = result.orphanedComponents.find((comp) => comp.id === "orphaned-signal");
  assertExists(orphanedSignal, "Should detect orphaned signal");
  assertEquals(orphanedSignal.type, "signal");

  console.log("✅ Orphaned component detection working correctly");
});

Deno.test("AtlasDraftValidator - Reference Validation - Missing Dependencies", async () => {
  const validator = new AtlasDraftValidator();

  // Test configuration with missing dependencies
  const configWithMissingDeps = {
    version: "1.0",
    workspace: {
      name: "test-workspace",
      description: "Test workspace with missing dependencies",
    },
    agents: {
      "weather-agent": {
        type: "llm",
        model: "claude-3-5-haiku-latest",
        purpose: "Fetch weather data using weather API",
        prompts: {
          system: "Use weather APIs to get current weather conditions and forecasts.",
        },
      },
      "email-agent": {
        type: "llm",
        model: "claude-3-5-haiku-latest",
        purpose: "Send email notifications",
        prompts: {
          system: "Send email notifications to users about important events.",
        },
      },
    },
    signals: {
      "weather-check": {
        description: "Weather check signal",
        provider: "schedule",
        schedule: "0 * * * *",
      },
    },
    jobs: {
      "weather-job": {
        name: "weather-job",
        description: "Weather monitoring job",
        triggers: [{ signal: "weather-check" }],
        execution: {
          strategy: "sequential",
          agents: [
            { id: "weather-agent", input_source: "signal" },
            { id: "email-agent", input_source: "previous" },
          ],
        },
      },
    },
    // Missing tools section - should trigger missing dependency detection
  };

  const draftWithMissingDeps = createMockDraft(configWithMissingDeps);
  const result = await validator.validateReferences(draftWithMissingDeps);

  assertEquals(result.valid, false, "Missing dependencies should invalidate configuration");
  assertGreater(result.missingDependencies.length, 0, "Should detect missing dependencies");

  // Should detect missing weather API tool
  const missingWeatherTool = result.missingDependencies.find(
    (dep) => dep.requiredId === "weather-api",
  );
  assertExists(missingWeatherTool, "Should detect missing weather API tool");
  assertEquals(missingWeatherTool.requiredType, "tool");

  // Should detect missing email service tool
  const missingEmailTool = result.missingDependencies.find(
    (dep) => dep.requiredId === "email-service",
  );
  assertExists(missingEmailTool, "Should detect missing email service tool");
  assertEquals(missingEmailTool.requiredType, "tool");

  console.log("✅ Missing dependency detection working correctly");
});

Deno.test("AtlasDraftValidator - Comprehensive Validation", async () => {
  const validator = new AtlasDraftValidator();

  // Test complete validation workflow
  const complexConfig = {
    version: "1.0",
    workspace: {
      name: "complex-workspace",
      description: "A complex workspace for comprehensive testing",
    },
    agents: {
      "github-parser": {
        type: "llm",
        description: "Parse GitHub webhook events",
        config: {
          provider: "anthropic",
          model: "claude-3-5-haiku-latest",
          prompt: "Parse GitHub webhook payloads and extract relevant information.",
        },
      },
      "notification-sender": {
        type: "llm",
        description: "Send Slack notifications about GitHub events",
        config: {
          provider: "anthropic",
          model: "claude-3-5-haiku-latest",
          prompt: "Send appropriate Slack notifications for GitHub events.",
        },
      },
    },
    signals: {
      "github-webhook": {
        description: "GitHub webhook events",
        provider: "http",
        config: {
          path: "/webhook/github",
        },
      },
    },
    jobs: {
      "process-github-event": {
        name: "process-github-event",
        description: "Process incoming GitHub events",
        triggers: [{ signal: "github-webhook" }],
        execution: {
          strategy: "sequential",
          agents: [
            { id: "github-parser", context: { signal: true } },
            { id: "notification-sender", context: { steps: "previous" } },
          ],
        },
      },
    },
    tools: {
      mcp: {
        servers: {
          "github-api": {
            transport: {
              type: "stdio",
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-github"],
            },
          },
          "slack-integration": {
            transport: {
              type: "stdio",
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-slack"],
            },
          },
        },
      },
    },
  };

  const complexDraft = createMockDraft(complexConfig);
  const context = createValidationContext(complexDraft);

  const result = await validator.validateDraft(context);

  console.log(`Debug - Valid: ${result.valid}, Errors: ${result.errors.length}`);
  if (result.errors.length > 0) {
    console.log("Errors:", result.errors.map((e) => `${e.code}: ${e.message}`));
  }

  assertEquals(result.valid, true, "Complex valid configuration should pass validation");
  assertEquals(result.errors.length, 0, "Should have no validation errors");
  assertEquals(result.publishable, true, "Should be publishable");
  assertGreater(result.completionScore, 70, "Should have high completion score");
  assertEquals(result.quality.readiness, "production-ready", "Should be production-ready for use");

  console.log(`✅ Comprehensive validation passed with ${result.completionScore}% completion`);
  console.log(`   Quality score: ${result.quality.score}/100`);
  console.log(`   Readiness: ${result.quality.readiness}`);
});
