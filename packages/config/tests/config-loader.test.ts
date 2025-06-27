import { expect } from "@std/expect";
import { ConfigLoader } from "../src/config-loader.ts";
import type { ConfigurationAdapter } from "@atlas/storage";

// Set testing environment to prevent logger file operations
Deno.env.set("DENO_TESTING", "true");

// Mock adapter for testing
class MockConfigAdapter implements ConfigurationAdapter {
  private files = new Map<string, unknown>();

  constructor(files: Record<string, unknown>) {
    Object.entries(files).forEach(([path, content]) => {
      this.files.set(path, content);
    });
  }

  loadYamlFile(path: string): Promise<unknown> {
    if (!this.files.has(path)) {
      throw new Error(`NotFound: ${path}`);
    }
    return Promise.resolve(this.files.get(path));
  }

  fileExists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }

  resolveAtlasConfigPath(workspaceDir: string): Promise<string> {
    return Promise.resolve(`${workspaceDir}/atlas.yml`);
  }

  resolveWorkspaceConfigPath(workspaceDir: string): Promise<string> {
    return Promise.resolve(`${workspaceDir}/workspace.yml`);
  }

  loadJobFiles(jobsDir: string): Promise<Map<string, unknown>> {
    const jobs = new Map<string, unknown>();
    // Check if we have any job files in our mock files
    for (const [path, content] of this.files) {
      if (path.startsWith(jobsDir) && (path.endsWith(".yml") || path.endsWith(".yaml"))) {
        const filename = path.split("/").pop()!;
        const jobName = filename.replace(/\.(yml|yaml)$/, "");
        jobs.set(jobName, content);
      }
    }
    return Promise.resolve(jobs);
  }

  loadSupervisorDefaults(): Promise<unknown> {
    return Promise.resolve({
      version: "1.0",
      supervisors: {
        workspace: {
          model: "test-model",
          prompts: { system: "test workspace prompt" },
        },
        session: {
          model: "test-model",
          prompts: { system: "test session prompt" },
        },
        agent: {
          model: "test-model",
          prompts: { system: "test agent prompt" },
        },
      },
    });
  }
}

