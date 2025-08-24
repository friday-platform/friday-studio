#!/usr/bin/env -S deno run --allow-env --allow-read

/**
 * Configuration architecture tests
 * Tests atlas.yml vs workspace.yml separation from docs/CONFIGURATION_ARCHITECTURE.md
 */

import { ConfigLoader } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";
import { expect } from "@std/expect";
import { join } from "@std/path";

// Test fixtures
const validAtlasConfig = `version: "1.0"

workspace:
  id: "atlas-platform"
  name: "Atlas Platform"
  description: "Test Atlas Platform"

agents:
  memory-agent:
    type: "llm"
    description: "Manages memory operations at session start and end"
    config:
      provider: "anthropic"
      model: "claude-3-7-sonnet-latest"
      prompt: |
        You are a memory management agent for Atlas workspaces.
      tools: ["memory-storage", "pattern-analysis", "context-retrieval"]

  security-scanner:
    type: "remote"
    description: "Analyzes content for security concerns and sensitive information"
    config:
      protocol: "acp"
      endpoint: "https://security-api.example.com/analyze"
      agent_name: "security-scanner"
      default_mode: "sync"
      timeout: "30s"
      max_retries: 3
      health_check_interval: "60s"
      auth:
        type: "bearer"
        token_env: "SECURITY_API_TOKEN"
      schema:
        validate_input: true
        validate_output: true
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

  system-synthesizer:
    type: "system"
    description: "Synthesizes multiple inputs into coherent summaries and analyses"
    agent: "content-synthesizer"
    config:
      model: "claude-3-7-sonnet-latest"
      temperature: 0.3

supervisors:
  workspace:
    model: "claude-3-7-sonnet-latest"
    supervision:
      level: "standard"
      cache_enabled: true
      parallel_llm_calls: true
    prompts:
      system: |
        You are a WorkspaceSupervisor responsible for orchestrating AI agent execution.
  session:
    model: "claude-3-7-sonnet-latest"
    supervision:
      level: "standard"
      cache_enabled: true
      parallel_llm_calls: true
    prompts:
      system: |
        You are a SessionSupervisor responsible for coordinating agent execution within a session.
  agent:
    model: "claude-3-7-sonnet-latest"
    supervision:
      level: "standard"
      cache_enabled: true
      parallel_llm_calls: true
    prompts:
      system: |
        You are an AgentSupervisor responsible for safe agent loading and execution.

memory:
  default:
    enabled: true
    storage: "local"
    cognitive_loop: true
    retention:
      max_age_days: 30
      max_entries: 1000
      cleanup_interval_hours: 24
  
  agent:
    enabled: true
    scope: "agent"
    include_in_context: true
    context_limits:
      relevant_memories: 2
      past_successes: 1
      past_failures: 1
    memory_types:
      working:
        enabled: true
        max_age_hours: 2
        max_entries: 50
  
  session:
    enabled: true
    scope: "session"
    include_in_context: true
    context_limits:
      relevant_memories: 5
      past_successes: 3
      past_failures: 2
    memory_types:
      working:
        enabled: true
        max_age_hours: 24
        max_entries: 100
  
  workspace:
    enabled: true
    scope: "workspace"
    include_in_context: false
    context_limits:
      relevant_memories: 10
      past_successes: 5
      past_failures: 3
    memory_types:
      episodic:
        enabled: true
        max_age_days: 90
        max_entries: 1000

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

const validWorkspaceConfig = `version: "1.0"

workspace:
  id: "7821d138-71a6-434c-bc64-10addcf33532"
  name: "Test Workspace"
  description: "A test workspace for configuration validation"

# Top-level job definitions
jobs:
  test-job:
    name: "test-job"
    description: "Test job specification"
    triggers:
      - signal: "test-signal"
        condition:
          prompt: "message && message.length > 0"
    execution:
      strategy: "sequential"
      agents:
        - id: "test-llm-agent"
        - id: "test-system-agent"

agents:
  test-llm-agent:
    type: "llm"
    description: "Test LLM agent for configuration testing"
    config:
      provider: "anthropic"
      model: "claude-3-7-sonnet-latest"
      prompt: |
        You are a test agent for configuration validation.
      tools: ["text-analysis", "processing"]

  test-system-agent:
    type: "system"
    description: "Test system agent"
    agent: "test-agent"
    config:
      model: "claude-3-7-sonnet-latest"
      temperature: 0.8

  test-remote-agent:
    type: "remote"
    description: "Test remote agent"
    config:
      protocol: "acp"
      endpoint: "https://api.test.com/agent"
      agent_name: "test-agent"
      default_mode: "sync"
      timeout: "15s"
      max_retries: 2
      auth:
        type: "bearer"
        token_env: "TEST_API_TOKEN"
      schema:
        validate_input: false
        validate_output: false

