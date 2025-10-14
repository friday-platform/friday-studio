import { client, parseResult } from "@atlas/client/v2";
import { sessionSupervisorAgent } from "@atlas/system/agents";
import { assert } from "@std/assert";
import { AgentContextAdapter } from "../../lib/context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { setupTest } from "../../lib/utils.ts";

const { step } = setupTest({ testFileUrl: new URL(import.meta.url) });

Deno.test("Smart Session Supervisor Agent", async (t) => {
  await loadCredentials();
  const adapter = new AgentContextAdapter();
  adapter.enableTelemetry();

  await step(t, "Customer Workflow: Daily Sales Report", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const input = {
      workflowIntent:
        "Collects sales data, formats it into a readable report, and emails it to stakeholders for daily review",
      agentSystemPrompt: "You send emails. Format messages and use email tools to deliver them.",
      agentInputSource: "combined" as const,
      signalPayload: { task: "Send daily report to team" },
      previousResults: [
        {
          agentId: "data-collector",
          task: "Collect sales metrics for the past 24 hours from the database",
          output: "Collected sales metrics: revenue $45k, 23 new customers, 12 support tickets",
        },
        {
          agentId: "report-formatter",
          task: "Format the sales data into an HTML report with charts and highlights",
          output: "Formatted report with charts and highlights. Created artifact with final HTML.",
          artifactRefs: [
            { id: "art-1", type: "document", summary: "Daily sales report with charts" },
          ],
        },
        {
          agentId: "unrelated-agent",
          task: "Update database schema to add new user preferences fields",
          output: "Updated database schema for user preferences table",
        },
      ],
      tokenBudget: { modelLimit: 200000, defaultBudget: 8000, currentUsage: 500 },
    };

    const result = await sessionSupervisorAgent.execute(input, context);
    assert(result.ok, "Supervisor execution failed");
    snapshot({ input, result, metrics: adapter.getMetrics() });

    const relevanceEval = await llmJudge({
      criteria: `The optimized context should:
        1. Include report-formatter result (directly relevant to email sending)
        2. Include data-collector result (provides content for email)
        3. Exclude or strongly deprioritize unrelated-agent result (database schema irrelevant)
        4. Present only high-signal details needed to compose the email (subject, key metrics, link to report) and avoid verbose restatements
        5. Demonstrate concision: no large irrelevant blocks or duplicated information
        Judge based on result.optimizedContext content only.`,
      agentOutput: result.data,
    });

    assert(relevanceEval.pass, `Relevance filtering failed: ${relevanceEval.justification}`);
  });

  await step(t, "Artifact Expansion (fidelity via batch-get)", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    // Create artifacts via v2 client to exercise real expansion
    const calendarData = {
      type: "calendar-schedule" as const,
      version: 1 as const,
      data: {
        events: [
          {
            id: "evt-001_20251010T170000Z",
            eventName: "Meeting with George Sivulka @ Hebbia",
            startDate: "2025-10-10T17:00:00Z",
            endDate: "2025-10-10T18:00:00Z",
            link: "https://www.google.com/calendar/event?eid=evt-001_20251010T170000Z",
          },
        ],
        source: "Google Calendar",
        sourceUrl: "primary",
      },
    };

    const calendarCreate = await parseResult(
      client.artifactsStorage.index.$post({
        json: {
          type: "calendar-schedule",
          data: calendarData,
          summary:
            "Today's calendar schedule containing 1 investor meeting with a company executive",
          workspaceId: context.session.workspaceId,
          chatId: context.session.streamId,
        },
      }),
    );
    if (!calendarCreate.ok) throw new Error("Failed to create calendar artifact");
    const calendarArtifact = calendarCreate.data.artifact;

    const summaryContent = "Acme Robotics: Raised $15M Series A. Hiring VP Engineering.";
    const summaryCreate = await parseResult(
      client.artifactsStorage.index.$post({
        json: {
          type: "summary",
          data: { type: "summary", version: 1, data: summaryContent },
          summary: "Summary of Acme Robotics funding and hiring",
          workspaceId: context.session.workspaceId,
          chatId: context.session.streamId,
        },
      }),
    );
    if (!summaryCreate.ok) throw new Error("Failed to create summary artifact");
    const summaryArtifact = summaryCreate.data.artifact;

    const input = {
      workflowIntent:
        "Prepare investor briefings by reading calendar events and research summaries",
      agentSystemPrompt:
        "You format investor briefings. Include provided artifacts verbatim when present.",
      agentInputSource: "combined" as const,
      signalPayload: { schedule: "0 8 * * *", timezone: "America/Los_Angeles" },
      previousResults: [
        {
          agentId: "calendar-reader",
          task: "Retrieve today's meetings from Google Calendar",
          output: "Retrieved 1 meeting for today with key attendee details.",
          artifactRefs: [
            {
              id: calendarArtifact.id,
              type: calendarArtifact.type,
              summary: calendarArtifact.summary,
            },
          ],
        },
        {
          agentId: "research-synthesizer",
          task: "Summarize latest company funding and hiring",
          output: "Compiled summary for Acme Robotics from recent filings and news.",
          artifactRefs: [
            {
              id: summaryArtifact.id,
              type: summaryArtifact.type,
              summary: summaryArtifact.summary,
            },
          ],
        },
      ],
      tokenBudget: { modelLimit: 200000, defaultBudget: 8000, currentUsage: 500 },
    };

    const result = await sessionSupervisorAgent.execute(input, context);
    assert(result.ok, `Supervisor execution failed: ${!result.ok ? result.error.reason : ""}`);

    const fidelityEval = await llmJudge({
      criteria: `Assess the optimized context for fidelity and high-signal content:
        1. It should explicitly mention a meeting with George Sivulka at Hebbia and its timing.
        2. It should include the research summary: "Acme Robotics: Raised $15M Series A. Hiring VP Engineering." (paraphrase acceptable if meaning is unchanged).
        3. It should avoid unnecessary boilerplate and focus on what a briefing formatter needs.
        Pass only if the optimized context clearly surfaces both the meeting details and the research summary with minimal noise.`,
      agentOutput: result.data,
    });

    assert(fidelityEval.pass, `Artifact fidelity failed: ${fidelityEval.justification}`);

    snapshot({ input, created: { calendarArtifact, summaryArtifact }, result, fidelityEval });
  });

  await step(t, "Artifact Reference Preservation", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const input = {
      workflowIntent:
        "Fetches recent climate research publications, processes them to extract key findings, and generates summary reports for policy teams",
      agentSystemPrompt: "You process documents by reading artifacts and extracting information.",
      agentInputSource: "combined" as const,
      signalPayload: { task: "Extract key findings from research documents" },
      previousResults: [
        {
          agentId: "document-fetcher",
          task: "Fetch the latest climate modeling research papers from academic databases",
          output: "Retrieved 5 research papers on climate modeling",
          artifactRefs: [
            { id: "doc-1", type: "document", summary: "Paper on ocean temperature trends" },
            { id: "doc-2", type: "document", summary: "Study on Arctic ice coverage decline" },
            { id: "doc-3", type: "document", summary: "Climate model validation methods" },
          ],
        },
      ],
      tokenBudget: { modelLimit: 200000, defaultBudget: 8000, currentUsage: 500 },
    };

    const result = await sessionSupervisorAgent.execute(input, context);
    assert(result.ok, "Supervisor execution failed");
    snapshot({ input, result });

    const artifactEval = await llmJudge({
      criteria: `The optimized context should:
        1. Mention all 3 document artifacts (doc-1, doc-2, doc-3) by ID and purpose
        2. Preserve each artifact's summary (paraphrasing acceptable if meaning is unchanged)
        3. Keep focus on what the document-processor needs to act (which docs to read and why), not raw content
        Evaluate result.optimizedContext fidelity and concision.`,
      agentOutput: result.data,
    });

    assert(
      artifactEval.pass,
      `Artifact reference preservation failed: ${artifactEval.justification}`,
    );
  });

  await step(t, "Customer Workflow: CI/CD Pipeline", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const input = {
      workflowIntent:
        "Automated CI/CD pipeline that analyzes code changes, runs tests, deploys to staging, and notifies the team via Slack about deployment status and quality metrics",
      agentSystemPrompt:
        "You send Slack notifications about deployment status. Format technical details into clear team updates and post to the engineering channel.",
      agentInputSource: "combined" as const,
      signalPayload: { pr_number: 456, branch: "feat/user-auth", author: "alice" },
      previousResults: [
        {
          agentId: "code-analyzer",
          task: "Analyze PR #456 changes to detect breaking changes, security issues, and code quality metrics",
          output:
            "Analyzed PR #456: 23 files changed (18 .ts, 5 .test.ts), no breaking changes detected, no security vulnerabilities. Code complexity: moderate. Added user authentication middleware.",
        },
        {
          agentId: "test-runner",
          task: "Execute full test suite including unit, integration, and e2e tests with coverage reporting",
          output:
            "All tests passed: 142/142 success (8 new tests added). Coverage: 87% (+2% from main). Test duration: 3m 42s. No flaky tests detected.",
        },
        {
          agentId: "build-deployer",
          task: "Build application bundle, run production checks, and deploy to staging environment",
          output:
            "Build successful (2m 15s). Bundle size: 2.3MB (within limits). Deployed to staging.example.com. Version: v2.3.1-rc.1. Health checks: passing.",
          artifactRefs: [
            {
              id: "deploy-001",
              type: "deployment-manifest",
              summary: "Kubernetes deployment manifest for v2.3.1-rc.1",
            },
          ],
        },
      ],
      tokenBudget: { modelLimit: 200000, defaultBudget: 8000, currentUsage: 530 },
    };

    const result = await sessionSupervisorAgent.execute(input, context);
    assert(result.ok, "Supervisor execution failed");
    snapshot({ input, result });

    const cicdEval = await llmJudge({
      criteria: `The optimized context should:
        1. Include all previous results (all stages are relevant to team notification)
        2. Prioritize build-deployer result (deployment status is primary concern)
        3. Include test results (quality metrics critical for team awareness)
        4. Include code-analyzer result (breaking changes and security matter)
        5. Reference deployment artifact (manifest may be needed)
        6. Format for Slack notification composition (clear, actionable summary) without extra noise
        Evaluate whether the content is high-signal and sufficient to compose a Slack update.`,
      agentOutput: result.data,
    });

    assert(cicdEval.pass, `CI/CD workflow context failed: ${cicdEval.justification}`);
  });

  await step(t, "Customer Workflow: Investor Briefing Pipeline", async ({ snapshot }) => {
    adapter.reset();
    const context = adapter.createContext({ telemetry: true });

    const input = {
      workflowIntent:
        "Generates comprehensive briefings for daily investor meetings by retrieving calendar info, researching attendees, and publishing to Slack",
      agentSystemPrompt:
        "You are a briefing publisher that formats research findings into comprehensive meeting briefings. Take research data and format it into structured briefings showing meeting participants, timing, and critical context. Post the completed briefings to #sara-bot-test for easy morning review.",
      agentInputSource: "combined" as const,
      signalPayload: { schedule: "0 9 * * *", timezone: "UTC" },
      previousResults: [
        {
          agentId: "calendar-reader",
          task: "Retrieve today's meetings from Google Calendar and extract attendee names, companies, meeting times, and titles",
          output:
            "Retrieved 3 meetings from Google Calendar: 10am with Sarah Chen (Acme Robotics), 2pm with Tech Ventures partners, 4pm with Mike Johnson (DataFlow Inc). All meetings have confirmed attendees.",
          artifactRefs: [
            {
              id: "cal-001",
              type: "calendar-events",
              summary: "Today's calendar with 3 investor meetings and attendee details",
            },
          ],
        },
        {
          agentId: "investor-intelligence-researcher",
          task: "Research each meeting attendee and their company to gather recent funding rounds, key metrics, leadership changes, and market developments",
          output:
            "Researched all attendees: Acme Robotics raised $15M Series A last month, hiring VP Engineering. Tech Ventures closed $200M fund, focusing on AI infrastructure. DataFlow Inc revenue grew 3x YoY, exploring acquisition targets. Found 2 leadership changes and 1 new funding round since last interaction.",
          artifactRefs: [
            {
              id: "research-001",
              type: "research-report",
              summary: "Detailed intelligence on Acme Robotics: funding, metrics, team changes",
            },
            {
              id: "research-002",
              type: "research-report",
              summary: "Tech Ventures fund analysis: portfolio, strategy, recent investments",
            },
            {
              id: "research-003",
              type: "research-report",
              summary: "DataFlow Inc company profile: growth metrics, acquisition strategy",
            },
          ],
        },
      ],
      tokenBudget: { modelLimit: 200000, defaultBudget: 8000, currentUsage: 3250 },
    };

    const result = await sessionSupervisorAgent.execute(input, context);
    assert(result.ok, "Supervisor execution failed");
    snapshot({ input, result, metrics: adapter.getMetrics() });

    const investorBriefingEval = await llmJudge({
      criteria: `The optimized context should:
        1. Include calendar-reader summary with meeting times and attendees
        2. Include investor-intelligence-researcher summary with key findings
        3. Reference all 4 artifacts (1 calendar + 3 research reports) with their IDs and summaries
        4. Keep signal context minimal (schedule trigger info only)
        5. Prioritize research findings over calendar details (research is what briefing needs)
        6. Avoid irrelevant fluff; present high-signal content only
        Judge based on whether a briefing publisher could act immediately.`,
      agentOutput: result.data,
    });

    assert(
      investorBriefingEval.pass,
      `Investor briefing context failed: ${investorBriefingEval.justification}`,
    );

    const artifactCountEval = await llmJudge({
      criteria: `The context must mention all 4 artifacts with IDs and clear intent:
        - cal-001 (calendar events)
        - research-001 (Acme Robotics)
        - research-002 (Tech Ventures)
        - research-003 (DataFlow Inc)
        It should be obvious which artifacts to read next and why.`,
      agentOutput: result.data,
    });

    assert(
      artifactCountEval.pass,
      `Artifact preservation failed: ${artifactCountEval.justification}`,
    );
  });
});
