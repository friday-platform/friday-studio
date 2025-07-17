import {
  AtlasConfigSchema,
  ConfigLoader,
  getAgent,
  getJob,
  getSignal,
  type JobSpecification,
  type MergedConfig,
  type WorkspaceAgentConfig,
  WorkspaceConfigSchema,
  type WorkspaceSignalConfig,
} from "@atlas/config";
import { assertEquals, assertRejects } from "@std/assert";

// Mock adapter for testing
class MockConfigAdapter {
  private configs: Map<string, unknown> = new Map();

  constructor(private workspacePath: string) {}

  addConfig(filename: string, content: unknown) {
    const path = `${this.workspacePath}/${filename}`;
    this.configs.set(path, content);
  }

  readYaml(path: string): Promise<unknown> {
    const content = this.configs.get(path);
    if (!content) {
      throw new Error(`File not found: ${path}`);
    }
    return Promise.resolve(content);
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.configs.has(path));
  }

  getWorkspacePath(): string {
    return this.workspacePath;
  }
}

// Invalid Configurations
Deno.test("Edge Cases - should reject invalid version", () => {
  const invalidConfig = {
    version: "2.0", // Invalid version
    workspace: {
      name: "test",
    },
  };

  const result = WorkspaceConfigSchema.safeParse(invalidConfig);
  assertEquals(result.success, false);
});

Deno.test("Edge Cases - should reject missing required fields", () => {
  // Missing version
  const noVersion = {
    workspace: {
      name: "test",
    },
  };

  const result1 = WorkspaceConfigSchema.safeParse(noVersion);
  assertEquals(result1.success, false);

  // Missing workspace
  const noWorkspace = {
    version: "1.0",
  };

  const result2 = WorkspaceConfigSchema.safeParse(noWorkspace);
  assertEquals(result2.success, false);

  // Missing workspace name
  const noName = {
    version: "1.0",
    workspace: {},
  };

  const result3 = WorkspaceConfigSchema.safeParse(noName);
  assertEquals(result3.success, false);
});

// Agent Validation
Deno.test("Edge Cases - should reject invalid agent types", () => {
  const invalidAgent = {
    version: "1.0",
    workspace: { name: "test" },
    agents: {
      "bad-agent": {
        type: "invalid-type", // Invalid type
        description: "Bad agent",
      },
    },
  };

  const result = WorkspaceConfigSchema.safeParse(invalidAgent);
  assertEquals(result.success, false);
});

Deno.test("Edge Cases - should reject LLM agent without required config", () => {
  const missingConfig = {
    version: "1.0",
    workspace: { name: "test" },
    agents: {
      "incomplete-llm": {
        type: "llm",
        description: "Missing config",
        // Missing config field
      },
    },
  };

  const result = WorkspaceConfigSchema.safeParse(missingConfig);
  assertEquals(result.success, false);

  const missingModel = {
    version: "1.0",
    workspace: { name: "test" },
    agents: {
      "no-model": {
        type: "llm",
        description: "No model",
        config: {
          provider: "anthropic",
          prompt: "Test",
          // Missing model
        },
      },
    },
  };

  const result2 = WorkspaceConfigSchema.safeParse(missingModel);
  assertEquals(result2.success, false);
});

Deno.test("Edge Cases - should reject system agent without agent field", () => {
  const missingAgent = {
    version: "1.0",
    workspace: { name: "test" },
    agents: {
      "bad-system": {
        type: "system",
        description: "Missing agent field",
        // Missing agent field
      },
    },
  };

  const result = WorkspaceConfigSchema.safeParse(missingAgent);
  assertEquals(result.success, false);
});

// Signal Validation
Deno.test("Edge Cases - should reject invalid signal providers", () => {
  const invalidProvider = {
    version: "1.0",
    workspace: { name: "test" },
    signals: {
      "bad-signal": {
        provider: "invalid",
        description: "Bad provider",
      },
    },
  };

  const result = WorkspaceConfigSchema.safeParse(invalidProvider);
  assertEquals(result.success, false);
});

Deno.test("Edge Cases - should reject signals missing required config", () => {
  const httpNoPath = {
    version: "1.0",
    workspace: { name: "test" },
    signals: {
      "bad-http": {
        provider: "http",
        description: "Missing path",
        config: {}, // Missing required path
      },
    },
  };

  const result1 = WorkspaceConfigSchema.safeParse(httpNoPath);
  assertEquals(result1.success, false);

  const scheduleNoCron = {
    version: "1.0",
    workspace: { name: "test" },
    signals: {
      "bad-schedule": {
        provider: "schedule",
        description: "Missing schedule",
        config: {}, // Missing required schedule
      },
    },
  };

  const result2 = WorkspaceConfigSchema.safeParse(scheduleNoCron);
  assertEquals(result2.success, false);
});

// Job Validation
Deno.test("Edge Cases - should reject jobs with invalid execution strategies", () => {
  const invalidStrategy = {
    version: "1.0",
    workspace: { name: "test" },
    jobs: {
      "bad-job": {
        description: "Invalid strategy",
        execution: {
          strategy: "parallel", // Invalid - only sequential supported
          agents: [],
        },
      },
    },
  };

  const result = WorkspaceConfigSchema.safeParse(invalidStrategy);
  assertEquals(result.success, false);
});

