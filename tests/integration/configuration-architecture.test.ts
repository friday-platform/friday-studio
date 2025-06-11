#!/usr/bin/env -S deno run --allow-env --allow-read

/**
 * Configuration architecture tests
 * Tests atlas.yml vs workspace.yml separation from docs/CONFIGURATION_ARCHITECTURE.md
 */

import { expect } from "jsr:@std/expect";
import { ConfigLoader, ConfigValidationError } from "../../src/core/config-loader.ts";
import { join } from "@std/path";

// Test fixtures
const validAtlasConfig = `version: "1.0"

platform:
  name: "Atlas"
  version: "1.0.0"

agents:
  memory-agent:
    type: "llm"
    model: "claude-4-sonnet-20250514"
    purpose: "Manages memory operations at session start and end"
    tools: ["memory-storage", "pattern-analysis", "context-retrieval"]
    prompts:
      system: |
        You are a memory management agent for Atlas workspaces.

  security-scanner:
    type: "remote"
    endpoint: "https://security-api.example.com/analyze"
    purpose: "Analyzes content for security concerns and sensitive information"
    auth:
      type: "bearer"
      token_env: "SECURITY_API_TOKEN"
    timeout: 30000
    schema:
      input:
        type: "object"
        properties:
          content:
            type: "string"
            description: "Content to analyze for security issues"
        required: ["content"]
      output:
        type: "object"
        properties:
          risk_score:
            type: "number"
            minimum: 0
            maximum: 10

  tempest-synthesizer:
    type: "tempest"
    agent: "content-synthesizer"
    version: "2.1.0"
    purpose: "Synthesizes multiple inputs into coherent summaries and analyses"
    config:
      synthesis_modes: ["comprehensive", "summary", "analytical"]

supervisors:
  workspace:
    model: "claude-4-sonnet-20250514"
    prompts:
      system: |
        You are a WorkspaceSupervisor responsible for orchestrating AI agent execution.
  session:
    model: "claude-4-sonnet-20250514"
    prompts:
      system: |
        You are a SessionSupervisor responsible for coordinating agent execution within a session.
  agent:
    model: "claude-4-sonnet-20250514"
    prompts:
      system: |
        You are an AgentSupervisor responsible for safe agent loading and execution.
`;

const validWorkspaceConfig = `version: "1.0"

workspace:
  id: "7821d138-71a6-434c-bc64-10addcf33532"
  name: "Test Workspace"
  description: "A test workspace for configuration validation"

agents:
  test-llm-agent:
    type: "llm"
    model: "claude-4-sonnet-20250514"
    purpose: "Test LLM agent for configuration testing"
    tools: ["text-analysis", "processing"]
    prompts:
      system: |
        You are a test agent for configuration validation.

  test-tempest-agent:
    type: "tempest"
    agent: "test-agent"
    version: "1.0.0"
    purpose: "Test Tempest agent"
    config:
      test_mode: true

  test-remote-agent:
    type: "remote"
    endpoint: "https://api.test.com/agent"
    purpose: "Test remote agent"
    auth:
      type: "bearer"
      token_env: "TEST_API_TOKEN"
    timeout: 15000

signals:
  test-signal:
    description: "Test signal for configuration testing"
    provider: "cli"
    schema:
      type: "object"
      properties:
        message:
          type: "string"
          description: "Test message"
      required: ["message"]
    jobs:
      - name: "test-job"
        condition: "message && message.length > 0"
        job: "./jobs/test-job.yml"

runtime:
  server:
    port: 8080
    host: "localhost"
  logging:
    level: "info"
    format: "pretty"
  persistence:
    type: "local"
    path: "./.atlas"
  security:
    cors: "*"
`;

const validJobSpec = `job:
  name: "test-job"
  description: "Test job specification"

  execution:
    strategy: "sequential"
    agents:
      - id: "test-llm-agent"
      - id: "test-tempest-agent"
`;

