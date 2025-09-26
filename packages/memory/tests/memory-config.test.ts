import { expect } from "@std/expect";
import { MemoryConfigManager } from "../../../src/core/memory-config.ts";
import { AtlasScope } from "../../../src/core/scope.ts";

// Set testing environment to prevent logger file operations
Deno.env.set("DENO_TESTING", "true");

// Mock memory config for testing
const mockMemoryConfig = {
  default: {
    enabled: true,
    storage: "local",
    cognitive_loop: true,
    retention: { max_age_days: 30, max_entries: 1000, cleanup_interval_hours: 24 },
  },
  streaming: {
    enabled: true,
    queue_max_size: 1000,
    batch_size: 50,
    flush_interval_ms: 5000,
    background_processing: true,
    persistence_enabled: true,
    error_retry_attempts: 3,
    priority_processing: true,
    dual_write_enabled: false,
    legacy_batch_enabled: false,
    stream_everything: false,
    performance_tracking: true,
  },
  agent: {
    enabled: true,
    scope: "agent" as const,
    include_in_context: true,
    context_limits: { relevant_memories: 3, past_successes: 2, past_failures: 1 },
    memory_types: {
      working: { enabled: true, max_age_hours: 2, max_entries: 50 },
      episodic: { enabled: true, max_age_hours: 24, max_entries: 100 },
      semantic: { enabled: false, max_age_days: 30, max_entries: 200 },
      procedural: { enabled: true, max_age_days: 90, max_entries: 300 },
    },
  },
  session: {
    enabled: true,
    scope: "session" as const,
    include_in_context: true,
    context_limits: { relevant_memories: 5, past_successes: 3, past_failures: 2 },
    memory_types: {
      working: { enabled: true, max_age_hours: 8, max_entries: 100 },
      episodic: { enabled: true, max_age_days: 7, max_entries: 200 },
      semantic: { enabled: true, max_age_days: 30, max_entries: 500 },
      procedural: { enabled: true, max_age_days: 90, max_entries: 400 },
    },
  },
  workspace: {
    enabled: true,
    scope: "workspace" as const,
    include_in_context: false,
    context_limits: { relevant_memories: 10, past_successes: 5, past_failures: 3 },
    memory_types: {
      working: { enabled: false, max_age_hours: 24, max_entries: 200 },
      episodic: { enabled: true, max_age_days: 30, max_entries: 1000 },
      semantic: { enabled: true, max_age_days: 365, max_entries: 2000 },
      procedural: { enabled: true, max_age_days: 365, max_entries: 1000 },
    },
  },
};

Deno.test("MemoryConfigManager - creates memory managers for different scopes", () => {
  const configManager = new MemoryConfigManager(mockMemoryConfig);
  const scope = new AtlasScope();

  // Get memory managers for different scopes
  const agentMemory = configManager.getMemoryManager(scope, "agent");
  const sessionMemory = configManager.getMemoryManager(scope, "session");
  const workspaceMemory = configManager.getMemoryManager(scope, "workspace");

  expect(agentMemory).toBeDefined();
  expect(sessionMemory).toBeDefined();
  expect(workspaceMemory).toBeDefined();

  // Should be different instances
  expect(agentMemory).not.toBe(sessionMemory);
  expect(sessionMemory).not.toBe(workspaceMemory);

  // Cleanup to prevent resource leaks
  configManager.cleanup();
});

Deno.test("MemoryConfigManager - reuses memory managers for same scope", () => {
  const configManager = new MemoryConfigManager(mockMemoryConfig);
  const scope = new AtlasScope();

  // Get memory manager twice for same scope
  const agentMemory1 = configManager.getMemoryManager(scope, "agent");
  const agentMemory2 = configManager.getMemoryManager(scope, "agent");

  // Should be same instance
  expect(agentMemory1).toBe(agentMemory2);

  // Cleanup to prevent resource leaks
  configManager.cleanup();
});

Deno.test("MemoryConfigManager - creates disabled memory manager when disabled", () => {
  const disabledConfig = {
    ...mockMemoryConfig,
    agent: { ...mockMemoryConfig.agent, enabled: false },
  };

  const configManager = new MemoryConfigManager(disabledConfig);
  const scope = new AtlasScope();

  // Should create disabled memory manager
  const agentMemory = configManager.getMemoryManager(scope, "agent");
  expect(agentMemory).toBeDefined();

  // Cleanup to prevent resource leaks
  configManager.cleanup();
});

