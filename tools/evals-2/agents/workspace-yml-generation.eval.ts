/**
 * Eval for complete workspace.yml generation via fsm-workspace-creator
 * Tests enrichers and output structure directly (no daemon required)
 */

import { assert } from "@std/assert";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { WorkspaceConfigSchema } from "../../../packages/config/src/workspace.ts";
import type { WorkspacePlan } from "../../../packages/core/src/artifacts/primitives.ts";
import { generateMCPServers } from "../../../packages/system/agents/fsm-workspace-creator/enrichers/mcp-servers.ts";
import { enrichSignal } from "../../../packages/system/agents/fsm-workspace-creator/enrichers/signals.ts";
import { setupTest } from "../../evals/lib/utils.ts";
import { loadCredentials } from "../lib/load-credentials.ts";

const { step } = setupTest({ testFileUrl: new URL(import.meta.url) });

Deno.test("Workspace YML Generation - Daily Report with Discord", async (t) => {
  await loadCredentials();

  await step(t, "Generate complete workspace with signals and MCP", async ({ snapshot }) => {
    // Create a workspace plan
    const plan: WorkspacePlan = {
      workspace: { name: "Daily Report", purpose: "Automated daily reports posted to Discord" },
      signals: [
        {
          id: "daily-9-am-pt",
          name: "Daily 9am Pacific",
          description: "Runs every weekday at 9am Pacific Time to send reports",
        },
      ],
      agents: [
        {
          id: "report-poster",
          name: "Report Poster",
          description: "Posts daily report to Discord",
          needs: ["discord"],
          configuration: { channel: "#reports" },
        },
      ],
      jobs: [
        {
          id: "send-report",
          name: "Send Report",
          triggerSignalId: "daily-9-am-pt",
          steps: [{ agentId: "report-poster", description: "Post daily report to Discord" }],
          behavior: "sequential",
        },
      ],
    };

    snapshot({ inputPlan: plan });

    // Call enrichers directly
    const enrichedSignals = await Promise.all(
      plan.signals.map((s: WorkspacePlan["signals"][number]) => enrichSignal(s)),
    );

    const mcpServers = generateMCPServers(plan.agents);

    // Generate workspace config structure (simulating what fsm-workspace-creator does)
    // Extract job for type safety
    const job = plan.jobs[0];
    if (!job) throw new Error("Test plan must have at least one job");

    const workspaceConfig = {
      version: "1.0",
      workspace: { name: plan.workspace.name, description: plan.workspace.purpose },
      signals: Object.fromEntries(
        enrichedSignals.map((s: Awaited<ReturnType<typeof enrichSignal>>) => [s.id, s.config]),
      ),
      jobs: {
        [job.id]: {
          name: job.id.replace(/-/g, "_"),
          description: job.name,
          triggers: [{ signal: job.triggerSignalId }],
          fsm: {
            // Minimal FSM for testing structure
            id: "test-fsm",
            initial: "idle",
            states: {
              idle: { on: { [job.triggerSignalId]: { target: "processing" } } },
              processing: {
                entry: [
                  {
                    type: "llm",
                    provider: "anthropic",
                    model: "claude-sonnet-4-5",
                    prompt: "Generate and post daily report",
                    tools: ["discord_post_message"],
                    outputTo: "result",
                  },
                ],
                on: { complete: { target: "done" } },
              },
              done: { type: "final" },
            },
          },
        },
      },
      tools:
        mcpServers.length > 0
          ? { mcp: { servers: Object.fromEntries(mcpServers.map((s) => [s.id, s.config])) } }
          : undefined,
    };

    // Write workspace.yml
    const workspaceYml = stringifyYaml(workspaceConfig);
    await Deno.mkdir("./test-workspace", { recursive: true });
    await Deno.writeTextFile("./test-workspace/workspace.yml", workspaceYml);

    snapshot({ workspaceConfig });

    // Verify workspace.yml was created (single file)
    const workspaceYmlPath = "./test-workspace/workspace.yml";

    let workspaceYmlExists = false;

    try {
      await Deno.stat(workspaceYmlPath);
      workspaceYmlExists = true;
    } catch {
      // File doesn't exist
    }

    assert(workspaceYmlExists, "workspace.yml should be created");

    // Read and parse workspace.yml to verify it was written correctly
    const workspaceYmlContent = await Deno.readTextFile(workspaceYmlPath);
    const parsedYaml = parseYaml(workspaceYmlContent);

    // Validate against WorkspaceConfigSchema
    const parsedConfig = WorkspaceConfigSchema.parse(parsedYaml);

    snapshot({ parsedConfig });

    // Validate structure
    assert(parsedConfig.version === "1.0", "Should have version 1.0");
    assert(parsedConfig.workspace, "Should have workspace section");
    assert(
      parsedConfig.workspace.name === "Daily Report",
      "Should have correct workspace name (Daily Report)",
    );

    // Validate signals
    assert(parsedConfig.signals, "Should have signals section");
    if (!parsedConfig.signals) throw new Error("Signals required");

    assert(parsedConfig.signals["daily-9-am-pt"], "Should have daily-9-am-pt signal");

    const signal = parsedConfig.signals["daily-9-am-pt"];
    if (!signal) throw new Error("Signal daily-9-am-pt not found");

    assert(signal.provider === "schedule", "Signal should be schedule provider");
    if (signal.provider !== "schedule") {
      throw new Error("Signal must be schedule provider");
    }

    assert(signal.config, "Signal should have config");
    assert(
      signal.config.schedule === "0 9 * * 1-5",
      `Expected weekday 9am cron, got ${signal.config.schedule}`,
    );
    assert(
      signal.config.timezone === "America/Los_Angeles" || signal.config.timezone === "US/Pacific",
      `Expected Pacific timezone, got ${signal.config.timezone}`,
    );

    // Validate MCP servers (from blessed registry)
    assert(parsedConfig.tools, "Should have tools section");
    if (!parsedConfig.tools) throw new Error("Tools required");

    assert(parsedConfig.tools.mcp, "Should have MCP config");
    if (!parsedConfig.tools.mcp) throw new Error("MCP config required");

    assert(parsedConfig.tools.mcp.servers, "Should have MCP servers");
    if (!parsedConfig.tools.mcp.servers) {
      throw new Error("MCP servers required");
    }

    assert(parsedConfig.tools.mcp.servers.discord, "Should have Discord MCP server from registry");

    const discordServer = parsedConfig.tools.mcp.servers.discord;
    if (!discordServer) throw new Error("Discord server required");

    assert(discordServer.transport, "Discord server should have transport");
    assert(discordServer.env, "Should have environment variables");
    if (!discordServer.env) throw new Error("Discord server env required");

    assert(discordServer.env.DISCORD_TOKEN, "Should have DISCORD_TOKEN env var");

    // Validate jobs with FSM
    assert(parsedConfig.jobs, "Should have jobs section");
    const jobKeys = Object.keys(parsedConfig.jobs);
    assert(jobKeys.length > 0, "Should have at least one job");

    const firstJobKey = jobKeys[0];
    if (!firstJobKey) {
      throw new Error("jobKeys array should not be empty after length check");
    }
    const firstJob = parsedConfig.jobs[firstJobKey];
    if (!firstJob) {
      throw new Error(`Job ${firstJobKey} not found in parsed config`);
    }

    assert(firstJob.fsm, "Job should have FSM");
    if (!firstJob.fsm) throw new Error("FSM is required");

    // FSM is typed as 'any' in JobSpecificationSchema (intentionally - complex XState types)
    const fsm = firstJob.fsm as { states: Record<string, unknown> };
    assert(fsm.states, "FSM should have states");
    assert(firstJob.triggers, "Job should have triggers");

    // Check if FSM uses LLM actions (not agent actions)
    const fsmStates = Object.values(fsm.states);
    const hasLLMAction = fsmStates.some((state) => {
      const s = state as { entry?: Array<{ type: string }> };
      if (!s.entry) return false;
      return s.entry.some((action) => action.type === "llm");
    });

    assert(hasLLMAction, "FSM should use LLM actions");

    snapshot({ hasLLMAction, firstJobFsm: fsm });

    // Cleanup
    await Deno.remove("./test-workspace", { recursive: true });

    return { parsedConfig, signal, discordServer, hasLLMAction };
  });
});

