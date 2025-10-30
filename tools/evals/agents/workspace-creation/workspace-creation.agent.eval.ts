import { client, parseResult } from "@atlas/client/v2";
import type { WorkspacePlan } from "@atlas/core/artifacts";
import { workspaceCreationAgent } from "@atlas/system/agents";
import { assert } from "@std/assert";
import { AgentContextAdapter } from "../../lib/context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { setupTest } from "../../lib/utils.ts";
import {
  customerSupportTriagePlan,
  githubCIPipelinePlan,
  githubPRWebhookPlan,
  investorBriefingPlan,
} from "./plans/mod.ts";

const { step } = setupTest({ testFileUrl: new URL(import.meta.url) });

/**
 * Helper to create artifact from plan data
 */
async function createPlanArtifact(
  plan: WorkspacePlan,
  workspaceId: string,
  chatId: string,
): Promise<string> {
  const response = await parseResult(
    client.artifactsStorage.index.$post({
      json: {
        summary: "Test workspace plan",
        data: { type: "workspace-plan", version: 1, data: plan },
        workspaceId,
        chatId,
      },
    }),
  );

  if (!response.ok) {
    throw new Error(`Failed to create artifact: ${JSON.stringify(response.error)}`);
  }

  return response.data.artifact.id;
}

/**
 * Tests workspace creation agent v2: creates workspaces from structured plan artifacts.
 *
 * This agent receives plan artifacts (with IDs already resolved) from the planner
 * and enriches components in parallel to generate workspace.yml configurations.
 */