// Helper function to create test environment
async function createTestEnvironment() {
  const tempDir = await Deno.makeTempDir({ prefix: "atlas-config-test-" });

  // Write atlas.yml
  await Deno.writeTextFile(join(tempDir, "atlas.yml"), validAtlasConfig);

  // Write workspace.yml
  await Deno.writeTextFile(join(tempDir, "workspace.yml"), validWorkspaceConfig);

  // Create jobs directory and write job spec
  const jobsDir = join(tempDir, "jobs");
  await Deno.mkdir(jobsDir);
  await Deno.writeTextFile(join(jobsDir, "test-job.yml"), validJobSpec);

  return tempDir;
}

// Configuration loading and validation tests

Deno.test("Atlas configuration loads platform settings", async () => {
  // Test atlas.yml loading for platform-managed components
  // - WorkspaceSupervisor model and capabilities
  // - SessionSupervisor prompts and configuration
  // - Platform-level security and resource settings
  const originalCwd = Deno.cwd();
  let tempDir: string | null = null;

  try {
    tempDir = await createTestEnvironment();
    Deno.chdir(tempDir);

    const configLoader = new ConfigLoader();
    const mergedConfig = await configLoader.load();

    // Test atlas config structure
    expect(mergedConfig.atlas.version).toBe("1.0");
    expect(mergedConfig.atlas.platform.name).toBe("Atlas");
    expect(mergedConfig.atlas.platform.version).toBe("1.0.0");

    // Test supervisor configurations
    expect(mergedConfig.atlas.supervisors.workspace.model).toBe("claude-4-sonnet-20250514");
    expect(mergedConfig.atlas.supervisors.session.model).toBe("claude-4-sonnet-20250514");
    expect(mergedConfig.atlas.supervisors.agent.model).toBe("claude-4-sonnet-20250514");

    // Test supervisor prompts exist
    expect(mergedConfig.atlas.supervisors.workspace.prompts.system).toContain(
      "WorkspaceSupervisor",
    );
    expect(mergedConfig.atlas.supervisors.session.prompts.system).toContain("SessionSupervisor");
    expect(mergedConfig.atlas.supervisors.agent.prompts.system).toContain("AgentSupervisor");

    // Test platform agents exist
    expect(typeof mergedConfig.atlas.agents).toBe("object");
    const agentKeys = Object.keys(mergedConfig.atlas.agents);
    expect(agentKeys.length).toBe(3);
    expect(agentKeys.includes("memory-agent")).toBe(true);
    expect(agentKeys.includes("security-scanner")).toBe(true);
    expect(agentKeys.includes("tempest-synthesizer")).toBe(true);
  } finally {
    Deno.chdir(originalCwd);
    if (tempDir) {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
});

Deno.test(
  "Workspace configuration loads user-defined components",
  async () => {
    // Test workspace.yml loading for user-specific components
    // - Agent definitions (Tempest, LLM, Remote)
    // - Signal configurations and providers
    // - Job references and mappings
    const originalCwd = Deno.cwd();
    let tempDir: string | null = null;

    try {
      tempDir = await createTestEnvironment();
      Deno.chdir(tempDir);

      const configLoader = new ConfigLoader();
      const mergedConfig = await configLoader.load();
      const workspaceConfig = mergedConfig.workspace;

      // Test workspace metadata
      expect(workspaceConfig.workspace.id).toBe("7821d138-71a6-434c-bc64-10addcf33532");
      expect(workspaceConfig.workspace.name).toBe("Test Workspace");
      expect(workspaceConfig.workspace.description).toBe(
        "A test workspace for configuration validation",
      );

      // Test agent definitions
      expect(workspaceConfig.agents["test-llm-agent"].type).toBe("llm");
      expect(workspaceConfig.agents["test-llm-agent"].model).toBe("claude-4-sonnet-20250514");
      expect(workspaceConfig.agents["test-llm-agent"].purpose).toBe(
        "Test LLM agent for configuration testing",
      );

      expect(workspaceConfig.agents["test-tempest-agent"].type).toBe("tempest");
      expect(workspaceConfig.agents["test-tempest-agent"].agent).toBe("test-agent");
      expect(workspaceConfig.agents["test-tempest-agent"].version).toBe("1.0.0");

      expect(workspaceConfig.agents["test-remote-agent"].type).toBe("remote");
      expect(workspaceConfig.agents["test-remote-agent"].endpoint).toBe(
        "https://api.test.com/agent",
      );

      // Test signals
      expect(Object.keys(workspaceConfig.signals).length).toBe(1);
      expect(workspaceConfig.signals["test-signal"]).toBeDefined();
      expect(workspaceConfig.signals["test-signal"].provider).toBe("cli");
      expect(workspaceConfig.signals["test-signal"].jobs.length).toBe(1);

      // Test runtime configuration
      expect(workspaceConfig.runtime?.server?.port).toBe(8080);
      expect(workspaceConfig.runtime?.logging?.level).toBe("info");
      expect(workspaceConfig.runtime?.persistence?.type).toBe("local");
    } finally {
      Deno.chdir(originalCwd);
      if (tempDir) {
        await Deno.remove(tempDir, { recursive: true });
      }
    }
  },
);

Deno.test(
  "Configuration merging combines atlas and workspace configs",
  async () => {
    // Test configuration hierarchy and merging
    // - Atlas config provides platform defaults
    // - Workspace config overrides where appropriate
    // - Validation ensures compatibility
    const originalCwd = Deno.cwd();
    let tempDir: string | null = null;

    try {
      tempDir = await createTestEnvironment();
      Deno.chdir(tempDir);

      const configLoader = new ConfigLoader();
      const mergedConfig = await configLoader.load();

      // Verify atlas config is loaded
      expect(mergedConfig.atlas.platform.name).toBe("Atlas");
      expect(mergedConfig.atlas.supervisors.workspace.model).toBe("claude-4-sonnet-20250514");

      // Verify workspace config is loaded
      expect(mergedConfig.workspace.workspace.name).toBe("Test Workspace");
      expect(Object.keys(mergedConfig.workspace.agents).length).toBe(3);
      expect(Object.keys(mergedConfig.workspace.signals).length).toBe(1);

      // Verify jobs are loaded
      expect(Object.keys(mergedConfig.jobs).length).toBe(1);
      expect(mergedConfig.jobs["test-job"]).toBeDefined();
      expect(mergedConfig.jobs["test-job"].name).toBe("test-job");
      expect(mergedConfig.jobs["test-job"].execution?.strategy).toBe("sequential");

      // Verify agent references in jobs are valid
      const testJob = mergedConfig.jobs["test-job"];
      if (testJob.execution?.agents) {
        for (const agentRef of testJob.execution.agents) {
          const agentId = typeof agentRef === "string" ? agentRef : agentRef.id;
          const agentExists = mergedConfig.workspace.agents[agentId] ||
            mergedConfig.atlas.agents[agentId];
          expect(agentExists).toBeDefined();
        }
      }
    } finally {
      Deno.chdir(originalCwd);
      if (tempDir) {
        await Deno.remove(tempDir, { recursive: true });
      }
    }
  },
);

Deno.test.ignore("Job specifications define execution patterns", async () => {
  // Test job file loading and validation
  // - Job specification schema validation
  // - Multi-stage execution strategy parsing
  // - Agent reference validation against workspace
  // const jobLoader = new JobLoader();
  // const jobSpec = await jobLoader.loadJob("./jobs/frontend-pr-review.yml");
  // assertEquals(jobSpec.job.name, "frontend-pr-review");
  // assertEquals(jobSpec.job.execution.strategy, "parallel-then-sequential");
  // assertEquals(jobSpec.job.execution.stages.length >= 2, true);
});

Deno.test.ignore("Signal-to-job mapping validates conditions", async () => {
  // Test signal configuration with job references
  // - M:M signal-job relationships
  // - Condition evaluation logic
  // - Job file resolution and validation
  // const configLoader = new ConfigLoader();
  // const workspaceConfig = await configLoader.loadWorkspaceConfig("./test-workspace.yml");
  // const githubSignal = workspaceConfig.signals["github-pr"];
  // assertEquals(githubSignal.jobs.length >= 2, true);
  // assertEquals(githubSignal.jobs[0].condition.includes("frontend"), true);
  // assertEquals(githubSignal.jobs[0].job.endsWith(".yml"), true);
});

Deno.test("Agent type configurations validate correctly", async () => {
  // Test different agent type validation
  // - Tempest agent catalog references
  // - LLM agent model and tool configuration
  // - Remote agent endpoint and schema validation
  const originalCwd = Deno.cwd();
  let tempDir: string | null = null;

  try {
    tempDir = await createTestEnvironment();
    Deno.chdir(tempDir);

    const configLoader = new ConfigLoader();
    const mergedConfig = await configLoader.load();

    // Test workspace agents of different types
    const workspaceAgents = mergedConfig.workspace.agents;

    // Test LLM agent validation
    const llmAgent = workspaceAgents["test-llm-agent"];
    expect(llmAgent.type).toBe("llm");
    expect(llmAgent.model).toBe("claude-4-sonnet-20250514");
    expect(llmAgent.purpose).toBeDefined();
    expect(llmAgent.tools).toBeDefined();

    // Test Tempest agent validation
    const tempestAgent = workspaceAgents["test-tempest-agent"];
    expect(tempestAgent.type).toBe("tempest");
    expect(tempestAgent.agent).toBe("test-agent");
    expect(tempestAgent.version).toBe("1.0.0");
    expect(tempestAgent.purpose).toBeDefined();

    // Test Remote agent validation
    const remoteAgent = workspaceAgents["test-remote-agent"];
    expect(remoteAgent.type).toBe("remote");
    expect(remoteAgent.endpoint).toBe("https://api.test.com/agent");
    expect(remoteAgent.purpose).toBeDefined();
    expect(remoteAgent.auth).toBeDefined();

    // Test atlas agents of different types
    const atlasAgents = mergedConfig.atlas.agents;

    // Find LLM agent in atlas
    const atlasLlmAgent = atlasAgents["memory-agent"];
    expect(atlasLlmAgent.type).toBe("llm");
    expect(atlasLlmAgent.model).toBeDefined();

    // Find Remote agent in atlas
    const atlasRemoteAgent = atlasAgents["security-scanner"];
    expect(atlasRemoteAgent.type).toBe("remote");
    expect(atlasRemoteAgent.endpoint).toBeDefined();

    // Find Tempest agent in atlas
    const atlasTempestAgent = atlasAgents["tempest-synthesizer"];
    expect(atlasTempestAgent.type).toBe("tempest");
    expect(atlasTempestAgent.agent).toBeDefined();
    expect(atlasTempestAgent.version).toBeDefined();
  } finally {
    Deno.chdir(originalCwd);
    if (tempDir) {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
});

Deno.test("Configuration validation catches errors", async () => {
  // Test comprehensive configuration validation
  // - Missing required fields
  // - Invalid agent references
  // - Malformed job specifications
  const originalCwd = Deno.cwd();
  let tempDir: string | null = null;

  try {
    tempDir = await Deno.makeTempDir({ prefix: "atlas-config-invalid-test-" });

    // Create atlas.yml (valid)
    await Deno.writeTextFile(join(tempDir, "atlas.yml"), validAtlasConfig);

    // Create invalid workspace.yml
    const invalidWorkspaceContent = `
version: "1.0"
workspace:
  id: "invalid-id"  # Invalid UUID
  name: ""          # Empty name
  description: "Test workspace"
agents:
  invalid-agent:
    type: "llm"      # Missing required model field
    purpose: "Test agent"
signals:
  test-signal:
    description: "Test signal"
    provider: "test"
    jobs: []         # Empty jobs array
`;

    await Deno.writeTextFile(join(tempDir, "workspace.yml"), invalidWorkspaceContent);
    Deno.chdir(tempDir);

    const configLoader = new ConfigLoader();

    // Test that validation catches errors
    let errorCaught = false;
    try {
      await configLoader.load();
    } catch (error) {
      errorCaught = true;
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).message).toContain("Configuration validation failed");
    }

    expect(errorCaught).toBe(true);
  } finally {
    Deno.chdir(originalCwd);
    if (tempDir) {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
});