Deno.test("MemoryConfigManager - builds memory context with limits", () => {
  const configManager = new MemoryConfigManager(mockMemoryConfig);
  const scope = new AtlasScope();
  const memoryManager = configManager.getMemoryManager(scope, "agent");

  // Build memory context
  const context = configManager.buildMemoryContext(memoryManager, "Test user prompt", "agent");

  expect(context).toBeDefined();
  expect(context.systemContext).toBeDefined();
  expect(context.userContext).toBeDefined();

  // Cleanup to prevent resource leaks
  configManager.cleanup();
});

Deno.test("MemoryConfigManager - builds empty context when disabled", () => {
  const disabledConfig = {
    ...mockMemoryConfig,
    agent: { ...mockMemoryConfig.agent, enabled: false },
  };

  const configManager = new MemoryConfigManager(disabledConfig);
  const scope = new AtlasScope();
  const memoryManager = configManager.getMemoryManager(scope, "agent");

  // Build memory context
  const context = configManager.buildMemoryContext(memoryManager, "Test user prompt", "agent");

  expect(context.systemContext).toBe("");
  expect(context.userContext).toBe("");

  // Cleanup to prevent resource leaks
  configManager.cleanup();
});

Deno.test("MemoryConfigManager - builds empty context when not included", () => {
  const noContextConfig = {
    ...mockMemoryConfig,
    agent: { ...mockMemoryConfig.agent, include_in_context: false },
  };

  const configManager = new MemoryConfigManager(noContextConfig);
  const scope = new AtlasScope();
  const memoryManager = configManager.getMemoryManager(scope, "agent");

  // Build memory context
  const context = configManager.buildMemoryContext(memoryManager, "Test user prompt", "agent");

  expect(context.systemContext).toBe("");
  expect(context.userContext).toBe("");

  // Cleanup to prevent resource leaks
  configManager.cleanup();
});

Deno.test("MemoryConfigManager - remembers with scope-specific configuration", () => {
  const configManager = new MemoryConfigManager(mockMemoryConfig);
  const scope = new AtlasScope();
  const memoryManager = configManager.getMemoryManager(scope, "agent");

  // Remember with scope configuration
  expect(() => {
    configManager.rememberWithScope(
      memoryManager,
      "test-key",
      "test-content",
      "working",
      "agent",
      ["test-tag"],
      0.8,
    );
  }).not.toThrow();

  // Cleanup to prevent resource leaks
  configManager.cleanup();
});

Deno.test("MemoryConfigManager - skips remembering when disabled", () => {
  const disabledConfig = {
    ...mockMemoryConfig,
    agent: { ...mockMemoryConfig.agent, enabled: false },
  };

  const configManager = new MemoryConfigManager(disabledConfig);
  const scope = new AtlasScope();
  const memoryManager = configManager.getMemoryManager(scope, "agent");

  // Should not throw when disabled
  expect(() => {
    configManager.rememberWithScope(
      memoryManager,
      "test-key",
      "test-content",
      "working",
      "agent",
      ["test-tag"],
      0.8,
    );
  }).not.toThrow();

  // Cleanup to prevent resource leaks
  configManager.cleanup();
});

Deno.test("MemoryConfigManager - skips remembering when memory type disabled", () => {
  const disabledTypeConfig = {
    ...mockMemoryConfig,
    agent: {
      ...mockMemoryConfig.agent,
      memory_types: {
        ...mockMemoryConfig.agent.memory_types,
        working: { ...mockMemoryConfig.agent.memory_types.working, enabled: false },
      },
    },
  };

  const configManager = new MemoryConfigManager(disabledTypeConfig);
  const scope = new AtlasScope();
  const memoryManager = configManager.getMemoryManager(scope, "agent");

  // Should not throw when memory type disabled
  expect(() => {
    configManager.rememberWithScope(
      memoryManager,
      "test-key",
      "test-content",
      "working",
      "agent",
      ["test-tag"],
      0.8,
    );
  }).not.toThrow();

  // Cleanup to prevent resource leaks
  configManager.cleanup();
});

