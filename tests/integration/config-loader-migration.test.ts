#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write

/**
 * Integration tests for the migrated configuration loader
 * Tests the complete flow with real filesystem operations
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { ConfigLoader } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";

// Helper to create test environment
async function createTestEnvironment(): Promise<string> {
  const tempDir = await Deno.makeTempDir();

  // Create atlas.yml
  const atlasYml = `version: "1.0"

workspace:
  id: "atlas-platform"
  name: "Atlas Platform"
  description: "Test Atlas Platform"

server:
  mcp:
    enabled: true
    transport:
      type: "sse"
      url: "https://localhost:8080/mcp"

supervisors:
  workspace:
    model: "claude-3-5-sonnet-20241022"
    prompts:
      system: "You are a workspace supervisor"
  session:
    model: "claude-3-5-sonnet-20241022"
    prompts:
      system: "You are a session supervisor"
  agent:
    model: "claude-3-5-sonnet-20241022"
    prompts:
      system: "You are an agent supervisor"

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
`;

  await Deno.writeTextFile(join(tempDir, "atlas.yml"), atlasYml);

  // Create workspace.yml
  const workspaceYml = `version: "1.0"

workspace:
  name: "test-workspace"
  description: "Integration test workspace"

agents:
  test-llm-agent:
    type: "llm"
    model: "claude-3-5-haiku-20241022"
    purpose: "Test LLM agent"
    tools:
      mcp: ["filesystem", "memory"]
      workspace: ["workspace.memory.recall", "workspace.jobs.trigger"]
    
  test-tempest-agent:
    type: "tempest"
    agent: "k8s-operator"
    version: "1.0.0"
    purpose: "Test Tempest agent"
    config:
      namespace: "default"
      
  test-remote-agent:
    type: "remote"
    protocol: "mcp"
    endpoint: "https://api.example.com/agent"
    purpose: "Test remote agent"
    mcp:
      timeout_ms: 30000
      allowed_tools: ["read", "write"]

signals:
  webhook:
    description: "Test webhook signal"
    provider: "http"
    path: "/webhook"
    method: "POST"
    
  cli-signal:
    description: "Test CLI signal"
    provider: "cli"
    command: "test-command"

jobs:
  inline-job:
    name: "Inline Test Job"
    description: "Job defined in workspace.yml"
    execution:
      strategy: "sequential"
      agents: ["test-llm-agent"]
    triggers:
      - signal: "webhook"
        condition:
          "==": [{ "var": "event.type" }, "test"]
`;

  await Deno.writeTextFile(join(tempDir, "workspace.yml"), workspaceYml);

  // Create jobs directory with additional job files
  const jobsDir = join(tempDir, "jobs");
  await Deno.mkdir(jobsDir);

  const fileJob = `name: "File-based Job"
description: "Job loaded from file"
triggers:
  - signal: "cli-signal"
execution:
  strategy: "parallel"
  agents:
    - id: "test-llm-agent"
      task: "Analyze input"
      input_source: "signal"
    - id: "test-tempest-agent"
      task: "Process results"
      input_source: "previous"
      dependencies: ["test-llm-agent"]
  context:
    filesystem:
      patterns: ["**/*.ts", "**/*.yml"]
      base_path: "./src"
error_handling:
  max_retries: 3
  retry_delay_seconds: 10
  timeout_seconds: 300
`;

  await Deno.writeTextFile(join(jobsDir, "file-job.yml"), fileJob);

  return tempDir;
}

Deno.test("Integration: ConfigLoader with FilesystemAdapter - complete workflow", async () => {
  const tempDir = await createTestEnvironment();

  try {
    const adapter = new FilesystemConfigAdapter();
    const loader = new ConfigLoader(adapter, tempDir);
    const config = await loader.load();

    // Test atlas configuration
    expect(config.atlas).toBeDefined();
    expect(config.atlas.workspace.name).toBe("Atlas Platform");
    expect(config.atlas.supervisors.workspace.model).toBe("claude-3-5-sonnet-20241022");
    expect(config.atlas.memory).toBeDefined();
    expect(config.atlas.server?.mcp?.enabled).toBe(true);

    // Test workspace configuration
    expect(config.workspace).toBeDefined();
    expect(config.workspace.workspace.name).toBe("test-workspace");

    // Test agents
    expect(config.workspace.agents).toBeDefined();
    expect(Object.keys(config.workspace.agents)).toHaveLength(3);
    expect(config.workspace.agents["test-llm-agent"].type).toBe("llm");
    expect(config.workspace.agents["test-tempest-agent"].type).toBe("tempest");
    expect(config.workspace.agents["test-remote-agent"].type).toBe("remote");

    // Test signals
    expect(config.workspace.signals).toBeDefined();
    expect(Object.keys(config.workspace.signals)).toHaveLength(2);
    expect(config.workspace.signals["webhook"].provider).toBe("http");
    expect(config.workspace.signals["cli-signal"].provider).toBe("cli");

    // Test jobs - both inline and from files
    expect(config.jobs).toBeDefined();
    expect(Object.keys(config.jobs)).toHaveLength(2);
    expect(config.jobs["inline-job"].name).toBe("Inline Test Job");
    expect(config.jobs["file-job"].name).toBe("File-based Job");

    // Test job details
    const fileJob = config.jobs["file-job"];
    expect(fileJob.execution.strategy).toBe("parallel");
    expect(fileJob.execution.agents).toHaveLength(2);
    expect(fileJob.error_handling?.max_retries).toBe(3);

    // Test supervisor defaults
    expect(config.supervisorDefaults).toBeDefined();
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Integration: ConfigLoader handles missing atlas.yml", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    // Only create workspace.yml
    const workspaceYml = `version: "1.0"
workspace:
  name: "standalone-workspace"
agents: {}
signals: {}
`;
    await Deno.writeTextFile(join(tempDir, "workspace.yml"), workspaceYml);

    const adapter = new FilesystemConfigAdapter();
    const loader = new ConfigLoader(adapter, tempDir);
    const config = await loader.load();

    // Should use atlas defaults
    expect(config.atlas.workspace.name).toBe("Atlas Platform");
    expect(config.atlas.supervisors).toBeDefined();

    // Workspace should load normally
    expect(config.workspace.workspace.name).toBe("standalone-workspace");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Integration: ConfigLoader validates configurations", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    // Create invalid workspace.yml
    const invalidWorkspaceYml = `version: "1.0"
# Missing required 'workspace' field
agents:
  invalid-agent:
    type: "llm"
    # Missing required 'model' field for LLM agents
    purpose: "Invalid agent"
`;
    await Deno.writeTextFile(join(tempDir, "workspace.yml"), invalidWorkspaceYml);

    const adapter = new FilesystemConfigAdapter();
    const loader = new ConfigLoader(adapter, tempDir);

    await expect(loader.load()).rejects.toThrow("Configuration validation failed");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Integration: ConfigLoader merges supervisor defaults", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    // Create minimal atlas.yml without supervisors
    const minimalAtlasYml = `version: "1.0"
workspace:
  name: "Minimal Atlas"

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
`;
    await Deno.writeTextFile(join(tempDir, "atlas.yml"), minimalAtlasYml);

    const workspaceYml = `version: "1.0"
workspace:
  name: "test-workspace"
agents: {}
`;
    await Deno.writeTextFile(join(tempDir, "workspace.yml"), workspaceYml);

    const adapter = new FilesystemConfigAdapter();
    const loader = new ConfigLoader(adapter, tempDir);
    const config = await loader.load();

    // All supervisors should be from defaults since atlas.yml doesn't have them
    expect(config.atlas.supervisors).toBeDefined();
    expect(config.atlas.supervisors.workspace).toBeDefined();
    expect(config.atlas.supervisors.workspace.model).toBeDefined();
    expect(config.atlas.supervisors.workspace.prompts).toBeDefined();
    expect(config.atlas.supervisors.workspace.prompts.system).toContain("WorkspaceSupervisor");

    // Session and agent supervisors should also be from defaults
    expect(config.atlas.supervisors.session).toBeDefined();
    expect(config.atlas.supervisors.session.model).toBeDefined();
    expect(config.atlas.supervisors.session.prompts).toBeDefined();

    expect(config.atlas.supervisors.agent).toBeDefined();
    expect(config.atlas.supervisors.agent.model).toBeDefined();
    expect(config.atlas.supervisors.agent.prompts).toBeDefined();
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Integration: ConfigLoader handles complex job configurations", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    const jobsDir = join(tempDir, "jobs");
    await Deno.mkdir(jobsDir);

    // Create a complex job with all features
    const complexJob = `name: "Advanced Deployment Pipeline"
description: "Complex job with all configuration options"
task_template: "Deploy {{service}} to {{environment}} with rollback support"
triggers:
  - signal: "github-push"
    condition:
      and:
        - "==": [{ "var": "branch" }, "main"]
        - "contains": [{ "var": "files" }, "deploy/"]
  - signal: "manual-deploy"
session_prompts:
  planning: |
    Create a deployment plan that:
    1. Validates all prerequisites
    2. Performs canary deployment
    3. Monitors metrics
    4. Supports automatic rollback
  evaluation: |
    Verify deployment success by checking:
    - All pods are running
    - Health checks pass
    - No error rate increase
execution:
  strategy: "parallel"
  agents:
    - id: "validator"
      task: "Validate deployment manifests"
      input_source: "signal"
      tools: ["workspace.k8s.validate", "workspace.security.scan"]
    - id: "deployer"
      task: "Execute canary deployment"
      input_source: "combined"
      dependencies: ["validator"]
      tools: ["workspace.k8s.deploy", "workspace.k8s.rollout"]
    - id: "monitor"
      task: "Monitor deployment health"
      input_source: "filesystem_context"
      tools: ["workspace.metrics.query", "workspace.logs.search"]
  context:
    filesystem:
      patterns:
        - "k8s/**/*.yaml"
        - "config/production/*.json"
        - "deploy/scripts/*.sh"
      base_path: "./"
      max_file_size: 1048576
      include_content: true
    custom:
      environment: "production"
      region: "us-east-1"
      rollback_enabled: true
