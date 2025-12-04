import { client, parseResult } from "@atlas/client/v2";
import type { WorkspacePlan } from "@atlas/core/artifacts";
import { logger } from "@atlas/logger";
import { assert } from "@std/assert";
import { evalite } from "evalite";
import { workspacePlannerAgent } from "../../../packages/system/agents/workspace-planner/workspace-planner.agent.ts";
import { AgentContextAdapter } from "../lib/context.ts";
import { LLMJudge } from "../lib/llm-judge.ts";
import { loadCredentials } from "../lib/load-credentials.ts";
import { setupFakeCredentials } from "../lib/setup-fake-credentials.ts";

// Set up credentials once
await loadCredentials();
setupFakeCredentials("all");

// Create adapter outside evalite for reuse
const adapter = new AgentContextAdapter();

// Test suite 1: Standard plan creation tests
evalite<{ intent: string }, WorkspacePlan, string>("Workspace Planner Agent - Create Plans", {
  data: [
    {
      input: {
        intent:
          "Monitor a directory /Users/test/notes for new meeting notes. When a note is added, extract key insights and action items, then post a summary to Slack #team-updates.",
      },
      expected: `The workspace plan should:
        1. Define a file-watching signal for the specified directory (/Users/test/notes)
        2. Include agents for: file reading, insight extraction, Slack notification
        3. Describe agents in prose (WHAT they do, not HOW they implement it)
        4. Capture user-specific details (channel name: #team-updates, directory path)
        5. Define a job connecting the signal to agents with clear execution flow
        6. Use clear, non-technical language that a non-technical user can understand
        The plan describes the automation's behavior, not implementation details.`,
    },
    {
      input: {
        intent:
          "Every Monday at 9am, research upcoming cultural events in Luxembourg and email a summary to team@company.com.",
      },
      expected: `The workspace plan should:
        1. Define a schedule-based signal for Monday mornings (9am or similar)
        2. Include agents for: research (cultural events), email composition/sending
        3. Capture the specific location (Luxembourg) and recipient (team@company.com)
        4. Describe a clear job flow connecting the schedule to the agents
        5. Use prose that explains timing rationale ("weekly update on Mondays" or similar)
        The plan should make it clear this is a recurring weekly task.`,
    },
    {
      input: {
        intent:
          "When a GitHub webhook indicates a new pull request on our repo, analyze the PR for code quality issues and post a review comment.",
      },
      expected: `The workspace plan should:
        1. Define a webhook/HTTP signal for GitHub pull request events
        2. Include agents for: PR data extraction, code analysis, comment posting
        3. Describe event-driven execution (responds to incoming webhook events)
        4. Define a job that triggers when the webhook receives PR events
        5. Use prose that explains reactive nature ("when PR is created" or "when webhook receives")
        The plan should clearly indicate this is triggered by external events, not scheduled.`,
    },
    {
      input: {
        intent:
          "Every morning at 8am PST, send me a briefing about my day's meetings. Check my Google Calendar for today's events, and for each company I'm meeting with, research the company (what they do, funding stage, key metrics) and founding team backgrounds. Compile everything into an email and send it to vc@example.com. Run this daily, including weekends.",
      },
      expected: `The workspace plan should:
        1. Define a daily schedule signal at 8am PST (or equivalent)
        2. Include distinct agents for: calendar fetching, company research, team research, email composition
        3. Capture configuration: email address (vc@example.com), timezone (PST), daily frequency including weekends
        4. Define sequential job flow (fetch calendar → research companies → research teams → compose email → send)
        5. Use clear prose explaining the multi-step workflow
        6. Agent descriptions should focus on WHAT they accomplish (e.g., "researches company background"), not HOW
        The plan should reflect a complex sequential workflow with multiple data sources feeding into a final email.`,
    },
    {
      input: {
        intent:
          "Monitor Nike.com and Adidas.com for new shoe releases. Check every 30 minutes during business hours (9am-6pm EST). When new products appear, send an alert to Discord channel #sneaker-drops with the product name, price, and direct link. Only alert on products that weren't there in the previous check.",
      },
      expected: `The workspace plan should:
        1. Define a schedule signal for every 30 minutes during business hours (9am-6pm EST or similar time window)
        2. Include agents for: website scraping (Nike and/or Adidas), product comparison/deduplication, Discord notification
        3. Capture configuration: Discord channel (#sneaker-drops), website URLs, time window constraints
        4. Describe conditional execution logic (only notify when new products detected, not on every check)
        5. Address deduplication requirement (comparing against previous checks)
        6. Use prose that explains the monitoring frequency and conditional alerting behavior
        The plan should clearly indicate high-frequency polling with smart conditional notifications.`,
    },
    {
      input: {
        intent:
          "When code is pushed to the main branch on my GitHub repo, run these checks in parallel: 1) Run the test suite and get coverage metrics, 2) Check for security vulnerabilities with a code scanner, 3) Verify all dependencies are up to date. Post results to Slack #ci-alerts and comment on the commit with a summary. Repository is github.com/myorg/myrepo.",
      },
      expected: `The workspace plan should:
        1. Define a webhook signal for GitHub push events to main branch
        2. Include separate agents for: test runner, security scanner, dependency checker, Slack notifier, GitHub commenter
        3. Capture configuration: repository URL (github.com/myorg/myrepo), Slack channel (#ci-alerts), branch filter (main)
        4. Define job orchestrating the 3 checks and notifications (parallel execution is ideal but sequential is acceptable)
        5. Describe the execution flow clearly in job descriptions
        The plan should demonstrate understanding of CI pipeline orchestration.`,
    },
    {
      input: {
        intent:
          "Every Monday at 9am, create a weekly digest of AI/ML news. Pull top posts from Hacker News (ML category), latest papers from arXiv cs.AI, and trending AI repositories on GitHub from the past week. Summarize the most interesting 5-10 items with a brief description of why they matter. Send the digest to my email: newsletter@example.com.",
      },
      expected: `The workspace plan should:
        1. Define a weekly schedule signal for Monday mornings at 9am
        2. Include separate agents for: Hacker News fetcher, arXiv fetcher, GitHub trends fetcher, content curator/summarizer, email sender
        3. Capture configuration: email address (newsletter@example.com), categories/filters (ML, AI), timeframe (past week), item limit (5-10)
        4. Describe job flow with data aggregation phase (fetching from 3 sources) followed by curation/summarization
        5. Explain the curation step (selecting most interesting items, explaining significance)
        6. Use prose that makes the weekly digest nature clear
        The plan should show understanding of aggregation → curation → delivery workflow.`,
    },
    {
      input: {
        intent:
          "Create an automated email reminder system that:\n1. Loads LinkedIn connections from CSV file (/Users/odk/Downloads/Connections.csv)\n2. Research each company to filter for New York-based companies with 50+ employees\n3. Daily at 8 AM on weekdays, randomly select 3 people from the filtered list\n4. For each selected person, research both the individual and company to generate:\n   - Person's name, company, and title\n   - 4-sentence company summary\n   - 5 bullet points about the person\n   - 3 ideas for potential intro outreach messages\n5. Send structured email to michal@tempest.team with all this information\n\nThe system should maintain a database of researched companies to avoid re-researching, and track which people have been selected to ensure variety over time.",
      },
      expected: `The workspace plan should:
          1. Define a weekday schedule signal at 8 AM (Monday-Friday)
          2. Show clear understanding of data persistence needs (tracking researched companies and previously selected people)
          3. Include agents for distinct phases: CSV loading, company research/filtering (NY + 50+ employees), person selection (random 3), detailed research, email composition
          4. Capture configuration: email address (michal@tempest.team), file path, company filters (NY location, 50+ employees), selection count (3 people), email content structure
          5. Demonstrate understanding of stateful operations (maintaining database to avoid re-research and ensure variety)
          6. Define sequential job flow with clear dependencies between phases
          The plan must show it grasps the complexity: initial filtering phase → persistence layer → daily selection → research → structured output.`,
    },
  ],
  task: async (input) => {
    const { context } = adapter.createContext();

    // Execute agent
    const result = await workspacePlannerAgent.execute(input, context);
    if (!result.ok) {
      logger.error("Agent execution failed", { error: result.error });
    }
    assert(result.ok, "Agent execution failed");
    assert(result.data.artifactId, "Missing artifact ID");
    assert(result.data.revision === 1, "Expected revision 1 for new plan");

    // Fetch artifact via daemon API
    const artifactResponse = await parseResult(
      client.artifactsStorage[":id"].$get({ param: { id: result.data.artifactId } }),
    );
    if (!artifactResponse.ok) {
      logger.error("Failed to fetch artifact", { error: artifactResponse.error });
    }
    assert(artifactResponse.ok, `Failed to fetch artifact`);
    assert(artifactResponse.data.artifact.data.type === "workspace-plan", "Wrong artifact type");

    return artifactResponse.data.artifact.data.data;
  },
  scorers: [LLMJudge],
});