Deno.test("MemoryConfigManager - cleanup disposes memory managers", () => {
  const configManager = new MemoryConfigManager(mockMemoryConfig);
  const scope = new AtlasScope();

  // Create some memory managers
  configManager.getMemoryManager(scope, "agent");
  configManager.getMemoryManager(scope, "session");
  configManager.getMemoryManager(scope, "workspace");

  // Cleanup should not throw
  expect(() => configManager.cleanup()).not.toThrow();
});

Deno.test("MemoryConfigManager - generates unique memory keys", () => {
  const configManager = new MemoryConfigManager(mockMemoryConfig);
  const scope1 = new AtlasScope();
  const scope2 = new AtlasScope();

  // Get memory managers for different scopes
  const agentMemory1 = configManager.getMemoryManager(scope1, "agent");
  const agentMemory2 = configManager.getMemoryManager(scope2, "agent");

  // Should be different instances for different scopes
  expect(agentMemory1).not.toBe(agentMemory2);

  // Cleanup to prevent resource leaks
  configManager.cleanup();
});

Deno.test("MemoryConfigManager - calculates decay rates based on config", () => {
  const configManager = new MemoryConfigManager(mockMemoryConfig);
  const scope = new AtlasScope();
  const memoryManager = configManager.getMemoryManager(scope, "agent");

  // Remember with different memory types to test decay rate calculation
  expect(() => {
    configManager.rememberWithScope(
      memoryManager,
      "working-key",
      "working content",
      "working",
      "agent",
      ["working"],
      0.8,
    );
  }).not.toThrow();

  expect(() => {
    configManager.rememberWithScope(
      memoryManager,
      "procedural-key",
      "procedural content",
      "procedural",
      "agent",
      ["procedural"],
      0.8,
    );
  }).not.toThrow();

  // Cleanup to prevent resource leaks
  configManager.cleanup();
});

Deno.test("MemoryConfigManager - handles streaming configuration", () => {
  const streamingConfig = {
    ...mockMemoryConfig,
    streaming: { ...mockMemoryConfig.streaming, enabled: true, stream_everything: true },
  };

  const configManager = new MemoryConfigManager(streamingConfig);
  const scope = new AtlasScope();

  // Should still create memory managers with streaming config
  const agentMemory = configManager.getMemoryManager(scope, "agent");
  expect(agentMemory).toBeDefined();

  // Cleanup to prevent resource leaks
  configManager.cleanup();
});

Deno.test("MemoryConfigManager - handles complex memory type configurations", () => {
  const complexConfig = {
    ...mockMemoryConfig,
    session: {
      ...mockMemoryConfig.session,
      memory_types: {
        working: { enabled: true, max_age_hours: 1, max_entries: 10 },
        episodic: { enabled: true, max_age_days: 1, max_entries: 20 },
        semantic: { enabled: false, max_age_days: 30, max_entries: 500 },
        procedural: { enabled: true, max_age_days: 7, max_entries: 100 },
      },
    },
  };

  const configManager = new MemoryConfigManager(complexConfig);
  const scope = new AtlasScope();
  const memoryManager = configManager.getMemoryManager(scope, "session");

  // Should handle complex configurations
  expect(memoryManager).toBeDefined();

  // Test context building with complex config
  const context = configManager.buildMemoryContext(memoryManager, "Test prompt", "session");

  expect(context).toBeDefined();

  // Cleanup to prevent resource leaks
  configManager.cleanup();
});

Deno.test("MemoryConfigManager - handles workspace scope memory", () => {
  const configManager = new MemoryConfigManager(mockMemoryConfig);
  const scope = new AtlasScope();
  const workspaceMemory = configManager.getMemoryManager(scope, "workspace");

  // Workspace memory should be created
  expect(workspaceMemory).toBeDefined();

  // Context should be empty since include_in_context is false
  const context = configManager.buildMemoryContext(workspaceMemory, "Test prompt", "workspace");

  expect(context.systemContext).toBe("");
  expect(context.userContext).toBe("");

  // Cleanup to prevent resource leaks
  configManager.cleanup();
});
