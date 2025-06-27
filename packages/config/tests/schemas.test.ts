import { expect } from "@std/expect";
import {
  AtlasConfigSchema,
  JobSpecificationSchema,
  MCPServerConfigSchema,
  MCPTransportConfigSchema,
  SupervisorConfigSchema,
  WorkspaceAgentConfigSchema,
  WorkspaceConfigSchema,
} from "../src/schemas.ts";

// Set testing environment to prevent logger file operations
Deno.env.set("DENO_TESTING", "true");

Deno.test("AtlasConfigSchema - validates complete atlas configuration", () => {
  const validConfig = {
    version: "1.0",
    workspace: {
      id: "atlas-platform",
      name: "Atlas Platform",
      description: "Main Atlas workspace",
    },
    supervisors: {
      workspace: {
        model: "claude-3-5-sonnet-20241022",
        prompts: { system: "You are a workspace supervisor" },
      },
      session: {
        model: "claude-3-5-sonnet-20241022",
        prompts: { system: "You are a session supervisor" },
      },
      agent: {
        model: "claude-3-5-sonnet-20241022",
        prompts: { system: "You are an agent supervisor" },
      },
    },
    memory: {
      default: {
        enabled: true,
        storage: "local",
        cognitive_loop: true,
        retention: {
          max_age_days: 30,
          max_entries: 1000,
          cleanup_interval_hours: 24,
        },
      },
      agent: {
        enabled: true,
        scope: "agent",
        include_in_context: true,
        context_limits: {
          relevant_memories: 2,
          past_successes: 1,
          past_failures: 1,
        },
        memory_types: {
          working: { enabled: true, max_age_hours: 2, max_entries: 50 },
        },
      },
      session: {
        enabled: true,
        scope: "session",
        include_in_context: true,
        context_limits: {
          relevant_memories: 5,
          past_successes: 3,
          past_failures: 2,
        },
        memory_types: {
          working: { enabled: true, max_age_hours: 24, max_entries: 100 },
        },
      },
      workspace: {
        enabled: true,
        scope: "workspace",
        include_in_context: false,
        context_limits: {
          relevant_memories: 10,
          past_successes: 5,
          past_failures: 3,
        },
        memory_types: {
          episodic: { enabled: true, max_age_days: 90, max_entries: 1000 },
        },
      },
    },
  };

  const result = AtlasConfigSchema.safeParse(validConfig);
  expect(result.success).toBe(true);
});

Deno.test("WorkspaceConfigSchema - validates workspace configuration", () => {
  const validConfig = {
    version: "1.0",
    workspace: {
      name: "test-workspace",
      description: "A test workspace",
    },
    agents: {
      "test-agent": {
        type: "llm",
        model: "claude-3-5-haiku-20241022",
        purpose: "Testing agent",
      },
    },
    signals: {
      "webhook": {
        description: "Webhook signal",
        provider: "http",
        path: "/webhook",
        method: "POST",
      },
    },
    jobs: {
      "test-job": {
        name: "test_job",
        description: "A test job",
        execution: {
          strategy: "sequential",
          agents: ["test-agent"],
        },
      },
    },
  };

  const result = WorkspaceConfigSchema.safeParse(validConfig);
  expect(result.success).toBe(true);
});

Deno.test("WorkspaceAgentConfigSchema - validates LLM agent", () => {
  const llmAgent = {
    type: "llm",
    model: "claude-3-5-sonnet-20241022",
    purpose: "General purpose LLM agent",
    temperature: 0.7,
    max_tokens: 4096,
    tools: {
      mcp: ["server1", "server2"],
      workspace: ["workspace.memory.recall", "workspace.jobs.trigger"],
    },
  };

  const result = WorkspaceAgentConfigSchema.safeParse(llmAgent);
  expect(result.success).toBe(true);
});

