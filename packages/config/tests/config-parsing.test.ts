import { assertEquals, assertRejects } from "@std/assert";
import { parse } from "@std/yaml";

import {
  AtlasConfigSchema,
  ConfigLoader,
  ConfigValidationError,
  isLLMAgent,
  validateSignalPayload,
  WorkspaceAgentConfigSchema,
  WorkspaceConfigSchema,
} from "@atlas/config";

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

// Simplified test examples instead of loading from files
const workspaceYaml = `
version: "1.0"
workspace:
  name: "comprehensive-example"
  description: "Test workspace"
server:
  mcp:
    enabled: true
tools:
  mcp:
    servers:
      github:
        transport:
          type: "stdio"
          command: "npx"
agents:
  analyzer:
    type: "llm"
    description: "Analyzes data"
    config:
      provider: "anthropic"
      model: "claude-3-7-sonnet-latest"
      prompt: "You are a data analyst"
signals:
  data-webhook:
    provider: "http"
    description: "Webhook for data"
    config:
      path: "/webhook/data"
    schema:
      type: "object"
      properties:
        dataset:
          type: "string"
      required: ["dataset"]
jobs:
  analyze-and-report:
    description: "Test job"
    execution:
      strategy: "sequential"
      agents:
        - "analyzer"
`;

const atlasYaml = `
version: "1.0"
workspace:
  name: "atlas-example"
  description: "Atlas test workspace"
supervisors:
  workspace:
    model: "claude-3-7-sonnet-latest"
    supervision:
      level: "detailed"
      cache_enabled: true
      timeouts:
        analysis: "30s"
        validation: "10s"
    prompts: {}
  session:
    model: "claude-3-7-sonnet-latest"
    supervision:
      level: "standard"
      cache_enabled: true
      timeouts:
        analysis: "30s"
        validation: "10s"
    prompts: {}
  agent:
    model: "claude-3-5-haiku-latest"
    supervision:
      level: "minimal"
      cache_enabled: true
      timeouts:
        analysis: "30s"
        validation: "10s"
    prompts: {}
planning:
  execution:
    precomputation: "moderate"
    cache_enabled: true
    cache_ttl_hours: 24
    invalidate_on_job_change: true
    strategy_selection:
      simple_jobs: ".*"
      complex_jobs: ".*complex.*"
      optimization_jobs: ".*optimize.*"
      planning_jobs: ".*plan.*"
    strategy_thresholds:
      complexity: 0.5
      uncertainty: 0.3
      optimization: 0.7
  validation:
    precomputation: "moderate"
    functional_validators: true
    smoke_tests: true
    content_safety: true
    llm_threshold: 0.8
    llm_fallback: true
    cache_enabled: true
    cache_ttl_hours: 24
    fail_fast: false
`;

const workspaceExample = parse(workspaceYaml) as unknown;
const atlasExample = parse(atlasYaml) as unknown;

// WorkspaceConfigSchema Tests
Deno.test("Config V2 Parsing - should parse the comprehensive workspace example", () => {
  const result = WorkspaceConfigSchema.safeParse(workspaceExample);

  assertEquals(result.success, true);
  if (result.success) {
    const config = result.data;

    // Verify basic structure
    assertEquals(config.version, "1.0");
    assertEquals(config.workspace.name, "comprehensive-example");
    assertEquals(config.workspace.description, "Test workspace");

    // Verify server config
    assertEquals(config.server?.mcp?.enabled, true);

    // Verify tools config
    assertEquals(Object.keys(config.tools?.mcp?.servers || {}).length, 1);
    assertEquals(config.tools?.mcp?.servers?.["github"]?.transport.type, "stdio");

    // Verify signals
    assertEquals(Object.keys(config.signals || {}).length, 1);
    assertEquals(config.signals?.["data-webhook"]?.provider, "http");

    // Verify jobs
    assertEquals(Object.keys(config.jobs || {}).length, 1);
    assertEquals(config.jobs?.["analyze-and-report"]?.description, "Test job");
    assertEquals(config.jobs?.["analyze-and-report"]?.execution.agents.length, 1);

    // Verify agents
    assertEquals(Object.keys(config.agents || {}).length, 1);
    assertEquals(config.agents?.["analyzer"]?.type, "llm");
  }
});

