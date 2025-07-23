/**
 * Tests for SimplifiedDraftValidator
 *
 * Focuses on essential validation behavior without complex edge cases
 */

import { assertEquals, assertExists } from "@std/assert";
import type { WorkspaceConfig } from "@atlas/config";
import { SimplifiedDraftValidator } from "./simplified-draft-validator.ts";
import type { WorkspaceDraft } from "../workspace-draft-store.ts";
import type { SimplifiedValidationContext } from "./simplified-types.ts";

// Test utilities
function createMockDraft(config: Partial<WorkspaceConfig>): WorkspaceDraft {
  return {
    id: "test-draft-123",
    name: "Test Workspace",
    description: "Test workspace for validation",
    config,
    iterations: [{
      timestamp: new Date().toISOString(),
      operation: "create",
      config: {},
      summary: "Initial draft creation",
    }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "draft",
    sessionId: "test-session",
    userId: "test-user",
  };
}

function createValidationContext(
  config: Partial<WorkspaceConfig>,
  options: Partial<SimplifiedValidationContext> = {},
): SimplifiedValidationContext {
  const draft = createMockDraft(config);
  return {
    draftId: draft.id,
    draft,
    config,
    validateReferences: true,
    checkBestPractices: false,
    strictMode: false,
    ...options,
  };
}

// Valid minimal configuration for testing
const validMinimalConfig: Partial<WorkspaceConfig> = {
  version: "1.0",
  workspace: {
    name: "test-workspace",
    description: "A test workspace for validation",
  },
  agents: {
    "test-agent": {
      type: "llm",
      description: "A test agent for validation",
      config: {
        model: "claude-3-5-haiku-latest",
        provider: "anthropic",
        prompt: "You are a helpful assistant.",
      },
    },
  },
  jobs: {
    "test-job": {
      name: "test-job",
      description: "A test job for validation",
      execution: {
        strategy: "sequential",
        agents: ["test-agent"],
      },
    },
  },
};

// Test suite
Deno.test("SimplifiedDraftValidator - Schema Validation", async (t) => {
  const validator = new SimplifiedDraftValidator();

  await t.step("validates correct minimal schema", () => {
    const result = validator.validateSchema(validMinimalConfig);
    assertEquals(result.valid, true);
    assertEquals(result.schemaErrors.length, 0);
  });

  await t.step("detects missing required fields", () => {
    const incompleteConfig = {
      version: "1.0",
      // Missing workspace
    };

    const result = validator.validateSchema(incompleteConfig);
    assertEquals(result.valid, false);
    assertEquals(result.schemaErrors.length > 0, true);
  });

  await t.step("detects invalid types", () => {
    const invalidConfig = {
      version: "1.0",
      workspace: {
        name: 123, // Should be string
        description: "Test",
      },
    };

    const result = validator.validateSchema(invalidConfig);
    assertEquals(result.valid, false);
    assertEquals(result.schemaErrors.length > 0, true);
  });
});

Deno.test("SimplifiedDraftValidator - Reference Validation", async (t) => {
  const validator = new SimplifiedDraftValidator();

  await t.step("validates correct agent references", () => {
    const result = validator.validateReferences(validMinimalConfig);
    assertEquals(result.valid, true);
    assertEquals(result.errors.length, 0);
  });

  await t.step("detects broken agent references", () => {
    const configWithBrokenAgentRef: Partial<WorkspaceConfig> = {
      ...validMinimalConfig,
      jobs: {
        "test-job": {
          name: "test-job",
          description: "A test job",
          execution: {
            agents: ["non-existent-agent"], // Broken reference
          },
        },
      },
    };

    const result = validator.validateReferences(configWithBrokenAgentRef);
    assertEquals(result.valid, false);
    assertEquals(result.errors.length, 1);
    assertEquals(result.errors[0]?.code, "INVALID_AGENT_REFERENCE");
  });

  await t.step("detects broken signal references", () => {
    const configWithBrokenSignalRef: Partial<WorkspaceConfig> = {
      ...validMinimalConfig,
      jobs: {
        "test-job": {
          name: "test-job",
          description: "A test job",
          triggers: [
            { signal: "non-existent-signal" }, // Broken reference
          ],
          execution: {
            agents: ["test-agent"],
          },
        },
      },
    };

    const result = validator.validateReferences(configWithBrokenSignalRef);
    assertEquals(result.valid, false);
    assertEquals(result.errors.length, 1);
    assertEquals(result.errors[0]?.code, "INVALID_SIGNAL_REFERENCE");
  });

  await t.step("validates correct signal references", () => {
    const configWithSignals: Partial<WorkspaceConfig> = {
      ...validMinimalConfig,
      signals: {
        "test-signal": {
          provider: "http",
          description: "A test signal",
          config: { path: "/webhook" },
        },
      },
      jobs: {
        "test-job": {
          name: "test-job",
          description: "A test job",
          triggers: [
            { signal: "test-signal" }, // Valid reference
          ],
          execution: {
            agents: ["test-agent"],
          },
        },
      },
    };

    const result = validator.validateReferences(configWithSignals);
    assertEquals(result.valid, true);
    assertEquals(result.errors.length, 0);
  });
});

Deno.test("SimplifiedDraftValidator - Completeness Checking", async (t) => {
  const validator = new SimplifiedDraftValidator();

  await t.step("assesses complete configuration", () => {
    const result = validator.checkCompleteness(validMinimalConfig);
    assertEquals(result.overall >= 70, true);
    assertEquals(result.hasWorkspace, true);
    assertEquals(result.hasAgents, true);
    assertEquals(result.hasJobs, true);
    assertEquals(result.missing.length, 0);
  });

  await t.step("identifies missing workspace", () => {
    const incompleteConfig = {
      agents: validMinimalConfig.agents,
      jobs: validMinimalConfig.jobs,
    };

    const result = validator.checkCompleteness(incompleteConfig);
    assertEquals(result.hasWorkspace, false);
    assertEquals(result.missing.includes("workspace metadata"), true);
  });

  await t.step("identifies missing agents", () => {
    const incompleteConfig = {
      workspace: validMinimalConfig.workspace,
      jobs: validMinimalConfig.jobs,
    };

    const result = validator.checkCompleteness(incompleteConfig);
    assertEquals(result.hasAgents, false);
    assertEquals(result.missing.includes("agents"), true);
  });

  await t.step("identifies missing jobs", () => {
    const incompleteConfig = {
      workspace: validMinimalConfig.workspace,
      agents: validMinimalConfig.agents,
    };

    const result = validator.checkCompleteness(incompleteConfig);
    assertEquals(result.hasJobs, false);
    assertEquals(result.missing.includes("jobs"), true);
  });
});

Deno.test("SimplifiedDraftValidator - Full Draft Validation", async (t) => {
  const validator = new SimplifiedDraftValidator();

  await t.step("validates complete draft", async () => {
    const context = createValidationContext(validMinimalConfig);
    const result = await validator.validateDraft(context);

    assertEquals(result.valid, true);
    assertEquals(result.publishable, true);
    assertEquals(result.errors.length, 0);
    assertExists(result.quality);
    assertExists(result.completionScore);
  });

  await t.step("handles draft with errors", async () => {
    const invalidConfig = {
      version: "1.0",
      workspace: {
        name: "test",
        description: "test",
      },
      jobs: {
        "test-job": {
          name: "test-job",
          execution: {
            agents: ["non-existent-agent"], // Broken reference
          },
        },
      },
    };

    const context = createValidationContext(invalidConfig);
    const result = await validator.validateDraft(context);

    assertEquals(result.valid, false);
    assertEquals(result.publishable, false);
    assertEquals(result.errors.length > 0, true);
  });

  await t.step("generates warnings for best practices", async () => {
    const configWithShortDescriptions: Partial<WorkspaceConfig> = {
      ...validMinimalConfig,
      agents: {
        "test-agent": {
          type: "llm",
          description: "test", // Too short
          config: {},
        },
      },
    };

    const context = createValidationContext(configWithShortDescriptions, {
      checkBestPractices: true,
    });
    const result = await validator.validateDraft(context);

    assertEquals(result.warnings.length > 0, true);
    assertEquals(result.warnings.some((w) => w.code === "SHORT_DESCRIPTION"), true);
  });
});

Deno.test("SimplifiedDraftValidator - Publishing Validation", async (t) => {
  const validator = new SimplifiedDraftValidator();

  await t.step("approves complete draft for publishing", async () => {
    const draft = createMockDraft(validMinimalConfig);
    const result = await validator.validateForPublishing(draft);

    assertEquals(result.canPublish, true);
    assertEquals(result.publishingErrors.length, 0);
    assertEquals(result.estimatedFiles.length > 0, true);
  });

  await t.step("rejects incomplete draft", async () => {
    const incompleteConfig = {
      version: "1.0",
      workspace: { name: "test" }, // Missing description
    };

    const draft = createMockDraft(incompleteConfig);
    draft.name = ""; // Missing workspace name

    const result = await validator.validateForPublishing(draft);

    assertEquals(result.canPublish, false);
    assertEquals(result.publishingErrors.length > 0, true);
  });

  await t.step("rejects draft without workspace name", async () => {
    const draft = createMockDraft(validMinimalConfig);
    draft.name = ""; // Empty name

    const result = await validator.validateForPublishing(draft);

    assertEquals(result.canPublish, false);
    assertEquals(result.publishingErrors.some((e) => e.code === "INVALID_WORKSPACE_NAME"), true);
  });
});

Deno.test("SimplifiedDraftValidator - Complex Agent References", async (t) => {
  const validator = new SimplifiedDraftValidator();

  await t.step("validates object-style agent references", () => {
    const configWithObjectAgentRefs: Partial<WorkspaceConfig> = {
      ...validMinimalConfig,
      jobs: {
        "test-job": {
          name: "test-job",
          description: "Test job",
          execution: {
            strategy: "sequential",
            agents: [
              { id: "test-agent", context: { signal: true } }, // Object-style reference
            ],
          },
        },
      },
    };

    const result = validator.validateReferences(configWithObjectAgentRefs);
    assertEquals(result.valid, true);
    assertEquals(result.errors.length, 0);
  });

  await t.step("detects broken object-style agent references", () => {
    const configWithBrokenObjectRef: Partial<WorkspaceConfig> = {
      ...validMinimalConfig,
      jobs: {
        "test-job": {
          name: "test-job",
          description: "Test job",
          execution: {
            strategy: "sequential",
            agents: [
              { id: "non-existent-agent", context: { signal: true } }, // Broken reference
            ],
          },
        },
      },
    };

    const result = validator.validateReferences(configWithBrokenObjectRef);
    assertEquals(result.valid, false);
    assertEquals(result.errors.length, 1);
    assertEquals(result.errors[0]?.code, "INVALID_AGENT_REFERENCE");
  });
});