Deno.test("WorkspaceAgentConfigSchema - validates Tempest agent", () => {
  const tempestAgent = {
    type: "tempest",
    agent: "k8s-operator",
    version: "1.0.0",
    purpose: "Kubernetes operations",
    config: {
      namespace: "default",
      kubeconfig: "/path/to/config",
    },
  };

  const result = WorkspaceAgentConfigSchema.safeParse(tempestAgent);
  expect(result.success).toBe(true);
});

Deno.test("WorkspaceAgentConfigSchema - validates Remote agent", () => {
  const remoteAgent = {
    type: "remote",
    protocol: "acp",
    endpoint: "https://api.example.com/agent",
    purpose: "Remote agent integration",
    auth: {
      type: "bearer",
      token_env: "REMOTE_AGENT_TOKEN",
    },
    acp: {
      agent_name: "remote-processor",
      default_mode: "async",
      timeout_ms: 30000,
    },
  };

  const result = WorkspaceAgentConfigSchema.safeParse(remoteAgent);
  expect(result.success).toBe(true);
});

Deno.test("WorkspaceAgentConfigSchema - rejects LLM agent without model", () => {
  const invalidAgent = {
    type: "llm",
    // Missing required 'model' field
    purpose: "Invalid agent",
  };

  const result = WorkspaceAgentConfigSchema.safeParse(invalidAgent);
  expect(result.success).toBe(false);
  if (!result.success) {
    const errorMessage = result.error.issues[0].message;
    expect(errorMessage).toContain("LLM agents require 'model' field");
  }
});

Deno.test("WorkspaceAgentConfigSchema - rejects Tempest agent without required fields", () => {
  const invalidAgent = {
    type: "tempest",
    // Missing 'agent' and 'version' fields
    purpose: "Invalid tempest agent",
  };

  const result = WorkspaceAgentConfigSchema.safeParse(invalidAgent);
  expect(result.success).toBe(false);
  if (!result.success) {
    const errors = result.error.issues.map((i) => i.message);
    expect(errors).toContain("Tempest agents require 'agent' field");
    expect(errors).toContain("Tempest agents require 'version' field");
  }
});

Deno.test("JobSpecificationSchema - validates complex job configuration", () => {
  const complexJob = {
    name: "complex_deployment_job",
    description: "Multi-stage deployment with validation",
    task_template: "Deploy {{service}} to {{environment}}",
    triggers: [
      {
        signal: "github-webhook",
        condition: {
          "and": [
            { "==": [{ "var": "event.type" }, "push"] },
            { "==": [{ "var": "branch" }, "main"] },
          ],
        },
      },
    ],
    session_prompts: {
      planning: "Create a deployment plan considering dependencies",
      evaluation: "Verify all services are healthy",
    },
    execution: {
      strategy: "parallel",
      agents: [
        {
          id: "deploy-agent",
          task: "Deploy services",
          input_source: "signal",
          tools: ["workspace.k8s.deploy", "workspace.metrics.query"],
        },
        {
          id: "test-agent",
          task: "Run integration tests",
          input_source: "previous",
          dependencies: ["deploy-agent"],
        },
      ],
      context: {
        filesystem: {
          patterns: ["k8s/**/*.yaml", "config/**/*.json"],
          base_path: "./deployments",
          max_file_size: 1048576,
          include_content: true,
        },
        custom_data: {
          environment: "production",
          region: "us-east-1",
        },
      },
    },
    success_criteria: {
      all_tests_pass: true,
      min_uptime: 99.9,
      max_error_rate: 0.1,
    },
    error_handling: {
      max_retries: 3,
      retry_delay_seconds: 30,
      timeout_seconds: 600,
    },
    resources: {
      estimated_duration_seconds: 300,
      max_memory_mb: 512,
      required_capabilities: ["k8s-access", "metrics-read"],
    },
  };

  const result = JobSpecificationSchema.safeParse(complexJob);
  expect(result.success).toBe(true);
});