success_criteria:
  all_pods_healthy: true
  error_rate_below: 0.01
  response_time_p99_ms: 500
  canary_success_rate: 0.99
error_handling:
  max_retries: 2
  retry_delay_seconds: 60
  timeout_seconds: 900
resources:
  estimated_duration_seconds: 600
  max_memory_mb: 1024
  required_capabilities:
    - "k8s-production-access"
    - "metrics-read"
    - "deployment-write"
`;

    await Deno.writeTextFile(join(jobsDir, "complex-deployment.yml"), complexJob);

    // Create workspace.yml with agents and signals referenced by the job
    const workspaceYml = `version: "1.0"
workspace:
  name: "deployment-workspace"

agents:
  validator:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"
    purpose: "Validate deployment configurations"
  deployer:
    type: "tempest"
    agent: "k8s-deployer"
    version: "2.0.0"
    purpose: "Execute Kubernetes deployments"
  monitor:
    type: "llm"
    model: "claude-3-5-haiku-20241022"
    purpose: "Monitor deployment health"

signals:
  github-push:
    description: "GitHub push event"
    provider: "github"
    events: ["push"]
  manual-deploy:
    description: "Manual deployment trigger"
    provider: "cli"
`;
    await Deno.writeTextFile(join(tempDir, "workspace.yml"), workspaceYml);

    // Create atlas.yml with required memory configuration
    const atlasYml = `version: "1.0"