signals:
  test-signal:
    description: "Test signal for configuration testing"
    provider: "http"
    config:
      path: "/test-signal"
      timeout: "30s"
    schema:
      type: "object"
      properties:
        message:
          type: "string"
          description: "Test message"
      required: ["message"]
`;

// Job specifications are now defined in workspace.yml top-level jobs section

// Helper function to create test environment
async function createTestEnvironment() {
  const tempDir = await Deno.makeTempDir({ prefix: "atlas-config-test-" });

  // Write atlas.yml
  await Deno.writeTextFile(join(tempDir, "atlas.yml"), validAtlasConfig);

  // Write workspace.yml
  await Deno.writeTextFile(join(tempDir, "workspace.yml"), validWorkspaceConfig);

  // No need to create separate job files - jobs are now in workspace.yml

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

    const adapter = new FilesystemConfigAdapter(tempDir);
    const configLoader = new ConfigLoader(adapter, tempDir);
    const mergedConfig = await configLoader.load();

    // Atlas config should be loaded
    expect(mergedConfig.atlas).not.toBeNull();

    // Test atlas config structure
    expect(mergedConfig.atlas!.version).toBe("1.0");
    expect(mergedConfig.atlas!.workspace.name).toBe("Atlas Platform");
    expect(mergedConfig.atlas!.workspace.id).toBe("atlas-platform");

    // Test supervisor configurations
    expect(mergedConfig.atlas?.supervisors?.workspace?.model).toBe("claude-3-7-sonnet-latest");
    expect(mergedConfig.atlas?.supervisors?.session?.model).toBe("claude-3-7-sonnet-latest");
    expect(mergedConfig.atlas?.supervisors?.agent?.model).toBe("claude-3-7-sonnet-latest");

    // Test supervisor prompts exist
    expect(mergedConfig.atlas?.supervisors?.workspace?.prompts?.system).toContain(
      "WorkspaceSupervisor",
    );
    expect(mergedConfig.atlas?.supervisors?.session?.prompts?.system).toContain(
      "SessionSupervisor",
    );
    expect(mergedConfig.atlas?.supervisors?.agent?.prompts?.system).toContain("AgentSupervisor");

    // Test platform agents exist
    expect(typeof mergedConfig.atlas?.agents).toBe("object");
    const agentKeys = Object.keys(mergedConfig.atlas?.agents || {});
    expect(agentKeys.length).toBe(3);
    expect(agentKeys.includes("memory-agent")).toBe(true);
    expect(agentKeys.includes("security-scanner")).toBe(true);
    expect(agentKeys.includes("system-synthesizer")).toBe(true);

    // Test runtime configuration is in atlas config
    expect(mergedConfig.atlas?.runtime?.server?.port).toBe(8080);
    expect(mergedConfig.atlas?.runtime?.server?.host).toBe("localhost");
    expect(mergedConfig.atlas?.runtime?.logging?.level).toBe("info");
    expect(mergedConfig.atlas?.runtime?.logging?.format).toBe("pretty");
    expect(mergedConfig.atlas?.runtime?.persistence?.type).toBe("local");
    expect(mergedConfig.atlas?.runtime?.persistence?.path).toBe("./.atlas");
    expect(mergedConfig.atlas?.runtime?.security?.cors).toBe("*");
  } finally {
    Deno.chdir(originalCwd);
    if (tempDir) {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
});

Deno.test("Workspace configuration loads user-defined components", async () => {
  // Test workspace.yml loading for user-specific components
  // - Agent definitions (Tempest, LLM, Remote)
  // - Signal configurations and providers
  // - Job references and mappings
  const originalCwd = Deno.cwd();
  let tempDir: string | null = null;

  try {
    tempDir = await createTestEnvironment();
    Deno.chdir(tempDir);

    const adapter = new FilesystemConfigAdapter(tempDir);
    const configLoader = new ConfigLoader(adapter, tempDir);
    const mergedConfig = await configLoader.load();
    const workspaceConfig = mergedConfig.workspace;

    // Test workspace metadata
    expect(workspaceConfig.workspace.id).toBe("7821d138-71a6-434c-bc64-10addcf33532");
    expect(workspaceConfig.workspace.name).toBe("Test Workspace");
    expect(workspaceConfig.workspace.description).toBe(
      "A test workspace for configuration validation",
    );

    // Test agent definitions
    expect(workspaceConfig.agents).toBeDefined();
    expect(workspaceConfig.agents!["test-llm-agent"].type).toBe("llm");
    const llmAgent = workspaceConfig.agents!["test-llm-agent"];
    if (llmAgent?.type === "llm") {
      expect(llmAgent.config?.model).toBe("claude-3-7-sonnet-latest");
      expect(llmAgent.description).toBe("Test LLM agent for configuration testing");
    }

    expect(workspaceConfig.agents!["test-system-agent"].type).toBe("system");
    const systemAgent = workspaceConfig.agents!["test-system-agent"];
    if (systemAgent?.type === "system") {
      expect(systemAgent.agent).toBe("test-agent");
      expect(systemAgent.description).toBe("Test system agent");
    }

    expect(workspaceConfig.agents!["test-remote-agent"].type).toBe("remote");
    const remoteAgent = workspaceConfig.agents!["test-remote-agent"];
    if (remoteAgent?.type === "remote") {
      expect(remoteAgent.config.protocol).toBe("acp");
      expect(remoteAgent.config.endpoint).toBe("https://api.test.com/agent");
      expect(remoteAgent.config.agent_name).toBe("test-agent");
    }

    // Test signals (no longer have jobs field in job-owns-relationship)
    expect(Object.keys(workspaceConfig.signals!).length).toBe(1);
    expect(workspaceConfig.signals!["test-signal"]).toBeDefined();
    expect(workspaceConfig.signals!["test-signal"].provider).toBe("http");
    expect((workspaceConfig.signals!["test-signal"] as { jobs?: unknown }).jobs).toBeUndefined();

    // Test runtime configuration is NOT in workspace config (moved to atlas)
    expect((workspaceConfig as { runtime?: unknown }).runtime).toBeUndefined();
  } finally {
    Deno.chdir(originalCwd);
    if (tempDir) {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
});

Deno.test("Configuration merging combines atlas and workspace configs", async () => {
  // Test configuration hierarchy and merging
  // - Atlas config provides platform defaults
  // - Workspace config overrides where appropriate
  // - Validation ensures compatibility
  const originalCwd = Deno.cwd();
  let tempDir: string | null = null;

  try {
    tempDir = await createTestEnvironment();
    Deno.chdir(tempDir);

    const adapter = new FilesystemConfigAdapter(tempDir);
    const configLoader = new ConfigLoader(adapter, tempDir);
    const mergedConfig = await configLoader.load();

    // Verify atlas config is loaded
    expect(mergedConfig.atlas?.workspace.name).toBe("Atlas Platform");
    expect(mergedConfig.atlas?.supervisors?.workspace?.model).toBe("claude-3-7-sonnet-latest");

    // Verify workspace config is loaded
    expect(mergedConfig.workspace.workspace.name).toBe("Test Workspace");
    expect(Object.keys(mergedConfig.workspace.agents!).length).toBe(3);
    expect(Object.keys(mergedConfig.workspace.signals!).length).toBe(1);

    // Verify jobs are loaded
    expect(Object.keys(mergedConfig.workspace.jobs!).length).toBe(1);
    expect(mergedConfig.workspace.jobs!["test-job"]).toBeDefined();
    expect(mergedConfig.workspace.jobs!["test-job"].name).toBe("test-job");
    expect(mergedConfig.workspace.jobs!["test-job"].execution?.strategy).toBe("sequential");

    // Verify agent references in jobs are valid
    const testJob = mergedConfig.workspace.jobs!["test-job"];
    if (testJob.execution?.agents) {
      for (const agentRef of testJob.execution.agents) {
        const agentId = typeof agentRef === "string" ? agentRef : agentRef.id;
        const agentExists =
          mergedConfig.workspace.agents![agentId] || mergedConfig.atlas?.agents?.[agentId];
        expect(agentExists).toBeDefined();
      }
    }
  } finally {
    Deno.chdir(originalCwd);
    if (tempDir) {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
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

    const adapter = new FilesystemConfigAdapter(tempDir);
    const configLoader = new ConfigLoader(adapter, tempDir);
    const mergedConfig = await configLoader.load();

    // Test workspace agents of different types
    const workspaceAgents = mergedConfig.workspace.agents!;

    // Test LLM agent validation
    const llmAgent = workspaceAgents["test-llm-agent"];
    expect(llmAgent.type).toBe("llm");
    if (llmAgent.type === "llm") {
      expect(llmAgent.config.model).toBe("claude-3-7-sonnet-latest");
      expect(llmAgent.description).toBeDefined();
      expect(llmAgent.config.tools).toBeDefined();
    }

    // Test System agent validation
    const systemAgent = workspaceAgents["test-system-agent"];
    expect(systemAgent.type).toBe("system");
    if (systemAgent.type === "system") {
      expect(systemAgent.agent).toBe("test-agent");
      expect(systemAgent.description).toBeDefined();
    }

    // Test Remote agent validation
    const remoteAgent = workspaceAgents["test-remote-agent"];
    expect(remoteAgent.type).toBe("remote");
    if (remoteAgent.type === "remote") {
      expect(remoteAgent.config.endpoint).toBe("https://api.test.com/agent");
      expect(remoteAgent.description).toBeDefined();
      expect(remoteAgent.config.auth).toBeDefined();
    }

    // Test atlas agents of different types
    const atlasAgents = mergedConfig.atlas?.agents;

    // Find LLM agent in atlas
    const atlasLlmAgent = atlasAgents?.["memory-agent"];
    expect(atlasLlmAgent?.type).toBe("llm");
    if (atlasLlmAgent?.type === "llm") {
      expect(atlasLlmAgent.config.model).toBeDefined();
    }

    // Find Remote agent in atlas
    const atlasRemoteAgent = atlasAgents?.["security-scanner"];
    expect(atlasRemoteAgent?.type).toBe("remote");
    if (atlasRemoteAgent?.type === "remote") {
      expect(atlasRemoteAgent.config.protocol).toBe("acp");
      expect(atlasRemoteAgent.config.endpoint).toBeDefined();
      expect(atlasRemoteAgent.config.agent_name).toBe("security-scanner");
    }

    // Find System agent in atlas
    const atlasSystemAgent = atlasAgents?.["system-synthesizer"];
    expect(atlasSystemAgent?.type).toBe("system");
    if (atlasSystemAgent?.type === "system") {
      expect(atlasSystemAgent.agent).toBe("content-synthesizer");
      expect(atlasSystemAgent.description).toBeDefined();
    }
  } finally {
    Deno.chdir(originalCwd);
    if (tempDir) {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
});

Deno.test("Job-owns-relationship architecture: triggers field is preserved", async () => {
  // REGRESSION TEST: Ensure job triggers are loaded and preserved
  // Guards against silent loss of triggers field from JobSpecification normalization
  const originalCwd = Deno.cwd();
  let tempDir: string | null = null;

  try {
    tempDir = await createTestEnvironment();
    Deno.chdir(tempDir);

    const adapter = new FilesystemConfigAdapter(tempDir);
    const configLoader = new ConfigLoader(adapter, tempDir);
    const mergedConfig = await configLoader.load();

    // Test that job triggers are loaded from workspace.yml
    expect(mergedConfig.workspace.jobs!["test-job"]).toBeDefined();
    const testJob = mergedConfig.workspace.jobs!["test-job"];

    // CRITICAL: triggers field must be present and populated
    expect(testJob.triggers).toBeDefined();
    expect(Array.isArray(testJob.triggers)).toBe(true);
    expect(testJob.triggers!.length).toBe(1);

    // Verify trigger structure
    const trigger = testJob.triggers![0];
    expect(trigger.signal).toBe("test-signal");
    expect(trigger.condition).toBeDefined();

    // Verify signal-to-job mapping works via triggers
    const signalId = "test-signal";
    const jobsForSignal = Object.values(mergedConfig.workspace.jobs!).filter((job) =>
      job.triggers?.some((t) => t.signal === signalId),
    );
    expect(jobsForSignal.length).toBe(1);
    expect(jobsForSignal[0].name).toBe("test-job");
  } finally {
    Deno.chdir(originalCwd);
    if (tempDir) {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
});

Deno.test("Remote agent protocol validation", async () => {
  // Test remote agent protocol field validation
  // Ensures protocol is required at top-level for remote agents
  const originalCwd = Deno.cwd();
  let tempDir: string | null = null;

  try {
    tempDir = await createTestEnvironment();
    Deno.chdir(tempDir);

    const adapter = new FilesystemConfigAdapter(tempDir);
    const configLoader = new ConfigLoader(adapter, tempDir);
    const mergedConfig = await configLoader.load();

    // Test workspace remote agent
    const remoteAgent = mergedConfig.workspace.agents!["test-remote-agent"];
    expect(remoteAgent.type).toBe("remote");
    if (remoteAgent.type === "remote") {
      expect(remoteAgent.config.protocol).toBe("acp");
      expect(remoteAgent.config.endpoint).toBeDefined();
      expect(remoteAgent.config.agent_name).toBe("test-agent");
    }

    // Test atlas remote agent
    const atlasRemoteAgent = mergedConfig.atlas?.agents?.["security-scanner"];
    expect(atlasRemoteAgent?.type).toBe("remote");
    if (atlasRemoteAgent?.type === "remote") {
      expect(atlasRemoteAgent.config.protocol).toBe("acp");
      expect(atlasRemoteAgent.config.endpoint).toBeDefined();
      expect(atlasRemoteAgent.config.agent_name).toBe("security-scanner");
    }
  } finally {
    Deno.chdir(originalCwd);
    if (tempDir) {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
});

Deno.test("Remote agent validation catches missing protocol", async () => {
  // Test that missing protocol field is caught during validation
  const originalCwd = Deno.cwd();
  let tempDir: string | null = null;

  try {
    tempDir = await Deno.makeTempDir({ prefix: "atlas-config-protocol-test-" });

    // Create atlas.yml (valid)
    await Deno.writeTextFile(join(tempDir, "atlas.yml"), validAtlasConfig);

    // Create workspace.yml with remote agent missing protocol
    const invalidWorkspaceContent = `version: "1.0"
