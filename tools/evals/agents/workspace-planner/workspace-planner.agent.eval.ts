import { client, parseResult } from "@atlas/client/v2";
import type { WorkspacePlan } from "@atlas/core/artifacts";
import { workspacePlannerAgent } from "@atlas/system/agents";
import { assert } from "@std/assert";
import { AgentContextAdapter } from "../../lib/context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { setupTest } from "../../lib/utils.ts";

const { step } = setupTest({ testFileUrl: new URL(import.meta.url) });

/**
 * Tests workspace planner agent: converts natural language to prose workspace plans.
 *
 * Input: { intent: string, artifactId?: string }
 * Output: { artifactId, revision, planSummary }
 *
 * Requires live daemon. Creates/updates artifacts via HTTP. Supports revisions.
 */
Deno.test("Workspace Planner Agent", async (t) => {
  await loadCredentials();
  const adapter = new AgentContextAdapter();
  adapter.enableTelemetry();

  await step(t, "Initial Plan Creation: File Monitoring", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const startTime = performance.now();

    const input = {
      intent:
        "Monitor a directory /Users/test/notes for new meeting notes. When a note is added, extract key insights and action items, then post a summary to Slack #team-updates.",
    };

    const result = await workspacePlannerAgent.execute(input, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    assert(result.ok, "Should execute successfully");
    assert(result.data.artifactId, "Should return artifact ID");
    assert(result.data.revision === 1, "Initial plan should be revision 1");

    const artifactResponse = await parseResult(
      client.artifactsStorage[":id"].$get({ param: { id: result.data.artifactId } }),
    );
    assert(
      artifactResponse.ok,
      `Failed to fetch artifact: ${JSON.stringify(!artifactResponse.ok && artifactResponse.error)}`,
    );

    assert(
      artifactResponse.data.artifact.data.type === "workspace-plan",
      "Should create workspace-plan artifact",
    );
    const planData: WorkspacePlan = artifactResponse.data.artifact.data.data;

    snapshot({ input, result, planData, metrics, streamEvents, timing: { executionTimeMs } });

    assert(planData.workspace, "Plan should have workspace metadata");
    assert(planData.workspace.name, "Plan should have workspace name");
    assert(planData.workspace.purpose, "Plan should have workspace purpose");
    assert(planData.signals.length > 0, "Plan should define signals");
    assert(planData.agents.length > 0, "Plan should define agents");
    assert(planData.jobs.length > 0, "Plan should define jobs");

    const planQualityEval = await llmJudge({
      criteria: `The workspace plan should:
        1. Define a file-watching signal for the specified directory (/Users/test/notes)
        2. Include agents for: file reading, insight extraction, Slack notification
        3. Describe agents in prose (WHAT they do, not HOW they implement it)
        4. Capture user-specific details (channel name: #team-updates, directory path)
        5. Define a job connecting the signal to agents with clear execution flow
        6. Use clear, non-technical language that a non-technical user can understand
        The plan describes the automation's behavior, not implementation details.`,
      agentOutput: planData,
    });
    assert(
      planQualityEval.pass,
      `Plan quality validation failed: ${planQualityEval.justification}`,
    );

    return { result, planData, metrics, executionTimeMs };
  });

  await step(t, "Plan Revision: Add Monitoring Target", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const initialInput = {
      intent:
        "Monitor Nike.com for new shoe releases every 30 minutes and alert Discord #sneakers.",
    };
    const initialResult = await workspacePlannerAgent.execute(initialInput, context);
    assert(initialResult.ok, "Should execute successfully");
    assert(initialResult.data.artifactId, "Should return artifact ID from initial plan");
    assert(initialResult.data.revision === 1, "Initial plan should be revision 1");

    const startTime = performance.now();
    const revisionInput = {
      intent: "Also monitor Adidas.com for new releases.",
      artifactId: initialResult.data.artifactId,
    };

    const result = await workspacePlannerAgent.execute(revisionInput, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    assert(result.ok);
    assert(result.data.artifactId, "Should return artifact ID");
    assert(
      result.data.artifactId === initialResult.data.artifactId,
      "Artifact ID should remain the same",
    );
    assert(result.data.revision === 2, "Revised plan should be revision 2");
    assert(result.data.planSummary, "Should return plan summary");

    const artifactResponse = await parseResult(
      client.artifactsStorage[":id"].$get({ param: { id: result.data.artifactId } }),
    );
    assert(
      artifactResponse.ok,
      `Failed to fetch artifact: ${JSON.stringify(!artifactResponse.ok && artifactResponse.error)}`,
    );

    assert(
      artifactResponse.data.artifact.data.type === "workspace-plan",
      "Should be workspace-plan artifact",
    );
    const planData: WorkspacePlan = artifactResponse.data.artifact.data.data;

    snapshot({
      initialInput,
      initialResult,
      revisionInput,
      result,
      planData,
      metrics,
      streamEvents,
      timing: { executionTimeMs },
    });

    const revisionQualityEval = await llmJudge({
      criteria: `The revised workspace plan should:
        1. Retain the original Nike.com monitoring requirement
        2. Add Adidas.com monitoring as requested
        3. Maintain the Discord #sneakers notification requirement
        4. Update agents/signals appropriately to handle both sites (likely 2 monitoring agents)
        5. Keep the prose descriptions clear and user-friendly
        The plan should reflect that this workspace monitors BOTH Nike and Adidas sites.`,
      agentOutput: planData,
    });
    assert(
      revisionQualityEval.pass,
      `Revision quality validation failed: ${revisionQualityEval.justification}`,
    );

    return { initialResult, result, planData, metrics, executionTimeMs };
  });

  await step(t, "Initial Plan Creation: Scheduled Task", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const startTime = performance.now();
    const input = {
      intent:
        "Every Monday at 9am, research upcoming cultural events in Luxembourg and email a summary to team@company.com.",
    };

    const result = await workspacePlannerAgent.execute(input, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    assert(result.ok, "Should execute successfully");
    assert(result.data.artifactId, "Should return artifact ID");
    assert(result.data.revision === 1, "Initial plan should be revision 1");
    assert(result.data.planSummary, "Should return plan summary");

    const artifactResponse = await parseResult(
      client.artifactsStorage[":id"].$get({ param: { id: result.data.artifactId } }),
    );
    assert(
      artifactResponse.ok,
      `Failed to fetch artifact: ${JSON.stringify(!artifactResponse.ok && artifactResponse.error)}`,
    );

    assert(
      artifactResponse.data.artifact.data.type === "workspace-plan",
      "Should be workspace-plan artifact",
    );
    const planData: WorkspacePlan = artifactResponse.data.artifact.data.data;

    snapshot({ input, result, planData, metrics, streamEvents, timing: { executionTimeMs } });

    assert(planData.signals.length >= 1, "Should have at least one signal");
    const scheduleSignal = planData.signals.find(
      (s) =>
        s.description.toLowerCase().includes("monday") ||
        s.description.toLowerCase().includes("weekly") ||
        s.description.toLowerCase().includes("9"),
    );
    assert(scheduleSignal, "Should have a schedule-based signal mentioning timing");

    const scheduleEval = await llmJudge({
      criteria: `The workspace plan should:
        1. Define a schedule-based signal for Monday mornings (9am or similar)
        2. Include agents for: research (cultural events), email composition/sending
        3. Capture the specific location (Luxembourg) and recipient (team@company.com)
        4. Describe a clear job flow connecting the schedule to the agents
        5. Use prose that explains timing rationale ("weekly update on Mondays" or similar)
        The plan should make it clear this is a recurring weekly task.`,
      agentOutput: planData,
    });
    assert(scheduleEval.pass, `Schedule interpretation failed: ${scheduleEval.justification}`);

    return { result, planData, metrics, executionTimeMs };
  });

  await step(t, "Initial Plan Creation: Webhook Trigger", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const startTime = performance.now();
    const input = {
      intent:
        "When a GitHub webhook indicates a new pull request on our repo, analyze the PR for code quality issues and post a review comment.",
    };

    const result = await workspacePlannerAgent.execute(input, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    assert(result.ok, "Should execute successfully");
    assert(result.data.artifactId, "Should return artifact ID");
    assert(result.data.revision === 1, "Initial plan should be revision 1");
    assert(result.data.planSummary, "Should return plan summary");

    const artifactResponse = await parseResult(
      client.artifactsStorage[":id"].$get({ param: { id: result.data.artifactId } }),
    );
    assert(
      artifactResponse.ok,
      `Failed to fetch artifact: ${JSON.stringify(!artifactResponse.ok && artifactResponse.error)}`,
    );

    assert(
      artifactResponse.data.artifact.data.type === "workspace-plan",
      "Should be workspace-plan artifact",
    );
    const planData: WorkspacePlan = artifactResponse.data.artifact.data.data;

    snapshot({ input, result, planData, metrics, streamEvents, timing: { executionTimeMs } });

    assert(planData.signals.length >= 1, "Should have at least one signal");
    const webhookSignal = planData.signals.find(
      (s) =>
        (s.description.toLowerCase().includes("github") ||
          s.description.toLowerCase().includes("pull request") ||
          s.description.toLowerCase().includes("pr")) &&
        (s.description.toLowerCase().includes("webhook") ||
          s.description.toLowerCase().includes("http") ||
          s.description.toLowerCase().includes("event")),
    );
    assert(webhookSignal, "Should have a webhook/event-based signal for GitHub PRs");

    const webhookEval = await llmJudge({
      criteria: `The workspace plan should:
        1. Define a webhook/HTTP signal for GitHub pull request events
        2. Include agents for: PR data extraction, code analysis, comment posting
        3. Describe event-driven execution (responds to incoming webhook events)
        4. Define a job that triggers when the webhook receives PR events
        5. Use prose that explains reactive nature ("when PR is created" or "when webhook receives")
        The plan should clearly indicate this is triggered by external events, not scheduled.`,
      agentOutput: planData,
    });
    assert(webhookEval.pass, `Webhook interpretation failed: ${webhookEval.justification}`);

    return { result, planData, metrics, executionTimeMs };
  });

  await step(
    t,
    "Investor Briefing: Daily Schedule with Multi-Source Integration",
    async ({ snapshot }) => {
      adapter.reset();
      const context = adapter.createContext({ telemetry: true });

      const startTime = performance.now();
      const input = {
        intent:
          "Every morning at 8am PST, send me a briefing about my day's meetings. Check my Google Calendar for today's events, and for each company I'm meeting with, research the company (what they do, funding stage, key metrics) and founding team backgrounds. Compile everything into an email and send it to vc@example.com. Run this daily, including weekends.",
      };

      const result = await workspacePlannerAgent.execute(input, context);
      const executionTimeMs = performance.now() - startTime;

      const metrics = adapter.getMetrics();
      const streamEvents = adapter.getStreamEvents();

      assert(result.ok, "Should execute successfully");
      assert(result.data.artifactId, "Should return artifact ID");
      assert(result.data.revision === 1, "Initial plan should be revision 1");

      const artifactResponse = await parseResult(
        client.artifactsStorage[":id"].$get({ param: { id: result.data.artifactId } }),
      );
      assert(artifactResponse.ok, "Should fetch artifact successfully");
      assert(
        artifactResponse.data.artifact.data.type === "workspace-plan",
        "Should be workspace-plan artifact",
      );
      const planData: WorkspacePlan = artifactResponse.data.artifact.data.data;

      snapshot({ input, result, planData, metrics, streamEvents, timing: { executionTimeMs } });

      // Structural assertions
      assert(planData.signals.length >= 1, "Should have at least one signal");
      assert(planData.agents.length > 0, "Should have agents");
      assert(planData.jobs.length >= 1, "Should have at least one job");

      // Check for email configuration capture
      const hasEmailConfig = planData.agents.some(
        (a) =>
          a.configuration?.email === "vc@example.com" ||
          (a.configuration && JSON.stringify(a.configuration).includes("vc@example.com")),
      );
      assert(hasEmailConfig, "Should capture email address in agent configuration");

      const investorBriefingEval = await llmJudge({
        criteria: `The workspace plan should:
        1. Define a daily schedule signal at 8am PST (or equivalent)
        2. Include distinct agents for: calendar fetching, company research, team research, email composition
        3. Capture configuration: email address (vc@example.com), timezone (PST), daily frequency including weekends
        4. Define sequential job flow (fetch calendar → research companies → research teams → compose email → send)
        5. Use clear prose explaining the multi-step workflow
        6. Agent descriptions should focus on WHAT they accomplish (e.g., "researches company background"), not HOW
        The plan should reflect a complex sequential workflow with multiple data sources feeding into a final email.`,
        agentOutput: planData,
      });
      assert(
        investorBriefingEval.pass,
        `Investor briefing validation failed: ${investorBriefingEval.justification}`,
      );

      return { result, planData, metrics, executionTimeMs };
    },
  );

  await step(
    t,
    "Sneaker Drop Monitor: High-Frequency Conditional Execution",
    async ({ snapshot }) => {
      adapter.reset();
      const context = adapter.createContext({ telemetry: true });

      const startTime = performance.now();
      const input = {
        intent:
          "Monitor Nike.com and Adidas.com for new shoe releases. Check every 30 minutes during business hours (9am-6pm EST). When new products appear, send an alert to Discord channel #sneaker-drops with the product name, price, and direct link. Only alert on products that weren't there in the previous check.",
      };

      const result = await workspacePlannerAgent.execute(input, context);
      const executionTimeMs = performance.now() - startTime;

      const metrics = adapter.getMetrics();
      const streamEvents = adapter.getStreamEvents();

      assert(result.ok, "Should execute successfully");
      assert(result.data.artifactId, "Should return artifact ID");
      assert(result.data.revision === 1, "Initial plan should be revision 1");

      const artifactResponse = await parseResult(
        client.artifactsStorage[":id"].$get({ param: { id: result.data.artifactId } }),
      );
      assert(artifactResponse.ok, "Should fetch artifact successfully");
      assert(
        artifactResponse.data.artifact.data.type === "workspace-plan",
        "Artifact should be a workspace plan",
      );
      const planData: WorkspacePlan = artifactResponse.data.artifact.data.data;

      snapshot({ input, result, planData, metrics, streamEvents, timing: { executionTimeMs } });

      // Structural assertions
      assert(planData.signals.length >= 1, "Should have schedule signal");
      assert(planData.agents.length > 0, "Should have agents");

      // Check for Discord channel configuration
      const hasDiscordConfig = planData.agents.some(
        (a) =>
          a.configuration?.channel === "#sneaker-drops" ||
          (a.configuration && JSON.stringify(a.configuration).includes("#sneaker-drops")),
      );
      assert(hasDiscordConfig, "Should capture Discord channel in agent configuration");

      // URL configuration may be in agent descriptions/needs rather than configuration object - llmJudge will verify

      const sneakerMonitorEval = await llmJudge({
        criteria: `The workspace plan should:
        1. Define a schedule signal for every 30 minutes during business hours (9am-6pm EST or similar time window)
        2. Include agents for: website scraping (Nike and/or Adidas), product comparison/deduplication, Discord notification
        3. Capture configuration: Discord channel (#sneaker-drops), website URLs, time window constraints
        4. Describe conditional execution logic (only notify when new products detected, not on every check)
        5. Address deduplication requirement (comparing against previous checks)
        6. Use prose that explains the monitoring frequency and conditional alerting behavior
        The plan should clearly indicate high-frequency polling with smart conditional notifications.`,
        agentOutput: planData,
      });
      assert(
        sneakerMonitorEval.pass,
        `Sneaker monitor validation failed: ${sneakerMonitorEval.justification}`,
      );

      return { result, planData, metrics, executionTimeMs };
    },
  );

  await step(
    t,
    "GitHub CI Pipeline: Parallel Execution with Multiple Outputs",
    async ({ snapshot }) => {
      adapter.reset();
      const context = adapter.createContext({ telemetry: true });

      const startTime = performance.now();
      const input = {
        intent:
          "When code is pushed to the main branch on my GitHub repo, run these checks in parallel: 1) Run the test suite and get coverage metrics, 2) Check for security vulnerabilities with a code scanner, 3) Verify all dependencies are up to date. Post results to Slack #ci-alerts and comment on the commit with a summary. Repository is github.com/myorg/myrepo.",
      };

      const result = await workspacePlannerAgent.execute(input, context);
      const executionTimeMs = performance.now() - startTime;

      const metrics = adapter.getMetrics();
      const streamEvents = adapter.getStreamEvents();

      assert(result.ok, "Should execute successfully");
      assert(result.data.artifactId, "Should return artifact ID");

      const artifactResponse = await parseResult(
        client.artifactsStorage[":id"].$get({ param: { id: result.data.artifactId } }),
      );
      assert(artifactResponse.ok, "Should fetch artifact successfully");
      assert(
        artifactResponse.data.artifact.data.type === "workspace-plan",
        "Artifact should be a workspace plan",
      );
      const planData: WorkspacePlan = artifactResponse.data.artifact.data.data;

      snapshot({ input, result, planData, metrics, streamEvents, timing: { executionTimeMs } });

      // Structural assertions
      assert(planData.signals.length >= 1, "Should have webhook signal");
      assert(planData.agents.length > 0, "Should have agents");
      assert(planData.jobs.length >= 1, "Should have job orchestrating the flow");

      // Check for parallel execution behavior (LLM may choose sequential, which is also valid)
      // We'll verify this via llmJudge instead of strict assertion

      // Check for repo configuration
      const hasRepoConfig = planData.agents.some(
        (a) =>
          (a.configuration &&
            JSON.stringify(a.configuration).includes("github.com/myorg/myrepo")) ||
          (a.configuration && JSON.stringify(a.configuration).includes("myorg/myrepo")),
      );
      assert(hasRepoConfig, "Should capture repository URL in agent configuration");

      const ciPipelineEval = await llmJudge({
        criteria: `The workspace plan should:
        1. Define a webhook signal for GitHub push events to main branch
        2. Include separate agents for: test runner, security scanner, dependency checker, Slack notifier, GitHub commenter
        3. Capture configuration: repository URL (github.com/myorg/myrepo), Slack channel (#ci-alerts), branch filter (main)
        4. Define job orchestrating the 3 checks and notifications (parallel execution is ideal but sequential is acceptable)
        5. Describe the execution flow clearly in job descriptions
        The plan should demonstrate understanding of CI pipeline orchestration.`,
        agentOutput: planData,
      });
      assert(ciPipelineEval.pass, `CI pipeline validation failed: ${ciPipelineEval.justification}`);

      return { result, planData, metrics, executionTimeMs };
    },
  );

  await step(t, "Content Digest: Weekly Aggregation with Summarization", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const startTime = performance.now();
    const input = {
      intent:
        "Every Monday at 9am, create a weekly digest of AI/ML news. Pull top posts from Hacker News (ML category), latest papers from arXiv cs.AI, and trending AI repositories on GitHub from the past week. Summarize the most interesting 5-10 items with a brief description of why they matter. Send the digest to my email: newsletter@example.com.",
    };

    const result = await workspacePlannerAgent.execute(input, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    assert(result.ok, "Should execute successfully");
    assert(result.data.artifactId, "Should return artifact ID");

    const artifactResponse = await parseResult(
      client.artifactsStorage[":id"].$get({ param: { id: result.data.artifactId } }),
    );
    assert(artifactResponse.ok, "Should fetch artifact successfully");
    assert(
      artifactResponse.data.artifact.data.type === "workspace-plan",
      "Artifact should be a workspace plan",
    );
    const planData: WorkspacePlan = artifactResponse.data.artifact.data.data;

    snapshot({ input, result, planData, metrics, streamEvents, timing: { executionTimeMs } });

    // Structural assertions
    assert(planData.signals.length >= 1, "Should have weekly schedule signal");
    assert(planData.agents.length > 0, "Should have agents");

    // Check for weekly timing
    const hasWeeklySignal = planData.signals.some(
      (s) =>
        s.description.toLowerCase().includes("monday") ||
        s.description.toLowerCase().includes("weekly"),
    );
    assert(hasWeeklySignal, "Should have a signal that mentions Monday or weekly frequency");

    // Check for email configuration
    const hasEmailConfig = planData.agents.some(
      (a) =>
        a.configuration?.email === "newsletter@example.com" ||
        (a.configuration && JSON.stringify(a.configuration).includes("newsletter@example.com")),
    );
    assert(hasEmailConfig, "Should capture email address in agent configuration");

    const contentDigestEval = await llmJudge({
      criteria: `The workspace plan should:
        1. Define a weekly schedule signal for Monday mornings at 9am
        2. Include separate agents for: Hacker News fetcher, arXiv fetcher, GitHub trends fetcher, content curator/summarizer, email sender
        3. Capture configuration: email address (newsletter@example.com), categories/filters (ML, AI), timeframe (past week), item limit (5-10)
        4. Describe job flow with data aggregation phase (fetching from 3 sources) followed by curation/summarization
        5. Explain the curation step (selecting most interesting items, explaining significance)
        6. Use prose that makes the weekly digest nature clear
        The plan should show understanding of aggregation → curation → delivery workflow.`,
      agentOutput: planData,
    });
    assert(
      contentDigestEval.pass,
      `Content digest validation failed: ${contentDigestEval.justification}`,
    );

    return { result, planData, metrics, executionTimeMs };
  });

  await step(t, "Customer Support Triage: Conditional Branching Logic", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const startTime = performance.now();
    const input = {
      intent:
        "When a new support ticket arrives in Zendesk, analyze the ticket content and automatically categorize it (billing, technical, feature request, other). For technical issues, check if there's a known solution in our documentation and suggest it. For billing issues, flag for urgent review. Update the ticket with the category tag and any suggested solutions. Send a summary to Slack #support-triage.",
    };

    const result = await workspacePlannerAgent.execute(input, context);
    const executionTimeMs = performance.now() - startTime;

    const metrics = adapter.getMetrics();
    const streamEvents = adapter.getStreamEvents();

    assert(result.ok, "Should execute successfully");
    assert(result.data.artifactId, "Should return artifact ID");

    const artifactResponse = await parseResult(
      client.artifactsStorage[":id"].$get({ param: { id: result.data.artifactId } }),
    );
    assert(artifactResponse.ok, "Should fetch artifact successfully");
    assert(
      artifactResponse.data.artifact.data.type === "workspace-plan",
      "Artifact should be a workspace plan",
    );
    const planData: WorkspacePlan = artifactResponse.data.artifact.data.data;

    snapshot({ input, result, planData, metrics, streamEvents, timing: { executionTimeMs } });

    // Structural assertions
    assert(planData.signals.length >= 1, "Should have webhook signal for Zendesk");
    assert(planData.agents.length > 0, "Should have agents");

    // Check for Slack channel configuration
    const hasSlackConfig = planData.agents.some(
      (a) =>
        a.configuration?.channel === "#support-triage" ||
        (a.configuration && JSON.stringify(a.configuration).includes("#support-triage")),
    );
    assert(hasSlackConfig, "Should capture Slack channel in agent configuration");

    const supportTriageEval = await llmJudge({
      criteria: `The workspace plan should:
        1. Define a webhook signal for Zendesk ticket creation events
        2. Include agents for: ticket analyzer/categorizer, documentation searcher, ticket updater, Slack notifier
        3. Capture configuration: Slack channel (#support-triage), Zendesk integration, categorization taxonomy (billing, technical, feature request, other)
        4. Describe conditional/branching logic (technical issues → search docs, billing issues → urgent flag)
        5. Explain category-specific handling in prose (different actions for different ticket types)
        6. Address the workflow: analyze → categorize → conditional action → update ticket → notify
        The plan should demonstrate understanding of conditional workflows where different paths are taken based on classification.`,
      agentOutput: planData,
    });
    assert(
      supportTriageEval.pass,
      `Support triage validation failed: ${supportTriageEval.justification}`,
    );

    return { result, planData, metrics, executionTimeMs };
  });

  await step(
    t,
    "LinkedIn Outreach: Complex Daily Workflow with Persistence",
    async ({ snapshot }) => {
      adapter.reset();
      const context = adapter.createContext({ telemetry: true });

      const startTime = performance.now();
      const input = {
        intent:
          "Create an automated email reminder system that:\n1. Loads LinkedIn connections from CSV file (/Users/odk/Downloads/Connections.csv)\n2. Research each company to filter for New York-based companies with 50+ employees\n3. Daily at 8 AM on weekdays, randomly select 3 people from the filtered list\n4. For each selected person, research both the individual and company to generate:\n   - Person's name, company, and title\n   - 4-sentence company summary\n   - 5 bullet points about the person\n   - 3 ideas for potential intro outreach messages\n5. Send structured email to michal@tempest.team with all this information\n\nThe system should maintain a database of researched companies to avoid re-researching, and track which people have been selected to ensure variety over time.",
      };

      const result = await workspacePlannerAgent.execute(input, context);
      const executionTimeMs = performance.now() - startTime;

      const metrics = adapter.getMetrics();
      const streamEvents = adapter.getStreamEvents();

      assert(result.ok, "Should execute successfully");
      assert(result.data.artifactId, "Should return artifact ID");

      const artifactResponse = await parseResult(
        client.artifactsStorage[":id"].$get({ param: { id: result.data.artifactId } }),
      );
      assert(artifactResponse.ok, "Should fetch artifact successfully");
      assert(
        artifactResponse.data.artifact.data.type === "workspace-plan",
        "Artifact should be a workspace plan",
      );
      const planData: WorkspacePlan = artifactResponse.data.artifact.data.data;

      snapshot({ input, result, planData, metrics, streamEvents, timing: { executionTimeMs } });

      // Structural assertions
      assert(planData.signals.length >= 1, "Should have daily schedule signal");
      assert(planData.agents.length > 0, "Should have agents");
      assert(planData.jobs.length >= 1, "Should have job orchestrating the workflow");

      // Check for email configuration
      const hasEmailConfig = planData.agents.some(
        (a) =>
          a.configuration?.email === "michal@tempest.team" ||
          (a.configuration && JSON.stringify(a.configuration).includes("michal@tempest.team")),
      );
      assert(hasEmailConfig, "Should capture email address in agent configuration");

      // Check for file path configuration
      const hasFilePathConfig =
        JSON.stringify(planData).includes("/Users/odk/Downloads/Connections.csv") ||
        JSON.stringify(planData).includes("Connections.csv");
      assert(hasFilePathConfig, "Should reference the CSV file path");

      const linkedinOutreachEval = await llmJudge({
        criteria: `The workspace plan should:
          1. Define a weekday schedule signal at 8 AM (Monday-Friday)
          2. Show clear understanding of data persistence needs (tracking researched companies and previously selected people)
          3. Include agents for distinct phases: CSV loading, company research/filtering (NY + 50+ employees), person selection (random 3), detailed research, email composition
          4. Capture configuration: email address (michal@tempest.team), file path, company filters (NY location, 50+ employees), selection count (3 people), email content structure
          5. Demonstrate understanding of stateful operations (maintaining database to avoid re-research and ensure variety)
          6. Define sequential job flow with clear dependencies between phases
          The plan must show it grasps the complexity: initial filtering phase → persistence layer → daily selection → research → structured output.`,
        agentOutput: planData,
      });
      assert(
        linkedinOutreachEval.pass,
        `LinkedIn outreach validation failed: ${linkedinOutreachEval.justification}`,
      );

      return { result, planData, metrics, executionTimeMs };
    },
  );
});