workspace:
  name: "Complex Jobs Atlas"

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
`;
    await Deno.writeTextFile(join(tempDir, "atlas.yml"), atlasYml);

    const adapter = new FilesystemConfigAdapter();
    const loader = new ConfigLoader(adapter, tempDir);
    const config = await loader.load();

    const job = config.jobs["complex-deployment"];
    expect(job).toBeDefined();
    expect(job.name).toBe("Advanced Deployment Pipeline");
    expect(job.triggers).toHaveLength(2);
    expect(job.triggers![0].condition).toBeDefined();
    expect(job.session_prompts).toBeDefined();
    expect(job.execution.agents).toHaveLength(3);
    expect(job.execution.context?.filesystem?.patterns).toHaveLength(3);
    expect(job.success_criteria).toBeDefined();
    expect(job.error_handling?.timeout_seconds).toBe(900);
    expect(job.resources?.required_capabilities).toHaveLength(3);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("Integration: ConfigLoader handles environment variable configurations", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    // Set test environment variables
    Deno.env.set("TEST_API_KEY", "secret-key-123");
    Deno.env.set("TEST_ENDPOINT", "https://test.example.com");

    const workspaceYml = `version: "1.0"
workspace:
  name: "env-test-workspace"

tools:
  mcp:
    servers:
      test-server:
        transport:
          type: "stdio"
          command: "test-mcp-server"
          args: ["-y", "test-server"]
        env:
          API_KEY:
            from_env: "TEST_API_KEY"
            required: true
          ENDPOINT:
            from_env: "TEST_ENDPOINT"
            default: "https://default.example.com"
          STATIC_VALUE:
            value: "static-config"

agents:
  env-aware-agent:
    type: "remote"
    protocol: "acp"
    endpoint: "https://api.example.com"
    purpose: "Test environment variables"
    auth:
      type: "bearer"
      token_env: "TEST_API_KEY"
    acp:
      agent_name: "env-agent"
`;

    await Deno.writeTextFile(join(tempDir, "workspace.yml"), workspaceYml);

    // Create atlas.yml with required memory configuration
    const atlasYml = `version: "1.0"
workspace:
  name: "Env Test Atlas"

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
`;
    await Deno.writeTextFile(join(tempDir, "atlas.yml"), atlasYml);

    const adapter = new FilesystemConfigAdapter();
    const loader = new ConfigLoader(adapter, tempDir);
    const config = await loader.load();

    // Check that environment variables are properly configured
    expect(config.workspace.tools?.mcp?.servers?.["test-server"]).toBeDefined();
    const serverConfig = config.workspace.tools!.mcp!.servers!["test-server"];
    expect(serverConfig.env).toBeDefined();
    expect(serverConfig.env!["API_KEY"]).toEqual({
      from_env: "TEST_API_KEY",
      required: true,
    });

    // Check agent auth configuration
    const agent = config.workspace.agents!["env-aware-agent"];
    expect(agent.auth?.token_env).toBe("TEST_API_KEY");
  } finally {
    // Clean up environment variables
    Deno.env.delete("TEST_API_KEY");
    Deno.env.delete("TEST_ENDPOINT");
    await Deno.remove(tempDir, { recursive: true });
  }
});