Deno.test("Edge Cases - should reject jobs with empty agent list", () => {
  const emptyAgents = {
    version: "1.0",
    workspace: { name: "test" },
    jobs: {
      "empty-job": {
        description: "No agents",
        execution: {
          strategy: "sequential",
          agents: [], // Must have at least one agent
        },
      },
    },
  };

  const result = WorkspaceConfigSchema.safeParse(emptyAgents);
  assertEquals(result.success, false);
});

// Complex Validation Scenarios
Deno.test("Edge Cases - should handle circular references gracefully", async () => {
  const circularConfig = {
    version: "1.0",
    workspace: { name: "test" },
    agents: {
      "agent-a": {
        type: "llm",
        description: "Agent A",
        config: {
          provider: "anthropic",
          model: "claude-3-5-haiku-latest",
          prompt: "Agent A",
        },
      },
    },
    jobs: {
      "job-a": {
        description: "Job A",
        triggers: [{ signal: "signal-b" }], // References non-existent signal
        execution: {
          strategy: "sequential",
          agents: ["agent-b"], // References non-existent agent
        },
      },
    },
  };

  const adapter = new MockConfigAdapter("/test");
  adapter.addConfig("workspace.yml", circularConfig);

  const loader = new ConfigLoader(adapter, "/test");

  await assertRejects(
    () => loader.load(),
    Error,
    "references undefined agent",
  );
});

// Helper Function Tests
Deno.test("Edge Cases - getJob helper should handle missing jobs", () => {
  const config = {
    version: "1.0",
    workspace: { name: "test" },
    jobs: {
      "existing-job": {
        description: "Exists",
        execution: {
          strategy: "sequential",
          agents: ["test"],
        },
      },
    },
  };

  const parsed = WorkspaceConfigSchema.parse(config);

  // Create merged config for helper function
  const mergedConfig: MergedConfig = {
    atlas: null,
    workspace: parsed,
  };

  // Should find existing job
  const existingJob = getJob(mergedConfig, "existing-job");
  assertEquals(existingJob?.description, "Exists");

  // Should return undefined for missing job
  const missingJob = getJob(mergedConfig, "non-existent");
  assertEquals(missingJob, undefined);

  // Should handle undefined jobs section
  const emptyConfig = {
    version: "1.0",
    workspace: { name: "test" },
  };
  const emptyParsed = WorkspaceConfigSchema.parse(emptyConfig);
  const emptyMerged: MergedConfig = {
    atlas: null,
    workspace: emptyParsed,
  };
  const noJobs = getJob(emptyMerged, "any");
  assertEquals(noJobs, undefined);
});

Deno.test("Edge Cases - getSignal helper should handle missing signals", () => {
  const config = {
    version: "1.0",
    workspace: { name: "test" },
    signals: {
      "existing-signal": {
        provider: "http",
        description: "Exists",
        config: { path: "/test" },
      },
    },
  };

  const parsed = WorkspaceConfigSchema.parse(config);

  // Create merged config for helper function
  const mergedConfig: MergedConfig = {
    atlas: null,
    workspace: parsed,
  };

  // Should find existing signal
  const existingSignal = getSignal(mergedConfig, "existing-signal");
  assertEquals(existingSignal?.description, "Exists");

  // Should return undefined for missing signal
  const missingSignal = getSignal(mergedConfig, "non-existent");
  assertEquals(missingSignal, undefined);
});

Deno.test("Edge Cases - getAgent helper should handle missing agents", () => {
  const config = {
    version: "1.0",
    workspace: { name: "test" },
    agents: {
      "existing-agent": {
        type: "llm",
        description: "Exists",
        config: {
          provider: "anthropic",
          model: "claude-3-5-haiku-latest",
          prompt: "Test",
        },
      },
    },
  };

  const parsed = WorkspaceConfigSchema.parse(config);

  // Create merged config for helper function
  const mergedConfig: MergedConfig = {
    atlas: null,
    workspace: parsed,
  };

  // Should find existing agent
  const existingAgent = getAgent(mergedConfig, "existing-agent");
  assertEquals(existingAgent?.description, "Exists");

  // Should return undefined for missing agent
  const missingAgent = getAgent(mergedConfig, "non-existent");
  assertEquals(missingAgent, undefined);
});

// Atlas Config Edge Cases
Deno.test("Edge Cases - should validate complex memory configuration", () => {
  // Test workspace memory config instead
  const complexMemory = {
    version: "1.0",
    workspace: {
      name: "Test Workspace",
    },
    memory: {
      enabled: true,
      scope: "workspace",
      retention: {
        max_age_days: 30,
        max_entries: 1000,
        cleanup_interval_hours: 24,
      },
      session: {
        include_in_context: true,
        max_context_entries: 100,
      },
      include_types: ["working", "procedural", "episodic"],
    },
  };

  const result = WorkspaceConfigSchema.safeParse(complexMemory);
  assertEquals(result.success, true);
});

