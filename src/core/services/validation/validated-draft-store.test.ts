/**
 * Tests for ValidatedDraftStore integration
 */

import { assertEquals, assertExists, assertGreater } from "@std/assert";
import { ValidatedDraftStore } from "./validated-draft-store.ts";

// Test utilities
async function createTestValidatedStore(): Promise<{ store: ValidatedDraftStore; kv: Deno.Kv }> {
  const kv = await Deno.openKv(":memory:");
  const store = new ValidatedDraftStore(kv, {
    enableValidation: true,
    strictMode: false,
    checkBestPractices: true,
    validateReferences: true,
  });
  return { store, kv };
}

async function cleanup(kv: Deno.Kv) {
  try {
    kv.close();
  } catch {
    // Ignore cleanup errors
  }
}

Deno.test("ValidatedDraftStore - Create Draft with Validation", async () => {
  const { store, kv } = await createTestValidatedStore();

  try {
    // Create a draft with good configuration
    const result = await store.createValidatedDraft({
      name: "validated-test-workspace",
      description: "A test workspace with validation",
      sessionId: "test-session",
      conversationId: "test-conversation",
      userId: "test-user",
      initialConfig: {
        version: "1.0",
        workspace: {
          name: "validated-test-workspace",
          description: "A test workspace with validation",
        },
        agents: {
          "test-agent": {
            type: "llm",
            description: "Test agent with proper validation",
            config: {
              provider: "anthropic",
              model: "claude-3-5-haiku-latest",
              prompt: "Test system prompt for validation",
            },
          },
        },
        signals: {
          "test-signal": {
            description: "Test signal for validation",
            provider: "system",
          },
        },
        jobs: {
          "test-job": {
            name: "test-job",
            description: "Test job for validation",
            triggers: [{ signal: "test-signal" }],
            execution: {
              strategy: "sequential",
              agents: [{ id: "test-agent", context: { signal: true } }],
            },
          },
        },
      },
    });

    assertExists(result.draft, "Should create draft");
    assertExists(result.validation, "Should provide validation results");

    assertEquals(result.validation.valid, true, "Configuration should be valid");
    assertEquals(result.validation.errors.length, 0, "Should have no validation errors");
    assertGreater(result.validation.completionScore, 80, "Should have high completion score");

    console.log(`✅ Draft created with ${result.validation.completionScore}% completion`);
  } finally {
    await cleanup(kv);
  }
});

Deno.test("ValidatedDraftStore - Update Draft with Validation", async () => {
  const { store, kv } = await createTestValidatedStore();

  try {
    // Create initial draft
    const initial = await store.createValidatedDraft({
      name: "update-test-workspace",
      description: "A test workspace for update validation",
      sessionId: "test-session",
      conversationId: "test-conversation",
      userId: "test-user",
      initialConfig: {
        version: "1.0",
        workspace: {
          name: "update-test-workspace",
          description: "Initial description",
        },
        agents: {
          "agent-1": {
            type: "llm",
            description: "Initial agent",
            config: {
              provider: "anthropic",
              model: "claude-3-5-haiku-latest",
              prompt: "Initial prompt",
            },
          },
        },
      },
    });

    // Update with additional agent
    const updated = await store.updateValidatedDraft(
      initial.draft.id,
      {
        agents: {
          "agent-2": {
            type: "llm",
            description: "Additional agent added during update",
            config: {
              provider: "anthropic",
              model: "claude-3-5-haiku-latest",
              prompt: "Additional agent prompt",
            },
          },
        },
      },
      "Added second agent for enhanced functionality",
    );

    assertEquals(updated.validation.valid, true, "Updated configuration should be valid");
    assertExists(updated.draft.config.agents?.["agent-1"], "Should preserve original agent");
    assertExists(updated.draft.config.agents?.["agent-2"], "Should add new agent");
    assertGreater(updated.draft.iterations.length, 0, "Should have update history");

    console.log("✅ Draft update with validation completed successfully");
  } finally {
    await cleanup(kv);
  }
});