// Test suite 2: Plan revision tests
evalite<{ intent: string; artifactId?: string; isRevision?: boolean }, WorkspacePlan, string>(
  "Workspace Planner Agent - Revisions",
  {
    data: [
      {
        input: { intent: "Also monitor Adidas.com for new releases.", isRevision: true },
        expected: `The revised workspace plan should:
        1. Retain the original Nike.com monitoring requirement
        2. Add Adidas.com monitoring as requested
        3. Maintain the Discord #sneakers notification requirement
        4. Update agents/signals appropriately to handle both sites (likely 2 monitoring agents)
        5. Keep the prose descriptions clear and user-friendly
        The plan should reflect that this workspace monitors BOTH Nike and Adidas sites.`,
      },
    ],
    task: async (input) => {
      const { context } = adapter.createContext();

      // For revision tests, create initial plan first
      let artifactId: string | undefined;
      if (input.isRevision) {
        const initialInput = {
          intent:
            "Monitor Nike.com for new shoe releases every 30 minutes and alert Discord #sneakers.",
        };
        const initialResult = await workspacePlannerAgent.execute(initialInput, context);
        assert(initialResult.ok, "Initial plan creation failed");
        assert(initialResult.data.artifactId, "Missing initial artifact ID");
        artifactId = initialResult.data.artifactId;
      }

      // Execute revision
      const revisionInput =
        input.isRevision && artifactId ? { intent: input.intent, artifactId: artifactId } : input;

      const result = await workspacePlannerAgent.execute(revisionInput, context);
      if (!result.ok) {
        logger.error("Agent execution failed", { error: result.error });
      }
      assert(result.ok, "Agent execution failed");
      assert(result.data.artifactId, "Missing artifact ID");

      if (input.isRevision) {
        assert(
          result.data.artifactId === artifactId,
          "Artifact ID should remain the same for revisions",
        );
        assert(result.data.revision === 2, "Expected revision 2 for revised plan");
      }

      // Fetch artifact via daemon API
      const artifactResponse = await parseResult(
        client.artifactsStorage[":id"].$get({ param: { id: result.data.artifactId } }),
      );
      if (!artifactResponse.ok) {
        logger.error("Failed to fetch artifact", { error: artifactResponse.error });
      }
      assert(artifactResponse.ok, `Failed to fetch artifact`);
      assert(artifactResponse.data.artifact.data.type === "workspace-plan", "Wrong artifact type");
      return artifactResponse.data.artifact.data.data;
    },
    scorers: [LLMJudge],
  },
);

