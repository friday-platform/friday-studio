import { ConfigLoader, WorkspaceMemoryConfig } from "@atlas/config";
import { assertEquals } from "@std/assert";

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

// Create minimal valid configs for testing
const baseAtlasConfig = {
  version: "1.0",
  workspace: {
    id: "atlas-platform", // This marks it as allowed to have system signals
    name: "Atlas Platform",
    description: "Platform workspace",
  },
  server: {
    mcp: {
      enabled: true,
      transport: {
        type: "sse",
        url: "https://platform.atlas.example.com/mcp",
      },
      auth: {
        required: true,
        providers: ["bearer"],
      },
    },
  },
  agents: {
    "platform-agent": {
      type: "llm",
      description: "Platform agent",
      config: {
        provider: "anthropic",
        model: "claude-3-5-haiku-latest",
        prompt: "Platform agent prompt",
      },
    },
  },
  signals: {
    "platform-signal": {
      provider: "schedule",
      description: "Platform signal",
      config: {
        schedule: "0 * * * *",
      },
    },
  },
  jobs: {
    "platform-job": {
      description: "Platform job",
      execution: {
        strategy: "sequential",
        agents: ["platform-agent"],
      },
    },
  },
  memory: {
    default: {
      enabled: true,
      storage: "coala-local",
      cognitive_loop: false,
      retention: {
        max_age_days: 30,
        cleanup_interval_hours: 24,
      },
    },
    agent: {
      enabled: true,
      scope: "agent",
      include_in_context: true,
      context_limits: {
        relevant_memories: 5,
        past_successes: 3,
        past_failures: 2,
      },
      memory_types: {},
    },
    session: {
      enabled: true,
      scope: "session",
      include_in_context: true,
      context_limits: {
        relevant_memories: 10,
        past_successes: 5,
        past_failures: 3,
      },
      memory_types: {},
    },
    workspace: {
      enabled: true,
      scope: "workspace",
      include_in_context: true,
      context_limits: {
        relevant_memories: 20,
        past_successes: 10,
        past_failures: 5,
      },
      memory_types: {},
    },
  },
  supervisors: {
    workspace: {
      model: "claude-3-7-sonnet-latest",
      memory: "workspace",
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
    session: {
      model: "claude-3-7-sonnet-latest",
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
      model: "claude-3-5-haiku-latest",
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
  },
  planning: {
    execution: {
      precomputation: "moderate",
      cache_enabled: true,
      cache_ttl_hours: 24,
      invalidate_on_job_change: true,
      strategy_selection: {
        simple_jobs: ".*",
        complex_jobs: ".*complex.*",
        optimization_jobs: ".*optimize.*",
        planning_jobs: ".*plan.*",
      },
      strategy_thresholds: {
        complexity: 0.5,
        uncertainty: 0.3,
        optimization: 0.7,
      },
    },
    validation: {
      llm_threshold: 0.8,
      precomputation: "moderate",
      functional_validators: true,
      smoke_tests: true,
      content_safety: true,
      llm_fallback: true,
      cache_enabled: true,
      cache_ttl_hours: 24,
      fail_fast: false,
    },
  },
  runtime: {
    server: {
      host: "0.0.0.0",
      port: 8080,
    },
  },
};

const baseWorkspaceConfig = {
  version: "1.0",
  workspace: {
    name: "Test Workspace",
    description: "User workspace",
  },
  server: {
    mcp: {
      enabled: false, // Override
    },
  },
  agents: {
    "workspace-agent": {
      type: "llm",
      description: "Workspace agent",
      config: {
        provider: "anthropic",
        model: "claude-3-7-sonnet-latest",
        prompt: "Workspace agent prompt",
      },
    },
  },
  signals: {
    "workspace-signal": {
      provider: "http",
      description: "Workspace signal",
      config: {
        path: "/webhook",
      },
    },
  },
  jobs: {
    "workspace-job": {
      description: "Workspace job",
      execution: {
        strategy: "sequential",
        agents: ["workspace-agent"],
      },
    },
  },
};

// Basic Separation Tests
Deno.test("Config V2 - should keep workspace and atlas configs separate", async () => {
  const adapter = new MockConfigAdapter("/@atlas/system/test");
  adapter.addConfig("atlas.yml", baseAtlasConfig);
  adapter.addConfig("workspace.yml", baseWorkspaceConfig);

  const loader = new ConfigLoader(adapter, "/@atlas/system/test");
  const merged = await loader.load();

  // Workspace values are in workspace config
  assertEquals(merged.workspace.workspace.name, "Test Workspace");
  assertEquals(merged.workspace.workspace.description, "User workspace");

  // Atlas config has the same workspace identity but different server config
  assertEquals(merged.atlas?.workspace.id, "atlas-platform");
  assertEquals(merged.atlas?.workspace.name, "Atlas Platform");

  // Server configs are separate
  assertEquals(merged.workspace.server?.mcp?.enabled, false);
  assertEquals(merged.atlas?.server?.mcp?.enabled, true);

  // Atlas-specific fields only in atlas config
  assertEquals(merged.atlas?.supervisors?.workspace?.model, "claude-3-7-sonnet-latest");
  assertEquals(merged.atlas?.planning?.execution?.precomputation, "moderate");
});

Deno.test("Config V2 - should keep agents separate in workspace and atlas configs", async () => {
  const adapter = new MockConfigAdapter("/@atlas/system/test");
  adapter.addConfig("atlas.yml", baseAtlasConfig);
  adapter.addConfig("workspace.yml", baseWorkspaceConfig);

  const loader = new ConfigLoader(adapter, "/@atlas/system/test");
  const merged = await loader.load();

  // Atlas agents in atlas config
  assertEquals(Object.keys(merged.atlas?.agents || {}).includes("platform-agent"), true);
  assertEquals(Object.keys(merged.atlas?.agents || {}).length, 1);

  // Workspace agents in workspace config
  assertEquals(Object.keys(merged.workspace.agents || {}).includes("workspace-agent"), true);
  assertEquals(Object.keys(merged.workspace.agents || {}).length, 1);
});

Deno.test("Config V2 - should keep signals separate in workspace and atlas configs", async () => {
  const adapter = new MockConfigAdapter("/@atlas/system/test");
  adapter.addConfig("atlas.yml", baseAtlasConfig);
  adapter.addConfig("workspace.yml", baseWorkspaceConfig);

  const loader = new ConfigLoader(adapter, "/@atlas/system/test");
  const merged = await loader.load();

  // Atlas signals in atlas config
  assertEquals(Object.keys(merged.atlas?.signals || {}).includes("platform-signal"), true);
  assertEquals(Object.keys(merged.atlas?.signals || {}).length, 1);

  // Workspace signals in workspace config
  assertEquals(Object.keys(merged.workspace.signals || {}).includes("workspace-signal"), true);
  assertEquals(Object.keys(merged.workspace.signals || {}).length, 1);
});

Deno.test("Config V2 - should keep jobs separate in workspace and atlas configs", async () => {
  const adapter = new MockConfigAdapter("/@atlas/system/test");
  adapter.addConfig("atlas.yml", baseAtlasConfig);
  adapter.addConfig("workspace.yml", baseWorkspaceConfig);

  const loader = new ConfigLoader(adapter, "/@atlas/system/test");
  const merged = await loader.load();

  // Atlas jobs in atlas config
  assertEquals(Object.keys(merged.atlas?.jobs || {}).includes("platform-job"), true);
  assertEquals(Object.keys(merged.atlas?.jobs || {}).length, 1);

  // Workspace jobs in workspace config
  assertEquals(Object.keys(merged.workspace.jobs || {}).includes("workspace-job"), true);
  assertEquals(Object.keys(merged.workspace.jobs || {}).length, 1);
});

// Tool Configuration Tests
Deno.test("Config V2 - should keep MCP servers separate in each config", async () => {
  const atlasWithTools = {
    ...baseAtlasConfig,
    tools: {
      mcp: {
        client_config: {
          timeout: {
            progressTimeout: "2m",
            maxTotalTimeout: "30m",
          },
        },
        servers: {
          "atlas-server": {
            transport: { type: "stdio", command: "atlas-mcp" },
          },
        },
      },
    },
  };

  const workspaceWithTools = {
    ...baseWorkspaceConfig,
    tools: {
      mcp: {
        client_config: {
          timeout: {
            progressTimeout: "3m", // Override with longer timeout
            maxTotalTimeout: "60m",
          },
        },
        servers: {
          "workspace-server": {
            transport: { type: "stdio", command: "workspace-mcp" },
          },
        },
      },
    },
  };

  const adapter = new MockConfigAdapter("/@atlas/system/test");
  adapter.addConfig("atlas.yml", atlasWithTools);
  adapter.addConfig("workspace.yml", workspaceWithTools);

  const loader = new ConfigLoader(adapter, "/@atlas/system/test");
  const merged = await loader.load();

  // Atlas servers in atlas config
  assertEquals(Object.keys(merged.atlas?.tools?.mcp?.servers || {}).includes("atlas-server"), true);
  assertEquals(Object.keys(merged.atlas?.tools?.mcp?.servers || {}).length, 1);

  // Workspace servers in workspace config
  assertEquals(
    Object.keys(merged.workspace.tools?.mcp?.servers || {}).includes("workspace-server"),
    true,
  );
  assertEquals(Object.keys(merged.workspace.tools?.mcp?.servers || {}).length, 1);

  // Client configs are separate
  assertEquals(merged.atlas?.tools?.mcp?.client_config?.timeout, {
    progressTimeout: "2m",
    maxTotalTimeout: "30m",
  });
  assertEquals(merged.workspace.tools?.mcp?.client_config?.timeout, {
    progressTimeout: "3m",
    maxTotalTimeout: "60m",
  });
});

// Cross-reference Validation
Deno.test("Config V2 - should validate cross-references between separate configs", async () => {
  const atlasConfig = {
    ...baseAtlasConfig,
    agents: {
      ...baseAtlasConfig.agents,
      "shared-agent": {
        type: "llm",
        description: "Shared agent",
        config: {
          provider: "anthropic",
          model: "claude-3-5-haiku-latest",
          prompt: "Shared prompt",
        },
      },
    },
  };

  const workspaceConfig = {
    ...baseWorkspaceConfig,
    jobs: {
      "cross-ref-job": {
        description: "Job using atlas agent",
        execution: {
          strategy: "sequential",
          agents: ["shared-agent"], // Reference to atlas agent
        },
      },
    },
  };

  const adapter = new MockConfigAdapter("/@atlas/system/test");
  adapter.addConfig("atlas.yml", atlasConfig);
  adapter.addConfig("workspace.yml", workspaceConfig);

  const loader = new ConfigLoader(adapter, "/@atlas/system/test");
  const merged = await loader.load();

  // Should successfully validate cross-references even though configs are separate
  assertEquals(
    merged.workspace.jobs?.["cross-ref-job"]?.execution.agents.includes("shared-agent"),
    true,
  );
  assertEquals(merged.atlas?.agents?.["shared-agent"]?.type, "llm");
});

// Same Name Scenarios
Deno.test("Config V2 - should allow same agent names in different configs", async () => {
  const atlasConfig = {
    ...baseAtlasConfig,
    agents: {
      ...baseAtlasConfig.agents,
      "common-agent": {
        type: "llm",
        description: "Atlas version",
        config: {
          provider: "anthropic",
          model: "claude-3-5-haiku-latest",
          prompt: "Atlas prompt",
          temperature: 0.5,
        },
      },
    },
  };

  const workspaceConfig = {
    ...baseWorkspaceConfig,
    agents: {
      ...baseWorkspaceConfig.agents,
      "common-agent": {
        type: "llm",
        description: "Workspace override",
        config: {
          provider: "anthropic",
          model: "claude-3-7-sonnet-latest", // Different model
          prompt: "Workspace prompt",
          temperature: 0.7,
        },
      },
    },
  };

  const adapter = new MockConfigAdapter("/@atlas/system/test");
  adapter.addConfig("atlas.yml", atlasConfig);
  adapter.addConfig("workspace.yml", workspaceConfig);

  const loader = new ConfigLoader(adapter, "/@atlas/system/test");
  const merged = await loader.load();

  // Both agents exist separately
  const atlasAgent = merged.atlas?.agents?.["common-agent"];
  if (atlasAgent?.type === "llm") {
    assertEquals(atlasAgent.description, "Atlas version");
    assertEquals(atlasAgent.config.model, "claude-3-5-haiku-latest");
    assertEquals(atlasAgent.config.prompt, "Atlas prompt");
    assertEquals(atlasAgent.config.temperature, 0.5);
  }

  const workspaceAgent = merged.workspace.agents?.["common-agent"];
  if (workspaceAgent?.type === "llm") {
    assertEquals(workspaceAgent.description, "Workspace override");
    assertEquals(workspaceAgent.config.model, "claude-3-7-sonnet-latest");
    assertEquals(workspaceAgent.config.prompt, "Workspace prompt");
    assertEquals(workspaceAgent.config.temperature, 0.7);
  }
});

// Empty Config Handling
Deno.test("Config V2 - should handle empty atlas config", async () => {
  const adapter = new MockConfigAdapter("/workspace");
  adapter.addConfig("workspace.yml", baseWorkspaceConfig);
  // No atlas.yml

  const loader = new ConfigLoader(adapter, "/workspace");
  const merged = await loader.load();

  // Should have workspace config
  assertEquals(merged.workspace.workspace.name, "Test Workspace");
  assertEquals(Object.keys(merged.workspace.agents || {}).length, 1);
  assertEquals(Object.keys(merged.workspace.agents || {}).includes("workspace-agent"), true);

  // Atlas should be null
  assertEquals(merged.atlas, null);
});

// Federation Configuration
Deno.test("Config V2 - should keep federation configs separate", async () => {
  const atlasWithFederation = {
    ...baseAtlasConfig,
    federation: {
      sharing: {
        "platform-share": {
          workspaces: ["workspace-a"],
          scopes: ["read_platform"],
        },
      },
    },
  };

  const workspaceWithFederation = {
    ...baseWorkspaceConfig,
    federation: {
      sharing: {
        "workspace-share": {
          workspaces: ["workspace-b"],
          scopes: ["read_data"],
        },
      },
    },
  };

  const adapter = new MockConfigAdapter("/@atlas/system/test");
  adapter.addConfig("atlas.yml", atlasWithFederation);
  adapter.addConfig("workspace.yml", workspaceWithFederation);

  const loader = new ConfigLoader(adapter, "/@atlas/system/test");
  const merged = await loader.load();

  // Each config has its own federation settings
  assertEquals(
    merged.workspace.federation?.sharing?.["workspace-share"]?.scopes?.includes("read_data"),
    true,
  );
  assertEquals(
    merged.atlas?.federation?.sharing?.["platform-share"]?.scopes?.includes("read_platform"),
    true,
  );
});

// Memory Configuration
Deno.test("Config V2 - should keep memory configs separate", async () => {
  const workspaceWithMemory = {
    ...baseWorkspaceConfig,
    memory: {
      enabled: true,
      scope: "workspace",
      retention: {
        max_age_days: 7,
        max_entries: 1000,
      },
    },
  };

  const adapter = new MockConfigAdapter("/@atlas/system/test");
  adapter.addConfig("atlas.yml", baseAtlasConfig);
  adapter.addConfig("workspace.yml", workspaceWithMemory);

  const loader = new ConfigLoader(adapter, "/@atlas/system/test");
  const merged = await loader.load();

  // Each config has its own memory settings
  // Atlas has complex memory config
  assertEquals(merged.atlas?.memory?.default?.enabled, true);
  assertEquals(merged.atlas?.memory?.default?.storage, "coala-local");

  // Workspace has simple memory config
  if (merged.workspace.memory && "enabled" in merged.workspace.memory) {
    const workspaceMemory = merged.workspace.memory as WorkspaceMemoryConfig;
    assertEquals(workspaceMemory.enabled, true);
    assertEquals(workspaceMemory.scope, "workspace");
    assertEquals(workspaceMemory.retention?.max_age_days, 7);
  }
});

// Tool Configuration Edge Cases
Deno.test("Config V2 - should handle missing tools sections gracefully", async () => {
  const adapter = new MockConfigAdapter("/@atlas/system/test");
  adapter.addConfig("atlas.yml", baseAtlasConfig); // No tools
  adapter.addConfig("workspace.yml", baseWorkspaceConfig); // No tools

  const loader = new ConfigLoader(adapter, "/@atlas/system/test");
  const merged = await loader.load();

  // Both configs should have no tools
  assertEquals(merged.atlas?.tools, undefined);
  assertEquals(merged.workspace.tools, undefined);
});

Deno.test("Config V2 - should keep complex nested tool configs separate", async () => {
  const atlasTools = {
    ...baseAtlasConfig,
    tools: {
      mcp: {
        client_config: {
          timeout: {
            progressTimeout: "2m",
            maxTotalTimeout: "30m",
          },
        },
        servers: {
          "github": {
            transport: { type: "stdio", command: "gh-mcp" },
            auth: { type: "bearer", token_env: "GH_TOKEN" },
          },
        },
        tool_policy: {
          type: "allowlist",
          allow: ["github"],
        },
      },
    },
  };

  const workspaceTools = {
    ...baseWorkspaceConfig,
    tools: {
      mcp: {
        client_config: {
          timeout: {
            progressTimeout: "3m", // Override with longer timeout
            maxTotalTimeout: "60m",
          },
        },
        servers: {
          "slack": {
            transport: { type: "stdio", command: "slack-mcp" },
          },
          "github": { // Override github
            transport: { type: "stdio", command: "github-mcp-v2" },
            auth: { type: "bearer", token_env: "GITHUB_PAT" },
          },
        },
      },
    },
  };

  const adapter = new MockConfigAdapter("/@atlas/system/test");
  adapter.addConfig("atlas.yml", atlasTools);
  adapter.addConfig("workspace.yml", workspaceTools);

  const loader = new ConfigLoader(adapter, "/@atlas/system/test");
  const merged = await loader.load();

  // Atlas tools config
  assertEquals(merged.atlas?.tools?.mcp?.client_config?.timeout, {
    progressTimeout: "2m",
    maxTotalTimeout: "30m",
  });
  const atlasGithub = merged.atlas?.tools?.mcp?.servers?.["github"]?.transport;
  if (atlasGithub && atlasGithub.type === "stdio") {
    assertEquals(atlasGithub.command, "gh-mcp");
  }
  assertEquals(merged.atlas?.tools?.mcp?.servers?.["github"]?.auth?.token_env, "GH_TOKEN");
  assertEquals(merged.atlas?.tools?.mcp?.tool_policy?.type, "allowlist");

  // Workspace tools config
  assertEquals(merged.workspace.tools?.mcp?.client_config?.timeout, {
    progressTimeout: "3m",
    maxTotalTimeout: "60m",
  });
  assertEquals(Object.keys(merged.workspace.tools?.mcp?.servers || {}).length, 2);

  const workspaceGithub = merged.workspace.tools?.mcp?.servers?.["github"]?.transport;
  if (workspaceGithub && workspaceGithub.type === "stdio") {
    assertEquals(workspaceGithub.command, "github-mcp-v2");
  }
  assertEquals(merged.workspace.tools?.mcp?.servers?.["github"]?.auth?.token_env, "GITHUB_PAT");

  const slackTransport = merged.workspace.tools?.mcp?.servers?.["slack"]?.transport;
  if (slackTransport && slackTransport.type === "stdio") {
    assertEquals(slackTransport.command, "slack-mcp");
  }
});