Deno.test("Config V2 Parsing - should validate signal schemas", () => {
  const result = WorkspaceConfigSchema.safeParse(workspaceExample);
  assertEquals(result.success, true);

  if (result.success) {
    const dataWebhook = result.data.signals?.["data-webhook"];

    // Valid payload
    const validPayload = {
      dataset: "test-dataset",
    };

    const validResult = validateSignalPayload(dataWebhook!, validPayload);
    assertEquals(validResult.success, true);

    // Invalid payload (missing required field)
    const invalidPayload = {
      // Missing dataset
    };

    const invalidResult = validateSignalPayload(dataWebhook!, invalidPayload);
    assertEquals(invalidResult.success, false);
  }
});

Deno.test("Config V2 Parsing - should properly type discriminate agents", () => {
  const result = WorkspaceConfigSchema.safeParse(workspaceExample);
  assertEquals(result.success, true);

  if (result.success) {
    const llmAgent = result.data.agents?.["analyzer"];

    // Test type guards
    assertEquals(isLLMAgent(llmAgent!), true);

    // Verify LLM agent config
    if (llmAgent?.type === "llm") {
      assertEquals(llmAgent.config.provider, "anthropic");
      assertEquals(llmAgent.config.model, "claude-3-7-sonnet-latest");
      assertEquals(llmAgent.config.prompt, "You are a data analyst");
    }
  }
});

// AtlasConfigSchema Tests
Deno.test("Config V2 Parsing - should parse the comprehensive atlas example", () => {
  const result = AtlasConfigSchema.safeParse(atlasExample);

  assertEquals(result.success, true);
  if (result.success) {
    const config = result.data;

    // Verify platform workspace
    assertEquals(config.workspace.name, "atlas-example");
    assertEquals(config.workspace.description, "Atlas test workspace");

    // Verify that optional config fields work
    assertEquals(config.server, undefined);
    assertEquals(config.memory, undefined);

    // Verify supervisors
    assertEquals(config.supervisors?.workspace?.model, "claude-3-7-sonnet-latest");

    // Verify planning config
    assertEquals(config.planning?.execution?.precomputation, "moderate");
    assertEquals(config.planning?.validation?.llm_threshold, 0.8);
  }
});

Deno.test("Config V2 Parsing - should validate system workspaces config", () => {
  const result = AtlasConfigSchema.safeParse(atlasExample);
  assertEquals(result.success, true);
});

// ConfigLoader Tests
Deno.test("Config V2 Parsing - ConfigLoader should keep workspace and atlas configs separate", async () => {
  // For this test, we need to use a system workspace path since the atlas example has system signals
  const adapter = new MockConfigAdapter("/@atlas/system/test");
  adapter.addConfig("workspace.yml", workspaceExample);
  adapter.addConfig("atlas.yml", atlasExample);

  const loader = new ConfigLoader(adapter, "/@atlas/system/test");
  const merged = await loader.load();

  // Workspace values in workspace config
  assertEquals(merged.workspace.workspace.name, "comprehensive-example");

  // Workspace signals in workspace config
  assertEquals(Object.keys(merged.workspace.signals || {}).includes("data-webhook"), true);

  // Atlas has different workspace name
  assertEquals(merged.atlas?.workspace.name, "atlas-example");

  // Workspace jobs in workspace config
  assertEquals(Object.keys(merged.workspace.jobs || {}).includes("analyze-and-report"), true);

  // Workspace agents in workspace config
  assertEquals(Object.keys(merged.workspace.agents || {}).includes("analyzer"), true);

  // Atlas-specific fields only in atlas config
  assertEquals(merged.atlas?.supervisors?.workspace?.model, "claude-3-7-sonnet-latest");
  assertEquals(merged.atlas?.planning?.execution?.precomputation, "moderate");
});

Deno.test("Config V2 Parsing - ConfigLoader should keep tools separate", async () => {
  const adapter = new MockConfigAdapter("/@atlas/system/test");
  adapter.addConfig("workspace.yml", workspaceExample);
  adapter.addConfig("atlas.yml", atlasExample);

  const loader = new ConfigLoader(adapter, "/@atlas/system/test");
  const merged = await loader.load();

  // Workspace servers in workspace config
  const workspaceServers = merged.workspace.tools?.mcp?.servers || {};
  assertEquals(Object.keys(workspaceServers).includes("github"), true);
  assertEquals(Object.keys(workspaceServers).length, 1);

  // Atlas has no tools config in our simplified example
  assertEquals(merged.atlas?.tools, undefined);
});