Deno.test("ConfigLoader - loads valid configuration", async () => {
  const mockAdapter = new MockConfigAdapter({
    "/test/atlas.yml": {
      version: "1.0",
      workspace: {
        id: "atlas-platform",
        name: "Atlas Platform",
        description: "Test Atlas Platform",
      },
      supervisors: {
        workspace: {
          model: "claude-3-5-sonnet-20241022",
          prompts: { system: "workspace supervisor" },
        },
        session: {
          model: "claude-3-5-sonnet-20241022",
          prompts: { system: "session supervisor" },
        },
        agent: {
          model: "claude-3-5-sonnet-20241022",
          prompts: { system: "agent supervisor" },
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
    },
    "/test/workspace.yml": {
      version: "1.0",
      workspace: {
        name: "test-workspace",
        description: "Test workspace for unit tests",
      },
      agents: {
        "test-agent": {
          type: "llm",
          model: "claude-3-5-haiku-20241022",
          purpose: "Testing",
        },
      },
      signals: {
        "test-signal": {
          description: "Test signal",
          provider: "cli",
        },
      },
    },
  });

  const loader = new ConfigLoader(mockAdapter, "/test");
  const config = await loader.load();

  expect(config.atlas).toBeDefined();
  expect(config.workspace).toBeDefined();
  expect(config.workspace.workspace.name).toBe("test-workspace");
  expect(config.atlas.workspace.name).toBe("Atlas Platform");
  expect(config.jobs).toBeDefined();
  expect(config.supervisorDefaults).toBeDefined();
});

Deno.test("ConfigLoader - handles missing atlas.yml gracefully", async () => {
  const mockAdapter = new MockConfigAdapter({
    "/test/workspace.yml": {
      version: "1.0",
      workspace: {
        name: "test-workspace",
        description: "Test workspace",
      },
      agents: {},
      signals: {},
    },
  });

  const loader = new ConfigLoader(mockAdapter, "/test");
  const config = await loader.load();

  // Should use atlas defaults
  expect(config.atlas.workspace.name).toBe("Atlas Platform");
  expect(config.atlas.supervisors).toBeDefined();
  expect(config.atlas.supervisors.workspace.model).toBeDefined();
});

Deno.test("ConfigLoader - validates workspace configuration", async () => {
  const mockAdapter = new MockConfigAdapter({
    "/test/atlas.yml": {
      version: "1.0",
      workspace: {
        id: "atlas-platform",
        name: "Atlas Platform",
      },
      supervisors: {
        workspace: {
          model: "claude-3-5-sonnet-20241022",
          prompts: { system: "test" },
        },
        session: {
          model: "claude-3-5-sonnet-20241022",
          prompts: { system: "test" },
        },
        agent: {
          model: "claude-3-5-sonnet-20241022",
          prompts: { system: "test" },
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
    },
    "/test/workspace.yml": {
      version: "1.0",
      // Missing required 'workspace' field
      agents: {},
    },
  });

  const loader = new ConfigLoader(mockAdapter, "/test");

  await expect(loader.load()).rejects.toThrow("Configuration validation failed");
});

Deno.test("ConfigLoader - loads job specifications from workspace config", async () => {
  const mockAdapter = new MockConfigAdapter({
    "/test/atlas.yml": {
      version: "1.0",
      workspace: { name: "Atlas Platform" },
      supervisors: {
        workspace: { model: "test", prompts: { system: "test" } },
        session: { model: "test", prompts: { system: "test" } },
        agent: { model: "test", prompts: { system: "test" } },
      },
    },
    "/test/workspace.yml": {
      version: "1.0",
      workspace: { name: "test-workspace" },
      jobs: {
        "inline-job": {
          name: "inline_job",
          description: "Job defined inline",
          execution: {
            strategy: "sequential",
            agents: ["test-agent"],
          },
        },
      },
      agents: {
        "test-agent": {
          type: "llm",
          model: "claude-3-5-haiku-20241022",
          purpose: "Testing",
        },
      },
    },
  });

  const loader = new ConfigLoader(mockAdapter, "/test");
  const config = await loader.load();

  expect(config.jobs["inline-job"]).toBeDefined();
  expect(config.jobs["inline-job"].name).toBe("inline_job");
  expect(config.jobs["inline-job"].execution.strategy).toBe("sequential");
});

Deno.test("ConfigLoader - loads job specifications from files", async () => {
  const mockAdapter = new MockConfigAdapter({
    "/test/atlas.yml": {
      version: "1.0",
      workspace: { name: "Atlas Platform" },
      supervisors: {
        workspace: { model: "test", prompts: { system: "test" } },
        session: { model: "test", prompts: { system: "test" } },
        agent: { model: "test", prompts: { system: "test" } },
      },
    },
    "/test/workspace.yml": {
      version: "1.0",
      workspace: { name: "test-workspace" },
      agents: {
        "test-agent": {
          type: "llm",
          model: "claude-3-5-haiku-20241022",
          purpose: "Testing",
        },
      },
    },
    "/test/jobs/file-job.yml": {
      name: "file_job",
      description: "Job loaded from file",
      execution: {
        strategy: "parallel",
        agents: ["test-agent"],
      },
    },
  });

  const loader = new ConfigLoader(mockAdapter, "/test");
  const config = await loader.load();

  expect(config.jobs["file-job"]).toBeDefined();
  expect(config.jobs["file-job"].name).toBe("file_job");
  expect(config.jobs["file-job"].execution.strategy).toBe("parallel");
});

Deno.test("ConfigLoader - uses supervisor defaults when missing", async () => {
  const mockAdapter = new MockConfigAdapter({
    "/test/atlas.yml": {
      version: "1.0",
      workspace: { name: "Atlas Platform" },
      // No supervisors defined - should use defaults
    },
    "/test/workspace.yml": {
      version: "1.0",
      workspace: { name: "test-workspace" },
      agents: {},
    },
  });

  const loader = new ConfigLoader(mockAdapter, "/test");
  const config = await loader.load();

  // Should have supervisors from defaults
  expect(config.atlas.supervisors).toBeDefined();
  expect(config.atlas.supervisors.workspace).toBeDefined();
  expect(config.atlas.supervisors.workspace.model).toBe("test-model");
  expect(config.atlas.supervisors.workspace.prompts.system).toBe("test workspace prompt");

  // Should have full session supervisor from defaults
  expect(config.atlas.supervisors.session).toBeDefined();
  expect(config.atlas.supervisors.session.model).toBe("test-model");
  expect(config.atlas.supervisors.session.prompts.system).toBe("test session prompt");

  // Should have full agent supervisor from defaults
  expect(config.atlas.supervisors.agent).toBeDefined();
  expect(config.atlas.supervisors.agent.model).toBe("test-model");
  expect(config.atlas.supervisors.agent.prompts.system).toBe("test agent prompt");
});

Deno.test("ConfigLoader - validates agent configurations", async () => {
  const mockAdapter = new MockConfigAdapter({
    "/test/atlas.yml": {
      version: "1.0",
      workspace: { name: "Atlas Platform" },
      supervisors: {
        workspace: { model: "test", prompts: { system: "test" } },
        session: { model: "test", prompts: { system: "test" } },
        agent: { model: "test", prompts: { system: "test" } },
      },
    },
    "/test/workspace.yml": {
      version: "1.0",
      workspace: { name: "test-workspace" },
      agents: {
        "invalid-agent": {
          type: "llm",
          // Missing required 'model' field for LLM agents
          purpose: "Testing",
        },
      },
    },
  });

  const loader = new ConfigLoader(mockAdapter, "/test");

  await expect(loader.load()).rejects.toThrow("LLM agents require 'model' field");
});

Deno.test("ConfigLoader - handles complex job execution configurations", async () => {
  const mockAdapter = new MockConfigAdapter({
    "/test/atlas.yml": {
      version: "1.0",
      workspace: { name: "Atlas Platform" },
      supervisors: {
        workspace: { model: "test", prompts: { system: "test" } },
        session: { model: "test", prompts: { system: "test" } },
        agent: { model: "test", prompts: { system: "test" } },
      },
    },
    "/test/workspace.yml": {
      version: "1.0",
      workspace: { name: "test-workspace" },
      jobs: {
        "complex-job": {
          name: "complex_job",
          description: "Job with advanced execution config",
          triggers: [
            {
              signal: "webhook",
              condition: { "==": [{ "var": "event.type" }, "deployment"] },
            },
          ],
          execution: {
            strategy: "parallel",
            agents: [
              {
                id: "agent1",
                task: "Analyze deployment",
                input_source: "signal",
                tools: ["workspace.memory.recall"],
              },
              {
                id: "agent2",
                task: "Verify health",
                input_source: "previous",
                dependencies: ["agent1"],
              },
            ],
            context: {
              filesystem: {
                patterns: ["**/*.ts", "**/*.yml"],
                base_path: "./src",
                max_file_size: 1048576,
                include_content: true,
              },
            },
          },
          success_criteria: {
            all_agents_succeed: true,
            min_confidence: 0.8,
          },
          error_handling: {
            max_retries: 3,
            retry_delay_seconds: 10,
            timeout_seconds: 300,
          },
        },
      },
      agents: {
        "agent1": {
          type: "llm",
          model: "claude-3-5-sonnet-20241022",
          purpose: "Deployment analysis",
        },
        "agent2": {
          type: "llm",
          model: "claude-3-5-haiku-20241022",
          purpose: "Health verification",
        },
        "validator": {
          type: "llm",
          model: "claude-3-5-sonnet-20241022",
          purpose: "Validate deployment manifests",
        },
        "deployer": {
          type: "tempest",
          agent: "k8s-deployer",
          version: "2.0.0",
          purpose: "Execute Kubernetes deployments",
        },
        "monitor": {
          type: "llm",
          model: "claude-3-5-haiku-20241022",
          purpose: "Monitor deployment health",
        },
      },
      signals: {
        "webhook": {
          description: "Test webhook signal",
          provider: "http",
        },
        "github-push": {
          description: "GitHub push event",
          provider: "github",
        },
        "manual-deploy": {
          description: "Manual deployment trigger",
          provider: "cli",
        },
      },
    },
    "/test/jobs/complex-deployment.yml": {
      name: "advanced_deployment_pipeline",
      description: "Complex job with all configuration options",
      task_template: "Deploy {{service}} to {{environment}} with rollback support",
      triggers: [
        {
          signal: "github-push",
          condition: {
            "and": [
              { "==": [{ "var": "branch" }, "main"] },
              { "contains": [{ "var": "files" }, "deploy/"] },
            ],
          },
        },
        {
          signal: "manual-deploy",
        },
      ],
      session_prompts: {
        planning: "Create a deployment plan",
        evaluation: "Verify deployment success",
      },
      execution: {
        strategy: "parallel",
        agents: [
          {
            id: "validator",
            task: "Validate deployment manifests",
            input_source: "signal",
            tools: ["workspace.k8s.validate", "workspace.security.scan"],
          },
          {
            id: "deployer",
            task: "Execute canary deployment",
            input_source: "combined",
            dependencies: ["validator"],
            tools: ["workspace.k8s.deploy", "workspace.k8s.rollout"],
          },
          {
            id: "monitor",
            task: "Monitor deployment health",
            input_source: "filesystem_context",
            tools: ["workspace.metrics.query", "workspace.logs.search"],
          },
        ],
        context: {
          filesystem: {
            patterns: ["k8s/**/*.yaml", "config/production/*.json", "deploy/scripts/*.sh"],
            base_path: "./",
            max_file_size: 1048576,
            include_content: true,
          },
          custom: {
            environment: "production",
            region: "us-east-1",
            rollback_enabled: true,
          },
        },
      },
      success_criteria: {
        all_pods_healthy: true,
        error_rate_below: 0.01,
        response_time_p99_ms: 500,
        canary_success_rate: 0.99,
      },
      error_handling: {
        max_retries: 2,
        retry_delay_seconds: 60,
        timeout_seconds: 900,
      },
      resources: {
        estimated_duration_seconds: 600,
        max_memory_mb: 1024,
        required_capabilities: ["k8s-production-access", "metrics-read", "deployment-write"],
      },
    },
  });

  const loader = new ConfigLoader(mockAdapter, "/test");
  const config = await loader.load();

  const job = config.jobs["complex-job"];
  expect(job).toBeDefined();
  expect(job.name).toBe("complex_job");
  expect(job.triggers).toBeDefined();
  expect(job.triggers![0].signal).toBe("webhook");
  expect(job.execution.agents).toHaveLength(2);
  expect(job.execution.context).toBeDefined();
  expect(job.error_handling).toBeDefined();
  expect(job.error_handling!.max_retries).toBe(3);

  // Also check the file-loaded job
  const deploymentJob = config.jobs["complex-deployment"];
  expect(deploymentJob).toBeDefined();
  expect(deploymentJob.name).toBe("advanced_deployment_pipeline");
  expect(deploymentJob.triggers).toHaveLength(2);
  expect(deploymentJob.execution.agents).toHaveLength(3);
  expect(deploymentJob.resources?.required_capabilities).toHaveLength(3);
});