workspace:
  id: "7821d138-71a6-434c-bc64-10addcf33532"
  name: "Test Workspace"
  description: "Test workspace for protocol validation"

jobs:
  test-job:
    name: "test-job"
    description: "Test job"
    triggers:
      - signal: "test-signal"
        condition:
          prompt: "always trigger"
    execution:
      strategy: "sequential"
      agents:
        - id: "invalid-remote-agent"

agents:
  invalid-remote-agent:
    type: "remote"
    description: "Test remote agent without protocol"
    config:
      # MISSING: protocol field
      endpoint: "https://api.test.com/agent"
      agent_name: "test-agent"

signals:
  test-signal:
    description: "Test signal"
    provider: "http"
    config:
      path: "/test"
`;

    await Deno.writeTextFile(join(tempDir, "workspace.yml"), invalidWorkspaceContent);
    Deno.chdir(tempDir);

    const adapter = new FilesystemConfigAdapter(tempDir);
    const configLoader = new ConfigLoader(adapter, tempDir);

    // Test that validation catches missing protocol
    let errorCaught = false;
    try {
      await configLoader.load();
    } catch (error) {
      errorCaught = true;
      expect(error).toBeInstanceOf(Error);
      const errorMessage = (error as Error).message.toLowerCase();
      // Should catch validation error related to protocol field
      expect(
        errorMessage.includes("validation") ||
          errorMessage.includes("invalid") ||
          errorMessage.includes("expected"),
      ).toBe(true);
    }

    expect(errorCaught).toBe(true);
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
  invalid-llm-agent:
    type: "llm"      # Missing required config.model field
    description: "Test agent"
    config:
      provider: "anthropic"
      # Missing model field
      prompt: "Test prompt"
  invalid-remote-agent:
    type: "remote"   # Missing required config.protocol and config.agent_name fields
    description: "Test remote agent"
    config:
      endpoint: "https://api.test.com"
      # Missing protocol and agent_name fields
signals:
  test-signal:
    description: "Test signal"
    provider: "http"
    config:
      path: "/test"
`;

    await Deno.writeTextFile(join(tempDir, "workspace.yml"), invalidWorkspaceContent);
    Deno.chdir(tempDir);

    const adapter = new FilesystemConfigAdapter(tempDir);
    const configLoader = new ConfigLoader(adapter, tempDir);

    // Test that validation catches errors
    let errorCaught = false;
    try {
      await configLoader.load();
    } catch (error) {
      errorCaught = true;
      console.log("Validation error caught:", error);
      expect(error).toBeInstanceOf(Error);
      const errorMessage = (error as Error).message.toLowerCase();
      // Should catch validation errors - check for common validation keywords
      expect(
        errorMessage.includes("validation") ||
          errorMessage.includes("invalid") ||
          errorMessage.includes("required") ||
          errorMessage.includes("model") ||
          errorMessage.includes("protocol"),
      ).toBe(true);
    }

    expect(errorCaught).toBe(true);
  } finally {
    Deno.chdir(originalCwd);
    if (tempDir) {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
});