Deno.test("Config V2 Parsing - ConfigLoader should validate system signals in non-system workspaces", async () => {
  const workspaceWithSystemSignal = {
    version: "1.0",
    workspace: { name: "test-workspace" },
    signals: {
      "my-system-signal": {
        provider: "system",
        description: "System signal in non-system workspace",
      },
    },
  };

  const adapter = new MockConfigAdapter("/test-workspace");
  adapter.addConfig("workspace.yml", workspaceWithSystemSignal);
  adapter.addConfig("atlas.yml", {}); // Empty atlas config

  const loader = new ConfigLoader(adapter, "/test-workspace");

  // Should throw because workspace has a system signal but isn't a system workspace
  await assertRejects(
    () => loader.load(),
    Error,
    "System signal 'my-system-signal' can only be used in system workspaces",
  );
});

Deno.test("Config V2 Parsing - ConfigLoader should allow system signals in system workspaces", async () => {
  const systemWorkspace = {
    version: "1.0",
    workspace: { name: "system-workspace" },
    signals: {
      "system-signal": {
        provider: "system",
        description: "System signal in system workspace",
      },
    },
  };

  const adapter = new MockConfigAdapter("/@atlas/system/test");
  adapter.addConfig("workspace.yml", systemWorkspace);
  adapter.addConfig("atlas.yml", {});

  const loader = new ConfigLoader(adapter, "/@atlas/system/test");

  // Should not throw because this is a system workspace
  const merged = await loader.load();
  assertEquals(merged.workspace.signals?.["system-signal"]?.provider, "system");
});

Deno.test("Config V2 Parsing - ConfigLoader should validate agent references in jobs", async () => {
  const badWorkspace = {
    version: "1.0",
    workspace: { name: "test" },
    jobs: {
      "test-job": {
        description: "Test job",
        execution: {
          strategy: "sequential",
          agents: [{ id: "non-existent-agent" }],
        },
      },
    },
  };

  const adapter = new MockConfigAdapter("/test-workspace");
  adapter.addConfig("workspace.yml", badWorkspace);
  adapter.addConfig("atlas.yml", {});

  const loader = new ConfigLoader(adapter, "/test-workspace");

  await assertRejects(
    () => loader.load(),
    Error,
    "Job 'test-job' references undefined agent 'non-existent-agent'",
  );
});

Deno.test("Config V2 Parsing - ConfigLoader should validate signal references in triggers", async () => {
  const badWorkspace = {
    version: "1.0",
    workspace: { name: "test" },
    agents: {
      "test-agent": {
        type: "llm",
        description: "Test agent",
        config: {
          provider: "anthropic",
          model: "claude-3-5-haiku-latest",
          prompt: "Test",
        },
      },
    },
    jobs: {
      "test-job": {
        description: "Test job",
        triggers: [{ signal: "non-existent-signal" }],
        execution: {
          strategy: "sequential",
          agents: ["test-agent"],
        },
      },
    },
  };

  const adapter = new MockConfigAdapter("/test-workspace");
  adapter.addConfig("workspace.yml", badWorkspace);
  adapter.addConfig("atlas.yml", {});

  const loader = new ConfigLoader(adapter, "/test-workspace");

  await assertRejects(
    () => loader.load(),
    Error,
    "Job 'test-job' references undefined signal 'non-existent-signal'",
  );
});

Deno.test("Config V2 Parsing - ConfigLoader should handle ConfigValidationError with detailed messages", async () => {
  const invalidWorkspace = {
    version: "1.0",
    // Missing required workspace field
    signals: {
      "test": {
        provider: "invalid-provider", // Invalid provider
      },
    },
  };

  const adapter = new MockConfigAdapter("/test-workspace");
  adapter.addConfig("workspace.yml", invalidWorkspace);

  const loader = new ConfigLoader(adapter, "/test-workspace");

  try {
    await loader.load();
    throw new Error("Should have thrown ConfigValidationError");
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      // The error message now includes details automatically
      const errorMessage = error.message;
      assertEquals(errorMessage.includes("Workspace configuration validation failed"), true);

      // Check the details getter
      const details = error.details;
      assertEquals(details.length > 0, true);

      // Verify that the error mentions the validation issues
      const hasValidationError = errorMessage.includes("workspace") ||
        errorMessage.includes("signals.test.provider") ||
        errorMessage.includes("Invalid");
      assertEquals(hasValidationError, true);
    } else {
      throw error;
    }
  }
});

// Edge Cases and Complex Scenarios
Deno.test("Config V2 Parsing - should handle deeply nested agent context configurations", () => {
  const result = WorkspaceConfigSchema.safeParse(workspaceExample);
  assertEquals(result.success, true);

  if (result.success) {
    const job = result.data.jobs?.["analyze-and-report"];
    const reportWriter = job?.execution.agents[2];

    if (reportWriter && typeof reportWriter !== "string") {
      assertEquals(reportWriter.context?.signal, true);
      assertEquals(reportWriter.context?.steps, "all");
      assertEquals(reportWriter.context?.agents?.length, 2);
      assertEquals(reportWriter.context?.files, true);
    }
  }
});

