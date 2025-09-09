import { logger } from "@atlas/logger";
import { assert } from "@std/assert";
import { WorkspaceBuilder } from "../../../../../packages/system/agents/workspace-creation/builder.ts";
import { getGenerateAgentsTool } from "../../../../../packages/system/agents/workspace-creation/tools/generate-agents.ts";
import { llmJudge } from "../../../lib/llm-judge.ts";
import { loadCredentials } from "../../../lib/load-credentials.ts";
import { setupTest, unwrapToolResult } from "../../../lib/utils.ts";

const { step } = setupTest({ testFileUrl: new URL(import.meta.url) });

Deno.test("Workspace Creation Agent: generateAgentsArchetype", async (t) => {
  await loadCredentials();
  const builder = new WorkspaceBuilder();
  builder.setIdentity("Product Discovery Workspace", "Analyze user feedback from discovery calls");
  const tool = getGenerateAgentsTool(builder, logger);

  await step(t, "Product manager discovery workflow", async ({ snapshot }) => {
    const agentRequirements = [
      "reader: Extract and parse meeting transcripts from uploaded PDF/DOCX files",
      "analyzer: Analyze transcripts for critical product feedback and insights",
      "notifier: Send feedback summary to team Slack channel via API",
    ];

    const startTime = performance.now();
    const toolResult = await tool.execute?.(
      { agentRequirements },
      { messages: [], toolCallId: "" },
    );
    const executionTimeMs = performance.now() - startTime;
    assert(toolResult, "Should have a result");
    const res = await unwrapToolResult(toolResult);

    // Type guard to check success
    assert(
      res.success,
      `Tool execution failed: ${res.success === false ? res.error : "unknown error"}`,
    );

    const workspaceConfig = builder.exportConfig();
    const agents = workspaceConfig.agents;
    assert(agents, "Should have agents in config");

    // Use LLM judge to evaluate single responsibility principle
    const singleResponsibilityEval = await llmJudge({
      criteria: `Evaluate if the generated agents follow the single responsibility principle.
      Each agent should:
      - Have a clear, focused purpose
      - Do exactly one thing well
      - Not combine multiple unrelated responsibilities

      Expected agents:
      1. A reader/extraction agent for transcripts
      2. An analyzer agent for feedback analysis
      3. A notifier agent for team communication

      Check if agent IDs and configurations reflect these distinct responsibilities.`,
      agentOutput: JSON.stringify({ agentIds: res.agentIds, agents }, null, 2),
    });

    // Use LLM judge to evaluate model selection
    const modelSelectionEval = await llmJudge({
      criteria: `Evaluate if the model selection is appropriate for each agent's complexity.
      Rules:
      - Simple extraction/reading tasks should use Haiku (claude-3-5-haiku-latest)
      - Complex analysis tasks should use Sonnet (claude-3-5-sonnet-20241022)
      - Notification tasks can use either based on complexity

      Check if the model assignments match the task complexity.`,
      agentOutput: JSON.stringify(
        Object.entries(agents).map(([id, agent]) => ({
          id,
          type: agent.type,
          model: agent.type === "llm" ? agent.config?.model : "N/A",
        })),
        null,
        2,
      ),
    });

    snapshot({
      res,
      workspaceConfig,
      agents: workspaceConfig.agents,
      agentCount: Object.keys(workspaceConfig.agents || {}).length,
      timing: { executionTimeMs, executionTimeSec: executionTimeMs / 1000 },
      evaluations: {
        singleResponsibility: {
          pass: singleResponsibilityEval.pass,
          justification: singleResponsibilityEval.justification,
        },
        modelSelection: {
          pass: modelSelectionEval.pass,
          justification: modelSelectionEval.justification,
        },
      },
    });

    // Basic assertions
    assert(res.totalAgents === 3, `Expected 3 agents, got ${res.totalAgents}`);
    assert(res.agentIds, "Should have agentIds");

    // Verify evaluations passed
    assert(
      singleResponsibilityEval.pass,
      `Single responsibility check failed: ${singleResponsibilityEval.justification}`,
    );
    assert(
      modelSelectionEval.pass,
      `Model selection check failed: ${modelSelectionEval.justification}`,
    );

    return res;
  });

  builder.reset();
  builder.setIdentity("Complex Analysis Workspace", "Multi-stage data processing");

  await step(t, "Complex multi-stage workflow", async ({ snapshot }) => {
    const agentRequirements = [
      "collector: Monitor GitHub for new issues and fetch issue details via API",
      "reader: Read and extract code from local repository files for context",
      "analyzer: Analyze issue severity and potential impact on the codebase",
      "reporter: Generate detailed report with recommendations",
      "notifier: Post summary to Slack channel",
      "notifier: Create task in Linear with issue details",
    ];

    const startTime = performance.now();
    const toolResult = await tool.execute?.(
      { agentRequirements },
      { messages: [], toolCallId: "" },
    );
    const executionTimeMs = performance.now() - startTime;
    assert(toolResult, "Should have a result");
    const res = await unwrapToolResult(toolResult);

    // Type guard to check success
    assert(
      res.success,
      `Tool execution failed: ${res.success === false ? res.error : "unknown error"}`,
    );

    const workspaceConfig = builder.exportConfig();
    const agents = workspaceConfig.agents;
    assert(agents, "Should have agents in config");

    // Use LLM judge for complex workflow evaluation
    const workflowComplexityEval = await llmJudge({
      criteria: `Evaluate if the generated agents properly handle a complex multi-stage workflow.
      The workflow should have:
      1. A collector agent for GitHub API monitoring
      2. A reader agent for local file extraction
      3. An analyzer agent for severity/impact analysis
      4. A reporter agent for generating reports
      5. Two separate notifier agents (one for Slack, one for Linear)

      Total expected: At least 6 agents

      Each agent should have a single, clear responsibility.
      Agents should NOT combine unrelated tasks.`,
      agentOutput: JSON.stringify(
        { agentIds: res.agentIds, totalAgents: res.totalAgents },
        null,
        2,
      ),
    });

    // Use LLM judge for separation of concerns
    const separationEval = await llmJudge({
      criteria: `Evaluate if the two notifier requirements resulted in separate agents.
      Requirements specified:
      - "notifier: Post summary to Slack channel"
      - "notifier: Create task in Linear with issue details"

      These should be TWO SEPARATE agents, not one agent doing both tasks.
      Check if there are distinct agents for Slack and Linear notifications.`,
      agentOutput: JSON.stringify(res),
    });

    snapshot({
      res,
      workspaceConfig,
      agents: workspaceConfig.agents,
      agentCount: Object.keys(workspaceConfig.agents || {}).length,
      timing: { executionTimeMs, executionTimeSec: executionTimeMs / 1000 },
      evaluations: {
        workflowComplexity: {
          pass: workflowComplexityEval.pass,
          justification: workflowComplexityEval.justification,
        },
        separation: { pass: separationEval.pass, justification: separationEval.justification },
      },
    });

    // Basic assertions
    assert(
      res.totalAgents && res.totalAgents >= 6,
      `Expected at least 6 agents, got ${res.totalAgents}`,
    );
    assert(res.agentIds, "Should have agentIds");

    // Verify evaluations passed
    assert(
      workflowComplexityEval.pass,
      `Workflow complexity check failed: ${workflowComplexityEval.justification}`,
    );
    assert(
      separationEval.pass,
      `Separation of concerns check failed: ${separationEval.justification}`,
    );

    return res;
  });

  builder.reset();
  builder.setIdentity("Simple Notification Workspace", "Basic alerting");

  await step(t, "Simple workflow preferring bundled agents", async ({ snapshot }) => {
    const agentRequirements = [
      "collector: Fetch current weather forecast data from weather API",
      "notifier: Send weather forecast to Slack channel via API",
    ];

    const startTime = performance.now();
    const toolResult = await tool.execute?.(
      { agentRequirements },
      { messages: [], toolCallId: "" },
    );
    const executionTimeMs = performance.now() - startTime;
    assert(toolResult, "Should have a result");
    const res = await unwrapToolResult(toolResult);

    // Type guard to check success
    assert(
      res.success,
      `Tool execution failed: ${res.success === false ? res.error : "unknown error"}`,
    );

    const workspaceConfig = builder.exportConfig();
    const agents = workspaceConfig.agents;
    assert(agents, "Should have agents in config");

    // Use LLM judge for bundled agent preference
    const bundledAgentEval = await llmJudge({
      criteria: `Evaluate if the tool correctly prefers bundled agents when available.
      For this simple workflow:
      - Weather fetching requires a custom LLM agent
      - Slack notification should use a bundled agent if available

      The bundledCount should be at least 1 (for Slack).
      Total agents should be exactly 2.`,
      agentOutput: JSON.stringify(
        {
          agentIds: res.agentIds,
          totalAgents: res.totalAgents,
          bundledCount: res.bundledCount,
          agents: Object.entries(agents).map(([id, agent]) => ({ id, type: agent.type })),
        },
        null,
        2,
      ),
    });

    snapshot({
      res,
      workspaceConfig,
      agents: workspaceConfig.agents,
      agentCount: Object.keys(workspaceConfig.agents || {}).length,
      timing: { executionTimeMs, executionTimeSec: executionTimeMs / 1000 },
      evaluations: {
        bundledAgent: {
          pass: bundledAgentEval.pass,
          justification: bundledAgentEval.justification,
        },
      },
    });

    // Basic assertions
    assert(res.totalAgents === 2, `Expected 2 agents, got ${res.totalAgents}`);
    assert(res.bundledCount >= 1, "Should use at least one bundled agent (Slack)");
    assert(res.agentIds, "Should have agentIds");

    // Verify evaluation passed
    assert(
      bundledAgentEval.pass,
      `Bundled agent preference check failed: ${bundledAgentEval.justification}`,
    );

    return res;
  });
});