Deno.test("ValidatedDraftStore - Publishing Validation", async () => {
  const { store, kv } = await createTestValidatedStore();

  try {
    // Create a comprehensive draft ready for publishing
    const initial = await store.createValidatedDraft({
      name: "publishable-workspace",
      description: "A complete workspace ready for publishing",
      sessionId: "test-session",
      conversationId: "test-conversation",
      userId: "test-user",
      initialConfig: {
        version: "1.0",
        workspace: {
          name: "publishable-workspace",
          description: "A complete workspace ready for publishing",
        },
        agents: {
          "main-agent": {
            type: "llm",
            description: "Main processing agent",
            config: {
              provider: "anthropic",
              model: "claude-3-5-haiku-latest",
              prompt: "Process tasks and provide responses",
            },
          },
        },
        signals: {
          "trigger-signal": {
            description: "Main trigger signal",
            provider: "system",
          },
        },
        jobs: {
          "main-job": {
            name: "main-job",
            description: "Main processing job",
            triggers: [{ signal: "trigger-signal" }],
            execution: {
              strategy: "sequential",
              agents: [{ id: "main-agent", context: { signal: true } }],
            },
          },
        },
        tools: {
          mcp: {
            servers: {
              "test-server": {
                transport: {
                  type: "stdio",
                  command: "echo",
                  args: ["test"],
                },
              },
            },
          },
        },
      },
    });

    // Validate for publishing
    const publishValidation = await store.validateForPublishing(initial.draft.id);
    assertEquals(publishValidation.publishable, true, "Draft should be publishable");
    assertGreater(publishValidation.completionScore, 70, "Should meet publishing threshold");

    // Attempt to publish
    const publishResult = await store.publishValidatedDraft(initial.draft.id);
    assertEquals(publishResult.success, true, "Publishing should succeed");
    assertEquals(publishResult.validation.publishable, true, "Should confirm publishability");

    console.log(
      `✅ Draft published successfully with ${publishResult.validation.completionScore}% completion`,
    );
  } finally {
    await cleanup(kv);
  }
});

Deno.test("ValidatedDraftStore - Validation Summary", async () => {
  const { store, kv } = await createTestValidatedStore();

  try {
    const conversationId = "summary-test-conversation";

    // Create multiple drafts with varying quality
    await store.createValidatedDraft({
      name: "high-quality-draft",
      description: "A high quality draft",
      sessionId: "test-session-1",
      conversationId,
      userId: "test-user",
      initialConfig: {
        version: "1.0",
        workspace: { name: "high-quality", description: "Complete workspace" },
        agents: {
          "agent": {
            type: "llm",
            description: "Well-configured agent",
            config: {
              provider: "anthropic",
              model: "claude-3-5-haiku-latest",
              prompt: "Detailed system prompt",
            },
          },
        },
        jobs: {
          "job": {
            name: "job",
            description: "Complete job",
            triggers: [{ signal: "signal" }],
            execution: {
              strategy: "sequential",
              agents: [{ id: "agent", context: { signal: true } }],
            },
          },
        },
        signals: {
          "signal": {
            description: "Complete signal",
            provider: "system",
          },
        },
      },
    });

    await store.createValidatedDraft({
      name: "minimal-draft",
      description: "A minimal draft",
      sessionId: "test-session-2",
      conversationId,
      userId: "test-user",
      initialConfig: {
        version: "1.0",
        workspace: { name: "minimal", description: "Basic workspace" },
      },
    });

    // Get validation summary
    const summary = await store.getConversationValidationSummary(conversationId);

    assertEquals(summary.totalDrafts, 2, "Should have 2 drafts");
    assertGreater(summary.avgCompletionScore, 0, "Should have average completion score");
    assertGreater(summary.avgQualityScore, 0, "Should have average quality score");

    console.log(
      `✅ Validation summary: ${summary.totalDrafts} drafts, avg completion: ${
        summary.avgCompletionScore.toFixed(1)
      }%`,
    );
  } finally {
    await cleanup(kv);
  }
});

Deno.test("ValidatedDraftStore - Validation Disabled Mode", async () => {
  const kv = await Deno.openKv(":memory:");
  const store = new ValidatedDraftStore(kv, {
    enableValidation: false, // Disable validation
  });

  try {
    // Create draft with invalid config - should succeed since validation is off
    const result = await store.createValidatedDraft({
      name: "invalid-but-allowed",
      description: "Invalid config that should be allowed",
      sessionId: "test-session",
      userId: "test-user",
      initialConfig: {
        // Missing version and other required fields
        invalidField: "this should not be in a workspace config",
      } as any,
    });

    assertExists(result.draft, "Should create draft even with invalid config");
    assertEquals(result.validation.valid, true, "Should report as valid (validation disabled)");
    assertEquals(result.validation.errors.length, 0, "Should have no errors (validation disabled)");
    assertEquals(
      result.validation.completionScore,
      100,
      "Should report 100% completion (no-op validation)",
    );

    console.log("✅ Validation disabled mode working correctly");
  } finally {
    await cleanup(kv);
  }
});