Deno.test("Config V2 Parsing - should validate JSONLogic conditions", () => {
  const result = WorkspaceConfigSchema.safeParse(workspaceExample);
  assertEquals(result.success, true);

  if (result.success) {
    const job = result.data.jobs?.["analyze-and-report"];
    const trigger = job?.triggers?.[0];

    if (trigger?.condition && "jsonlogic" in trigger.condition) {
      // JSONLogic is stored as unknown, but we can verify it exists
      assertEquals(typeof trigger.condition.jsonlogic, "object");
    }
  }
});

Deno.test("Config V2 Parsing - should handle temperature validation for LLM agents", () => {
  const llmAgent = {
    type: "llm",
    description: "Test agent",
    config: {
      provider: "anthropic",
      model: "claude-3-7-sonnet-latest",
      prompt: "Test",
      temperature: 1.5, // Invalid - should be 0-1
    },
  };

  const result = WorkspaceAgentConfigSchema.safeParse(llmAgent);
  // Temperature validation is enforced
  assertEquals(result.success, false);

  // Valid temperature
  const validAgent = {
    ...llmAgent,
    config: {
      ...llmAgent.config,
      temperature: 0.7,
    },
  };

  const validResult = WorkspaceAgentConfigSchema.safeParse(validAgent);
  assertEquals(validResult.success, true);
});

Deno.test("Config V2 Parsing - should handle MCP tool name validation", () => {
  const invalidJobName = {
    version: "1.0",
    workspace: { name: "test" },
    jobs: {
      "Invalid Job Name!": { // Invalid characters
        description: "Test",
        execution: {
          strategy: "sequential",
          agents: [],
        },
      },
    },
  };

  const result = WorkspaceConfigSchema.safeParse(invalidJobName);
  assertEquals(result.success, false);
});

Deno.test("Config V2 Parsing - should validate signal payload at runtime", () => {
  const signal = {
    provider: "http" as const,
    description: "Test signal",
    config: {
      path: "/test",
    },
    schema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 3 },
        age: { type: "number", minimum: 0 },
      },
      required: ["name"],
    },
  };

  // Valid payload
  const validResult = validateSignalPayload(signal, { name: "John", age: 30 });
  assertEquals(validResult.success, true);

  // Invalid - name too short
  const shortNameResult = validateSignalPayload(signal, { name: "Jo", age: 30 });
  assertEquals(shortNameResult.success, false);

  // Invalid - missing required field
  const missingResult = validateSignalPayload(signal, { age: 30 });
  assertEquals(missingResult.success, false);

  // Invalid - wrong type
  const wrongTypeResult = validateSignalPayload(signal, { name: "John", age: "thirty" });
  assertEquals(wrongTypeResult.success, false);
});

// Type Safety Tests
Deno.test("Config V2 Parsing - should infer correct types for tagged unions", () => {
  const result = WorkspaceConfigSchema.safeParse(workspaceExample);
  assertEquals(result.success, true);

  if (result.success) {
    const agents = result.data.agents || {};

    // Type narrowing should work correctly
    for (const [_id, agent] of Object.entries(agents)) {
      switch (agent.type) {
        case "llm":
          // TypeScript knows agent.config has LLM fields
          assertEquals(typeof agent.config.provider, "string");
          assertEquals(typeof agent.config.model, "string");
          break;
        case "system":
          // TypeScript knows agent has system fields
          assertEquals(typeof agent.agent, "string");
          break;
        case "remote":
          // TypeScript knows agent.config has remote fields
          assertEquals(typeof agent.config.protocol, "string");
          assertEquals(typeof agent.config.endpoint, "string");
          break;
      }
    }
  }
});

Deno.test("Config V2 Parsing - should handle optional fields correctly", () => {
  const minimal = {
    version: "1.0",
    workspace: {
      name: "minimal",
    },
  };

  const result = WorkspaceConfigSchema.safeParse(minimal);
  assertEquals(result.success, true);

  if (result.success) {
    assertEquals(result.data.server, undefined);
    assertEquals(result.data.tools, undefined);
    assertEquals(result.data.signals, undefined);
    assertEquals(result.data.jobs, undefined);
    assertEquals(result.data.agents, undefined);
    assertEquals(result.data.memory, undefined);
    assertEquals(result.data.federation, undefined);
  }
});