// Test suite 3: Validation failure tests
// Note: This test validates error handling by expecting the agent to fail when
// referencing an unavailable integration (Zendesk)
evalite<{ intent: string }, string, string>("Workspace Planner Agent - Validation", {
  data: [
    {
      input: {
        intent:
          "When a new support ticket arrives in Zendesk, analyze the ticket content and automatically categorize it (billing, technical, feature request, other). For technical issues, check if there's a known solution in our documentation and suggest it. For billing issues, flag for urgent review. Update the ticket with the category tag and any suggested solutions. Send a summary to Slack #support-triage.",
      },
      expected: `The agent should fail with an error indicating:
        1. Zendesk integration is not found or not available
        2. The error message clearly mentions "Zendesk" and "integration not found" or similar
        This validates that the agent properly checks for required integrations before creating plans.`,
    },
  ],
  task: async (input) => {
    const { context } = adapter.createContext();

    const result = await workspacePlannerAgent.execute(input, context);

    // This test expects failure
    assert(!result.ok, "Should fail - Zendesk integration not available");
    assert(result.error, "Should return error");

    // Verify error message content
    const errorMessage = result.error.reason.toLowerCase();
    assert(errorMessage.includes("zendesk"), "Error should mention Zendesk");
    assert(
      errorMessage.includes("no integration found") ||
        errorMessage.includes("integration not found"),
      "Error should indicate integration not found",
    );

    // Return the error message for LLM evaluation
    return result.error.reason;
  },
  scorers: [LLMJudge],
});