Deno.test("Workspace Creation Agent v2", async (t) => {
  await loadCredentials();
  const adapter = new AgentContextAdapter();
  adapter.enableTelemetry();

  /**
   * Test: Customer Support Triage with Conditional Logic
   * Validates handling of conditional branching (technical vs billing issues)
   */
  await step(t, "Customer Support Triage - Conditional Branching", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const plan = customerSupportTriagePlan;

    const artifactId = await createPlanArtifact(
      plan,
      context.session.workspaceId,
      context.session.streamId,
    );

    const startTime = performance.now();
    const result = await workspaceCreationAgent.execute({ artifactId }, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    snapshot({ plan, artifactId, result, metrics, streamEvents, timing: { executionTimeMs } });

    assert(result.ok, `Creation should succeed: ${!result.ok ? result.error.reason : ""}`);
    assert(result.data.config, "Should have workspace config");

    // Validate signal enrichment
    const signals = Object.values(result.data.config.signals ?? {});
    assert(signals.length === plan.signals.length, "Signal count should match plan");
    assert(signals[0]?.provider === "http", "Zendesk webhook should be http signal");

    // Validate agent enrichment
    const agents = Object.values(result.data.config.agents ?? {});
    assert(agents.length === plan.agents.length, "Agent count should match plan");

    // Validate job enrichment
    const jobs = Object.values(result.data.config.jobs ?? {});
    assert(jobs.length === plan.jobs.length, "Job count should match plan");
    const job = jobs[0];
    assert(job?.execution?.strategy === "sequential", "Support triage should be sequential");

    // Validate IDs are preserved from plan
    assert(
      result.data.summary.signalIds.includes("new-zendesk-ticket"),
      "Should preserve signal ID from plan",
    );
    assert(
      result.data.summary.agentIds.includes("ticket-analyzer"),
      "Should preserve agent ID from plan",
    );

    // LLM validates the workflow meets requirements
    const workflowEval = await llmJudge({
      criteria: `The workspace should:
        1. Respond to Zendesk ticket webhook events
        2. Analyze tickets and categorize them (billing, technical, feature request, other)
        3. Handle conditional logic (technical issues → search docs, billing → urgent flag)
        4. Update tickets with tags and solutions
        5. Notify Slack #support-triage channel
        The configuration should support category-specific handling.`,
      agentOutput: result.data.config,
    });
    assert(workflowEval.pass, `Workflow validation failed: ${workflowEval.justification}`);

    return { result, metrics, executionTimeMs };
  });

  /**
   * Test: GitHub CI Pipeline with Parallel Checks
   * Validates parallel execution and multi-output notifications
   */
  await step(t, "GitHub CI Pipeline - Parallel Execution", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const plan = githubCIPipelinePlan;

    const artifactId = await createPlanArtifact(
      plan,
      context.session.workspaceId,
      context.session.streamId,
    );

    const startTime = performance.now();
    const result = await workspaceCreationAgent.execute({ artifactId }, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    snapshot({ plan, artifactId, result, metrics, streamEvents, timing: { executionTimeMs } });

    assert(result.ok, `Creation should succeed: ${!result.ok ? result.error.reason : ""}`);

    // Validate signal
    const signals = Object.values(result.data.config.signals ?? {});
    assert(signals.length === 1, "Should have one webhook signal");
    assert(signals[0]?.provider === "http", "GitHub webhook should be http signal");

    // Validate agents
    const agents = Object.values(result.data.config.agents ?? {});
    assert(agents.length === plan.agents.length, "Agent count should match plan");

    // Validate jobs
    const jobs = Object.values(result.data.config.jobs ?? {});
    assert(jobs.length === 1, "Should have one CI pipeline job");

    // Validate repository configuration is preserved
    const hasRepoConfig = agents.some(
      (agent) =>
        agent.description?.includes("github.com/myorg/myrepo") ||
        (agent.type === "llm" && agent.config.prompt?.includes("github.com/myorg/myrepo")),
    );
    assert(hasRepoConfig, "Should preserve repository configuration");

    const ciPipelineEval = await llmJudge({
      criteria: `The workspace should:
        1. Trigger on GitHub push events to main branch
        2. Run quality checks: tests with coverage, security scan, dependency check
        3. Post results to Slack #ci-alerts
        4. Comment on the commit with summary
        5. Reference repository github.com/myorg/myrepo
        The configuration should coordinate multiple checks and dual notification outputs.`,
      agentOutput: result.data.config,
    });
    assert(ciPipelineEval.pass, `CI pipeline validation failed: ${ciPipelineEval.justification}`);

    return { result, metrics, executionTimeMs };
  });

  /**
   * Test: Simple Webhook Trigger
   * Validates basic webhook signal enrichment and single-agent workflow
   */
  await step(t, "GitHub PR Code Review - Webhook Trigger", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const plan = githubPRWebhookPlan;

    const artifactId = await createPlanArtifact(
      plan,
      context.session.workspaceId,
      context.session.streamId,
    );

    const startTime = performance.now();
    const result = await workspaceCreationAgent.execute({ artifactId }, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    snapshot({ plan, artifactId, result, metrics, streamEvents, timing: { executionTimeMs } });

    assert(result.ok, `Creation should succeed: ${!result.ok ? result.error.reason : ""}`);

    // Validate webhook signal
    const signals = Object.values(result.data.config.signals ?? {});
    assert(signals.length === 1, "Should have one signal");
    assert(signals[0]?.provider === "http", "GitHub webhook should be http provider");

    // Validate single-agent workflow
    const agents = Object.values(result.data.config.agents ?? {});
    assert(agents.length === 1, "Should have one PR reviewer agent");

    const webhookEval = await llmJudge({
      criteria: `The workspace should:
        1. Receive GitHub webhook events for new pull requests
        2. Analyze PR code for quality issues
        3. Post review comments on GitHub
        The configuration should be minimal and focused.`,
      agentOutput: result.data.config,
    });
    assert(webhookEval.pass, `Webhook workflow validation failed: ${webhookEval.justification}`);

    return { result, metrics, executionTimeMs };
  });

  /**
   * Test: Investor Briefing with Multi-Source Integration
   * Validates schedule signals and complex sequential workflows
   */
  await step(t, "Investor Briefing - Daily Schedule Multi-Source", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const plan = investorBriefingPlan;

    const artifactId = await createPlanArtifact(
      plan,
      context.session.workspaceId,
      context.session.streamId,
    );

    const startTime = performance.now();
    const result = await workspaceCreationAgent.execute({ artifactId }, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    snapshot({ plan, artifactId, result, metrics, streamEvents, timing: { executionTimeMs } });

    assert(result.ok, `Creation should succeed: ${!result.ok ? result.error.reason : ""}`);

    // Validate schedule signal
    const signals = Object.values(result.data.config.signals ?? {});
    assert(signals.length === 1, "Should have one schedule signal");
    assert(signals[0]?.provider === "schedule", "Should be schedule provider");
    assert(signals[0].config?.schedule, "Schedule signal should have cron config");

    // Validate multi-agent sequential workflow
    const agents = Object.values(result.data.config.agents ?? {});
    assert(agents.length === plan.agents.length, "Agent count should match plan");
    assert(agents.length >= 3, "Should have multiple agents for calendar, research, and email");

    // Validate job orchestration
    const jobs = Object.values(result.data.config.jobs ?? {});
    const job = jobs[0];
    assert(job?.execution?.strategy === "sequential", "Briefing workflow should be sequential");

    // Validate email configuration preservation
    const hasEmailConfig = agents.some(
      (agent) =>
        (agent.type === "atlas" && agent.agent === "email") ||
        (agent.type === "llm" && agent.config.prompt?.includes("vc@example.com")),
    );
    assert(hasEmailConfig, "Should have email agent or email configuration");

    const briefingEval = await llmJudge({
      criteria: `The workspace should:
        1. Run daily at 8am PST
        2. Fetch calendar events from Google Calendar
        3. Research companies (business model, funding, metrics)
        4. Research founding teams
        5. Compile briefing and email to vc@example.com
        The workflow should be sequential with clear data flow.`,
      agentOutput: result.data.config,
    });
    assert(briefingEval.pass, `Investor briefing validation failed: ${briefingEval.justification}`);

    return { result, metrics, executionTimeMs };
  });

  /**
   * Test: ID Preservation and Reference Integrity
   * Validates that IDs from the plan are preserved through enrichment
   */
  await step(t, "ID Preservation Across Enrichment", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    // Use any plan - we're testing ID preservation
    const plan = githubPRWebhookPlan;

    const artifactId = await createPlanArtifact(
      plan,
      context.session.workspaceId,
      context.session.streamId,
    );

    const result = await workspaceCreationAgent.execute({ artifactId }, context);

    snapshot({ plan, result });

    assert(result.ok, "Creation should succeed");

    // Validate all signal IDs are preserved
    for (const signal of plan.signals) {
      assert(
        result.data.summary.signalIds.includes(signal.id),
        `Signal ID ${signal.id} should be preserved`,
      );
      assert(result.data.config.signals?.[signal.id], `Signal ${signal.id} should exist in config`);
    }

    // Validate all agent IDs are preserved
    for (const agent of plan.agents) {
      assert(
        result.data.summary.agentIds.includes(agent.id),
        `Agent ID ${agent.id} should be preserved`,
      );
      assert(result.data.config.agents?.[agent.id], `Agent ${agent.id} should exist in config`);
    }

    // Validate all job IDs are preserved
    for (const job of plan.jobs) {
      assert(result.data.summary.jobIds.includes(job.id), `Job ID ${job.id} should be preserved`);
      assert(result.data.config.jobs?.[job.id], `Job ${job.id} should exist in config`);
    }

    // Validate job references are intact
    for (const job of plan.jobs) {
      const enrichedJob = result.data.config.jobs?.[job.id];
      assert(enrichedJob, `Job ${job.id} should be enriched`);

      // Check trigger reference
      const triggerExists = enrichedJob.triggers?.some(
        (t) => "signal" in t && t.signal === job.triggerSignalId,
      );
      assert(triggerExists, `Job ${job.id} should reference trigger signal ${job.triggerSignalId}`);

      // Check agent references in execution
      if (enrichedJob.execution?.agents) {
        for (const step of job.steps) {
          const agentReferenced = enrichedJob.execution.agents.some((a) =>
            typeof a === "string" ? a === step.agentId : a.id === step.agentId,
          );
          assert(
            agentReferenced,
            `Job ${job.id} should reference agent ${step.agentId} in execution`,
          );
        }
      }
    }

    return { plan, result };
  });
});
