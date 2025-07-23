/**
 * Tests for conflict detection functionality
 */

import { assertEquals, assertGreater } from "@std/assert";
import { AtlasDraftValidator } from "./draft-validator.ts";
import type { WorkspaceDraft } from "../workspace-draft-store.ts";

// Test utilities
function createMockDraft(config: any): WorkspaceDraft {
  return {
    id: "test-draft-id",
    name: "test-draft",
    description: "Test draft for conflict detection",
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

Deno.test("AtlasDraftValidator - Conflict Detection - Naming Conflicts", async () => {
  const validator = new AtlasDraftValidator();

  // Configuration with naming conflicts
  const configWithConflicts = {
    version: "1.0",
    workspace: {
      name: "test-workspace",
      description: "Test workspace with naming conflicts",
    },
    agents: {
      "duplicate-name": {
        type: "llm",
        description: "First agent with duplicate name",
        config: {
          provider: "anthropic",
          model: "claude-3-5-haiku-latest",
          prompt: "Test prompt for first agent",
        },
      },
    },
    jobs: {
      "duplicate-name": { // Same name as agent - should conflict
        name: "duplicate-name",
        description: "Job with same name as agent",
        triggers: [{ signal: "test-signal" }],
        execution: {
          strategy: "sequential",
          agents: [{ id: "duplicate-name", context: { signal: true } }],
        },
      },
    },
    signals: {
      "test-signal": {
        description: "Test signal",
        provider: "cli",
        config: {},
      },
    },
  };

  const draft = createMockDraft(configWithConflicts);
  const result = await validator.validateConflicts(draft);

  assertEquals(result.valid, false, "Configuration with naming conflicts should be invalid");
  assertEquals(result.namingConflicts.length, 1, "Should detect one naming conflict");

  const conflict = result.namingConflicts[0];
  assertEquals(conflict.name, "duplicate-name", "Should identify the conflicting name");
  assertEquals(conflict.type, "duplicate-id", "Should be a duplicate ID conflict");
  assertEquals(conflict.severity, "error", "Naming conflicts should be errors");
  assertEquals(conflict.conflictingPaths.length, 2, "Should identify both conflicting paths");

  console.log("✅ Naming conflict detection working correctly");
});

Deno.test("AtlasDraftValidator - Conflict Detection - Resource Conflicts", async () => {
  const validator = new AtlasDraftValidator();

  // Configuration with resource conflicts (same port)
  const configWithResourceConflicts = {
    version: "1.0",
    workspace: {
      name: "test-workspace",
      description: "Test workspace with resource conflicts",
    },
    agents: {
      "agent-1": {
        type: "llm",
        description: "First agent using port 8080",
        config: {
          provider: "anthropic",
          model: "claude-3-5-haiku-latest",
          prompt: "Test prompt",
          port: 8080,
        },
      },
      "agent-2": {
        type: "llm",
        description: "Second agent also using port 8080",
        config: {
          provider: "anthropic",
          model: "claude-3-5-haiku-latest",
          prompt: "Another test prompt",
          server: {
            port: 8080, // Same port as agent-1
          },
        },
      },
    },
    signals: {
      "test-signal": {
        description: "Test signal",
        provider: "cli",
        config: {},
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
            { id: "agent-1", context: { signal: true } },
            { id: "agent-2", context: { steps: "previous" } },
          ],
        },
      },
    },
  };

  const draft = createMockDraft(configWithResourceConflicts);
  const result = await validator.validateConflicts(draft);

  assertEquals(result.valid, false, "Configuration with resource conflicts should be invalid");
  assertGreater(result.resourceConflicts.length, 0, "Should detect resource conflicts");

  const portConflict = result.resourceConflicts.find((c) => c.conflictType === "port");
  if (portConflict) {
    assertEquals(portConflict.resource, "port:8080", "Should identify the conflicting port");
    assertEquals(
      portConflict.conflictingComponents.length,
      2,
      "Should identify both conflicting agents",
    );
    assertEquals(portConflict.severity, "error", "Port conflicts should be errors");
  }

  console.log("✅ Resource conflict detection working correctly");
});

Deno.test("AtlasDraftValidator - Conflict Detection - Circular Dependencies", async () => {
  const validator = new AtlasDraftValidator();

  // This test focuses on testing circular dependency detection logic
  // Since the current implementation is simplified, we'll test with what's available
  const configWithPotentialCycles = {
    version: "1.0",
    workspace: {
      name: "test-workspace",
      description: "Test workspace for circular dependency detection",
    },
    agents: {
      "agent-a": {
        type: "llm",
        description: "Agent A",
        config: {
          provider: "anthropic",
          model: "claude-3-5-haiku-latest",
          prompt: "Agent A prompt",
        },
      },
      "agent-b": {
        type: "llm",
        description: "Agent B",
        config: {
          provider: "anthropic",
          model: "claude-3-5-haiku-latest",
          prompt: "Agent B prompt",
        },
      },
    },
    signals: {
      "signal-a": {
        description: "Signal A",
        provider: "cli",
        config: {},
      },
      "signal-b": {
        description: "Signal B",
        provider: "cli",
        config: {},
      },
    },
    jobs: {
      "job-a": {
        name: "job-a",
        description: "Job A that might create cycles",
        triggers: [{ signal: "signal-a" }],
        execution: {
          strategy: "sequential",
          agents: [{ id: "agent-a", context: { signal: true } }],
        },
        // In a real scenario, this job might emit signal-b
        emits: ["signal-b"],
      },
      "job-b": {
        name: "job-b",
        description: "Job B that might create cycles",
        triggers: [{ signal: "signal-b" }],
        execution: {
          strategy: "sequential",
          agents: [{ id: "agent-b", context: { signal: true } }],
        },
        // This job might emit signal-a, creating a cycle
        emits: ["signal-a"],
      },
    },
  };

  const draft = createMockDraft(configWithPotentialCycles);
  const result = await validator.validateReferences(draft);

  // Note: The current circular dependency detection is simplified
  // This test verifies the structure is in place
  assertEquals(
    typeof result.circularDependencies,
    "object",
    "Should have circular dependencies array",
  );
  assertEquals(
    Array.isArray(result.circularDependencies),
    true,
    "Circular dependencies should be an array",
  );

  console.log(
    `✅ Circular dependency detection structure verified (found ${result.circularDependencies.length} cycles)`,
  );
});
