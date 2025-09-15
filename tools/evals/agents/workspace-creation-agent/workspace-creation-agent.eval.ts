import { workspaceCreationAgent } from "@atlas/system/agents";
import { assert } from "@std/assert";
import { AgentContextAdapter } from "../../lib/context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { setupTest } from "../../lib/utils.ts";

const { step } = setupTest({ testFileUrl: new URL(import.meta.url) });

/**
 * Tests the workspace creation agent's ability to generate Atlas workspace configurations
 * from natural language descriptions. The agent is a system-level component that translates
 * user requirements into workspace.yml configurations with agents, signals, and jobs.
 */
Deno.test("Workspace Creation Agent", async (t) => {
  await loadCredentials();
  const adapter = new AgentContextAdapter();
  adapter.enableTelemetry();

  /**
   * Tests workspace creation for a complex workflow:
   * Signal: fs-watch on directory → Agents: file reader, analyzer, Slack notifier → Job: sequential execution
   */
  await step(t, "Meeting Note Analysis", async ({ snapshot }) => {
    // Reset adapter and create fresh context for this test
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const startTime = performance.now();
    const result = await workspaceCreationAgent.execute(
      "I'm a product manager, and I'm conducting discovery for my new product. I want Atlas to take my transcribed meeting notes from a directory on my computer whenever I add a new note, analyze them for learnings and next steps, and then share out to the rest of the team on Slack.",
      context,
    );
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    snapshot({
      result,
      metrics,
      streamEvents,
      timing: {
        executionTimeMs,
        executionTimeSec: executionTimeMs / 1000,
        executionTimeMin: executionTimeMs / 60000,
      },
    });

    assert(result.success === true, "Workspace should be created successfully");
    assert(result.summary.agentCount === 3, "Should have exactly 3 agents");
    assert(result.summary.signalCount === 1, "Should have exactly 1 signal");
    assert(result.summary.jobCount === 1, "Should have exactly 1 job");

    // Verify fs-watch signal configuration for directory monitoring
    assert(result.config.signals, "Should have signals defined");
    const signals = Object.values(result.config.signals);
    assert(signals.length === 1, "Should have exactly 1 signal");
    const firstSignal = signals.at(0);
    assert(firstSignal, "Should have first signal");
    assert(firstSignal.provider === "fs-watch", "Signal should be fs-watch provider");
    assert(
      "config" in firstSignal && firstSignal.config?.path,
      "Signal should specify a directory path",
    );

    // Verify Slack agent exists in the workspace configuration
    assert(result.config.agents, "Should have agents defined");
    const agents = Object.values(result.config.agents);
    const hasSlackAgent = agents.some(
      (agent) =>
        (agent.type === "atlas" && agent.agent === "slack") ||
        agent.description?.toLowerCase().includes("slack"),
    );
    assert(hasSlackAgent, "Should have a Slack notification agent");

    // LLM validates the entire workflow meets requirements
    const workflowEvaluation = await llmJudge({
      criteria: `The workspace should effectively:
        1. Monitor a directory for meeting transcript files
        2. Read and extract content from transcript files
        3. Analyze transcripts for key learnings and action items
        4. Share insights with team via Slack
        The agents should handle file reading, analysis, and Slack communication.`,
      agentOutput: result.config,
    });
    assert(
      workflowEvaluation.pass,
      `Workflow validation failed: ${workflowEvaluation.justification}`,
    );

    // Jobs orchestrate agent execution in response to signals
    assert(result.config.jobs, "Should have jobs defined");
    const job = Object.values(result.config.jobs).at(0);
    assert(job, "Should have at least one job");
    assert(job.execution?.strategy === "sequential", "Job should execute agents sequentially");

    return { result, metrics, executionTimeMs };
  });

  /**
   * Tests simple file monitoring with Slack notifications.
   * Validates minimal agent setup for straightforward workflows.
   */
  await step(t, "File Watcher with Slack Notifications", async ({ snapshot }) => {
    // Reset adapter and create fresh context for this test
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const startTime = performance.now();
    const result = await workspaceCreationAgent.execute(
      "I would like to create a simple workspace that is watching path /Users/ericskram/Desktop/foo for any changes and send message to slack on channel #sara-bot-test about anything what changes there (removal, modification etc.)",
      context,
    );
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    snapshot({
      result,
      metrics,
      streamEvents,
      timing: {
        executionTimeMs,
        executionTimeSec: executionTimeMs / 1000,
        executionTimeMin: executionTimeMs / 60000,
      },
    });

    assert(result.success === true, "Workspace should be created successfully");

    // Agent count reflects task simplicity (file watch + Slack notify)
    assert(
      result.summary.agentCount >= 2 && result.summary.agentCount <= 3,
      `Should have 2-3 agents, got ${result.summary.agentCount}`,
    );

    assert(result.summary.signalCount === 1, "Should have exactly 1 signal for file watching");
    assert(result.summary.jobCount === 1, "Should have exactly 1 job");

    assert(result.config.signals, "Should have signals defined");
    const signals = Object.values(result.config.signals);
    assert(signals.length === 1, "Should have exactly 1 signal");
    const firstSignal = signals.at(0);
    assert(firstSignal, "Should have first signal");
    assert(firstSignal.provider === "fs-watch", "Signal should be fs-watch provider");
    assert(
      "config" in firstSignal && firstSignal.config?.path?.includes("/Users/ericskram/Desktop/foo"),
      "Signal should watch the specified path",
    );

    assert(result.config.agents, "Should have agents defined");
    const agents = Object.values(result.config.agents);
    const slackAgent = agents.find(
      (agent) =>
        (agent.type === "atlas" && agent.agent === "slack") ||
        agent.description?.toLowerCase().includes("slack"),
    );
    assert(slackAgent, "Should have a Slack notification agent");

    // LLM validates channel-specific Slack configuration
    const slackConfigEvaluation = await llmJudge({
      criteria: `The workspace should:
        1. Watch the exact path /Users/ericskram/Desktop/foo
        2. Detect file changes (creation, modification, deletion)
        3. Send notifications to Slack channel #sara-bot-test
        4. Report what specific changes occurred
        The configuration should reference the correct channel.`,
      agentOutput: result.config,
    });
    assert(
      slackConfigEvaluation.pass,
      `Slack config validation failed: ${slackConfigEvaluation.justification}`,
    );

    // Prevent over-engineering simple workflows
    assert(
      result.summary.agentCount <= 3,
      `Should have at most 3 agents for this simple task, got ${result.summary.agentCount}`,
    );

    return { result, metrics, executionTimeMs };
  });

  /**
   * Tests scheduled workflow with bundled agents.
   * Validates use of targeted-research agent and schedule signals for recurring tasks.
   */
  await step(t, "Weekly Cultural Events Email", async ({ snapshot }) => {
    // Reset adapter and create fresh context for this test
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const startTime = performance.now();
    const result = await workspaceCreationAgent.execute(
      "I want to receive a weekly email every Monday morning with upcoming cultural events in Luxembourg City. The email should include concerts, exhibitions, theater performances, and festivals happening in the next 7 days.",
      context,
    );
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    snapshot({
      result,
      metrics,
      streamEvents,
      timing: {
        executionTimeMs,
        executionTimeSec: executionTimeMs / 1000,
        executionTimeMin: executionTimeMs / 60000,
      },
    });

    assert(result.success === true, "Workspace should be created successfully");

    // Research + email workflow requires 2-4 specialized agents
    assert(
      result.summary.agentCount >= 2 && result.summary.agentCount <= 4,
      `Should have 2-4 agents, got ${result.summary.agentCount}`,
    );

    assert(result.summary.signalCount === 1, "Should have exactly 1 signal for weekly schedule");
    assert(result.summary.jobCount === 1, "Should have exactly 1 job");

    assert(result.config.signals, "Should have signals defined");
    const signals = Object.values(result.config.signals);
    assert(signals.length === 1, "Should have exactly 1 signal");
    const firstSignal = signals.at(0);
    assert(firstSignal, "Should have first signal");
    assert(firstSignal.provider === "schedule", "Signal should be a schedule provider");
    assert(
      "config" in firstSignal && firstSignal.config?.schedule,
      "Signal should have a cron schedule",
    );

    // Targeted-research is a bundled agent optimized for web data collection
    assert(result.config.agents, "Should have agents defined");
    const agents = Object.values(result.config.agents);
    const hasTargetedResearch = agents.some(
      (agent) => agent.type === "atlas" && agent.agent === "targeted-research",
    );
    assert(hasTargetedResearch, "Should have an atlas targeted-research agent");

    const workflowEvaluation = await llmJudge({
      criteria: `The workspace should effectively:
        1. Be triggered weekly (preferably Monday morning)
        2. Research/collect cultural events in Luxembourg City
        3. Include concerts, exhibitions, theater, and festivals
        4. Format events for email presentation
        5. Send email to recipient
        The agents should work together to accomplish this workflow.`,
      agentOutput: result.config,
    });
    assert(
      workflowEvaluation.pass,
      `Workflow validation failed: ${workflowEvaluation.justification}`,
    );

    return { result, metrics, executionTimeMs };
  });
});