Deno.test("Workspace YML Generation - Multiple MCP Servers", async (t) => {
  await loadCredentials();

  await step(t, "Generate workspace with Discord and GitHub MCP", async ({ snapshot }) => {
    const plan: WorkspacePlan = {
      workspace: { name: "PR Reviewer", purpose: "Automated PR review and Discord notifications" },
      signals: [
        {
          id: "github-pr-webhook",
          name: "GitHub PR Webhook",
          description: "Webhook receives GitHub pull request events",
        },
      ],
      agents: [
        {
          id: "pr-analyzer",
          name: "PR Analyzer",
          description: "Analyzes pull request code",
          needs: ["github"],
        },
        {
          id: "discord-notifier",
          name: "Discord Notifier",
          description: "Sends notifications to Discord",
          needs: ["discord"],
        },
      ],
      jobs: [
        {
          id: "review-pr",
          name: "Review PR",
          triggerSignalId: "github-pr-webhook",
          steps: [
            { agentId: "pr-analyzer", description: "Analyze PR" },
            { agentId: "discord-notifier", description: "Notify team" },
          ],
          behavior: "sequential",
        },
      ],
    };

    snapshot({ inputPlan: plan });

    // Call enrichers directly
    const enrichedSignals = await Promise.all(
      plan.signals.map((s: WorkspacePlan["signals"][number]) => enrichSignal(s)),
    );

    const mcpServers = generateMCPServers(plan.agents);

    // Generate workspace config
    // Extract job for type safety
    const job = plan.jobs[0];
    if (!job) throw new Error("Test plan must have at least one job");

    const workspaceConfig = {
      version: "1.0",
      workspace: { name: plan.workspace.name, description: plan.workspace.purpose },
      signals: Object.fromEntries(
        enrichedSignals.map((s: Awaited<ReturnType<typeof enrichSignal>>) => [s.id, s.config]),
      ),
      jobs: {
        [job.id]: {
          name: job.id.replace(/-/g, "_"),
          description: job.name,
          triggers: [{ signal: job.triggerSignalId }],
          fsm: {
            id: "test-fsm",
            initial: "idle",
            states: {
              idle: { on: { [job.triggerSignalId]: { target: "processing" } } },
              processing: {
                entry: [
                  {
                    type: "llm",
                    provider: "anthropic",
                    model: "claude-sonnet-4-5",
                    prompt: "Analyze PR and notify team",
                    tools: ["github_get_file_contents", "discord_post_message"],
                    outputTo: "result",
                  },
                ],
                on: { complete: { target: "done" } },
              },
              done: { type: "final" },
            },
          },
        },
      },
      tools:
        mcpServers.length > 0
          ? { mcp: { servers: Object.fromEntries(mcpServers.map((s) => [s.id, s.config])) } }
          : undefined,
    };

    // Write workspace.yml
    const workspaceYml = stringifyYaml(workspaceConfig);
    await Deno.mkdir("./test-workspace-multi", { recursive: true });
    await Deno.writeTextFile("./test-workspace-multi/workspace.yml", workspaceYml);

    // Read and parse workspace.yml
    const workspaceYmlContent = await Deno.readTextFile("./test-workspace-multi/workspace.yml");
    const parsedYaml = parseYaml(workspaceYmlContent);

    // Validate against WorkspaceConfigSchema
    const parsedConfig = WorkspaceConfigSchema.parse(parsedYaml);

    snapshot({ parsedConfig });

    // Validate HTTP signal
    assert(parsedConfig.signals, "Should have signals section");
    if (!parsedConfig.signals) throw new Error("Signals required");

    const signal = parsedConfig.signals["github-pr-webhook"];
    if (!signal) throw new Error("Signal github-pr-webhook not found");

    assert(signal.provider === "http", "Should be HTTP provider");
    if (signal.provider !== "http") {
      throw new Error("Signal must be http provider");
    }

    assert(signal.config.path, "Should have path");
    assert(signal.config.path.startsWith("/"), "Path should start with /");

    // Validate both MCP servers exist (from blessed registry)
    assert(parsedConfig.tools, "Should have tools section");
    if (!parsedConfig.tools) throw new Error("Tools required");

    assert(parsedConfig.tools.mcp, "Should have MCP config");
    if (!parsedConfig.tools.mcp) throw new Error("MCP config required");

    assert(parsedConfig.tools.mcp.servers, "Should have MCP servers");
    if (!parsedConfig.tools.mcp.servers) {
      throw new Error("MCP servers required");
    }

    assert(parsedConfig.tools.mcp.servers.github, "Should have GitHub MCP server");
    assert(parsedConfig.tools.mcp.servers.discord, "Should have Discord MCP server");

    const githubServer = parsedConfig.tools.mcp.servers.github;
    if (!githubServer) throw new Error("GitHub server required");

    // Registry uses GH_CLASSIC_PAT (via mcp-remote), not GITHUB_TOKEN
    if (!githubServer.env) throw new Error("GitHub server env required");
    assert(
      githubServer.env.GH_CLASSIC_PAT || githubServer.env.GITHUB_TOKEN,
      "GitHub server should have auth token",
    );

    const discordServer = parsedConfig.tools.mcp.servers.discord;
    if (!discordServer) throw new Error("Discord server required");
    if (!discordServer.env) throw new Error("Discord server env required");

    assert(discordServer.env.DISCORD_TOKEN, "Discord server should have DISCORD_TOKEN");

    // Validate jobs with FSM
    assert(parsedConfig.jobs, "Should have jobs section");
    if (!parsedConfig.jobs) throw new Error("Jobs required");

    const jobKeys = Object.keys(parsedConfig.jobs);
    assert(jobKeys.length > 0, "Should have at least one job");

    const firstJobKey = jobKeys[0];
    if (!firstJobKey) {
      throw new Error("jobKeys array should not be empty after length check");
    }
    const firstJob = parsedConfig.jobs[firstJobKey];
    if (!firstJob) {
      throw new Error(`Job ${firstJobKey} not found in parsed config`);
    }

    assert(firstJob.fsm, "Job should have FSM inside");

    // Cleanup
    await Deno.remove("./test-workspace-multi", { recursive: true });

    return { parsedConfig, signal, githubServer, discordServer };
  });
});