Deno.test("SupervisorConfigSchema - validates supervisor configuration", () => {
  const supervisor = {
    model: "claude-3-5-sonnet-20241022",
    memory: "workspace",
    supervision: {
      level: "detailed",
      cache_enabled: true,
      cache_adapter: "redis",
      cache_ttl_hours: 2,
      parallel_llm_calls: true,
      timeouts: {
        analysis_ms: 15000,
        validation_ms: 10000,
        execution_ms: 60000,
      },
    },
    prompts: {
      system: "You are an intelligent supervisor",
      analyze_signal: "Analyze the incoming signal: {{signal}}",
      create_session: "Create a session for: {{context}}",
    },
  };

  const result = SupervisorConfigSchema.safeParse(supervisor);
  expect(result.success).toBe(true);
});

Deno.test("MCPTransportConfigSchema - validates SSE transport", () => {
  const sseTransport = {
    type: "sse",
    url: "https://mcp.example.com/events",
  };

  const result = MCPTransportConfigSchema.safeParse(sseTransport);
  expect(result.success).toBe(true);
});

Deno.test("MCPTransportConfigSchema - validates STDIO transport", () => {
  const stdioTransport = {
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    env: {
      NODE_ENV: "production",
      MCP_SERVER_MODE: "stdio",
    },
  };

  const result = MCPTransportConfigSchema.safeParse(stdioTransport);
  expect(result.success).toBe(true);
});

Deno.test("MCPServerConfigSchema - validates complete MCP server config", () => {
  const mcpServer = {
    transport: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
    },
    auth: {
      type: "bearer",
      token_env: "MCP_TOKEN",
    },
    tools: {
      allowed: ["memory_store", "memory_retrieve"],
      denied: ["memory_delete"],
    },
    timeout_ms: 45000,
    env: {
      API_KEY: {
        from_env: "MCP_API_KEY",
        required: true,
      },
      CONFIG_PATH: {
        value: "/etc/mcp/config.json",
      },
    },
  };

  const result = MCPServerConfigSchema.safeParse(mcpServer);
  expect(result.success).toBe(true);
});

Deno.test("Schema validation - handles invalid enum values", () => {
  const invalidAgent = {
    type: "invalid-type", // Not 'llm', 'tempest', or 'remote'
    purpose: "Test",
  };

  const result = WorkspaceAgentConfigSchema.safeParse(invalidAgent);
  expect(result.success).toBe(false);
  if (!result.success) {
    const error = result.error.issues[0];
    expect(error.path).toEqual(["type"]);
  }
});

Deno.test("Schema validation - handles missing required fields", () => {
  const incompleteWorkspace = {
    version: "1.0",
    // Missing 'workspace' field
  };

  const result = WorkspaceConfigSchema.safeParse(incompleteWorkspace);
  expect(result.success).toBe(false);
  if (!result.success) {
    const paths = result.error.issues.map((i) => i.path.join("."));
    expect(paths).toContain("workspace");
  }
});

Deno.test("Schema validation - validates supported model names", () => {
  // Valid Anthropic model
  const validAnthropic = {
    type: "llm",
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
    purpose: "Test",
  };
  expect(WorkspaceAgentConfigSchema.safeParse(validAnthropic).success).toBe(true);

  // Valid OpenAI model
  const validOpenAI = {
    type: "llm",
    provider: "openai",
    model: "gpt-4o",
    purpose: "Test",
  };
  expect(WorkspaceAgentConfigSchema.safeParse(validOpenAI).success).toBe(true);

  // Invalid model for provider
  const invalidModel = {
    type: "llm",
    provider: "anthropic",
    model: "gpt-4", // OpenAI model with Anthropic provider
    purpose: "Test",
  };
  const result = WorkspaceAgentConfigSchema.safeParse(invalidModel);
  expect(result.success).toBe(false);
  if (!result.success) {
    const message = result.error.issues[0].message;
    expect(message).toContain("not supported by provider");
  }
});