Deno.test("Edge Cases - should accept any string for model names", () => {
  const supervisorConfig = {
    version: "1.0",
    workspace: {
      name: "Test",
    },
    supervisors: {
      workspace: {
        model: "any-model-name-123", // Should accept any string
        memory: "custom-memory-scope", // Should accept any string
        supervision: {
          level: "minimal",
          cache_enabled: true,
          timeouts: {
            analysis: "30s",
            validation: "10s",
          },
        },
        prompts: {},
      },
      session: {
        model: "another-model",
        supervision: {
          level: "standard",
          cache_enabled: true,
          timeouts: {
            analysis: "30s",
            validation: "10s",
          },
        },
        prompts: {},
      },
      agent: {
        model: "third-model",
        supervision: {
          level: "detailed",
          cache_enabled: true,
          timeouts: {
            analysis: "30s",
            validation: "10s",
          },
        },
        prompts: {},
      },
    },
  };

  // Test with atlas config since supervisors are only in atlas.yml
  const result = AtlasConfigSchema.safeParse(supervisorConfig);
  assertEquals(result.success, true);
});

// Tool Name Validation
Deno.test("Edge Cases - should validate MCP tool name constraints", () => {
  // Valid names
  const validNames = [
    "analyze-data",
    "process_info",
    "tool123",
    "UPPERCASE",
    "mix_Case-123",
  ];

  for (const name of validNames) {
    const config = {
      version: "1.0",
      workspace: { name: "test" },
      jobs: {
        [name]: {
          description: "Test",
          execution: {
            strategy: "sequential",
            agents: ["test"],
          },
        },
      },
    };

    const result = WorkspaceConfigSchema.safeParse(config);
    assertEquals(result.success, true, `Should accept job name: ${name}`);
  }

  // Invalid names
  const invalidNames = [
    "has spaces",
    "has!special",
    "has@symbol",
    "has.period",
    "has/slash",
  ];

  for (const name of invalidNames) {
    const config = {
      version: "1.0",
      workspace: { name: "test" },
      jobs: {
        [name]: {
          description: "Test",
          execution: {
            strategy: "sequential",
            agents: ["test"],
          },
        },
      },
    };

    const result = WorkspaceConfigSchema.safeParse(config);
    assertEquals(result.success, false, `Should reject job name: ${name}`);
  }
});

// Large Config Performance
Deno.test("Edge Cases - should handle large configurations efficiently", () => {
  const largeConfig = {
    version: "1.0",
    workspace: { name: "large-workspace" },
    agents: {} as Record<string, WorkspaceAgentConfig>,
    signals: {} as Record<string, WorkspaceSignalConfig>,
    jobs: {} as Record<string, JobSpecification>,
  };

  // Generate 100 agents
  for (let i = 0; i < 100; i++) {
    largeConfig.agents[`agent-${i}`] = {
      type: "llm",
      description: `Agent ${i}`,
      config: {
        provider: "anthropic",
        model: "claude-3-5-haiku-latest",
        prompt: `Prompt for agent ${i}`,
      },
    };
  }

  // Generate 50 signals
  for (let i = 0; i < 50; i++) {
    largeConfig.signals[`signal-${i}`] = {
      provider: "http",
      description: `Signal ${i}`,
      config: {
        path: `/webhook/${i}`,
      },
    };
  }

  // Generate 50 jobs
  for (let i = 0; i < 50; i++) {
    largeConfig.jobs[`job-${i}`] = {
      description: `Job ${i}`,
      execution: {
        strategy: "sequential",
        agents: [`agent-${i % 100}`],
      },
    };
  }

  const startTime = performance.now();
  const result = WorkspaceConfigSchema.safeParse(largeConfig);
  const endTime = performance.now();

  assertEquals(result.success, true);
  // Should parse in reasonable time (less than 1 second)
  assertEquals(endTime - startTime < 1000, true, "Parsing took too long");
});

// Schema Evolution
Deno.test("Edge Cases - should handle unknown fields gracefully", () => {
  const futureConfig = {
    version: "1.0",
    workspace: { name: "test" },
    futureFeature: "unknown", // Unknown field at root
    agents: {
      "test-agent": {
        type: "llm",
        description: "Test",
        config: {
          provider: "anthropic",
          model: "claude-3-5-haiku-latest",
          prompt: "Test",
          futureOption: true, // Unknown field in config
        },
      },
    },
  };

  // With strict schemas, unknown fields should cause parsing to fail
  const result = WorkspaceConfigSchema.safeParse(futureConfig);
  assertEquals(result.success, false);

  // Test that parsing succeeds when unknown fields are removed
  const cleanConfig = {
    version: "1.0",
    workspace: { name: "test" },
    agents: {
      "test-agent": {
        type: "llm",
        description: "Test",
        config: {
          provider: "anthropic",
          model: "claude-3-5-haiku-latest",
          prompt: "Test",
        },
      },
    },
  };

  const cleanResult = WorkspaceConfigSchema.safeParse(cleanConfig);
  assertEquals(cleanResult.success, true);
});
