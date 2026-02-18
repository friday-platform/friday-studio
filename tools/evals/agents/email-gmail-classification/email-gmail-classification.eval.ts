/**
 * Email vs Gmail Classification Pipeline Eval.
 *
 * Tests the FULL production pipeline end-to-end:
 *   User intent -> Workspace Planner (LLM) -> classifyAgents() -> generateMCPServers()
 *
 * Verifies the FINAL routing decisions: which agents get classified as bundled
 * vs LLM+MCP, and which MCP servers get generated.
 *
 * Background: Sentry ATLAS-29X -- 734 recurring errors where the bundled email agent
 * (compose-only, SendGrid) is selected for Gmail retrieval tasks.
 */

import { client, parseResult } from "@atlas/client/v2";
import { WorkspacePlanSchema } from "@atlas/core/artifacts";
import { workspacePlannerAgent } from "@atlas/system/agents";
import {
  type ClassifiedAgent,
  classifyAgents,
} from "@atlas/system/agents/fsm-workspace-creator/agent-classifier";
import {
  generateMCPServers,
  type MCPServerResult,
} from "@atlas/system/agents/fsm-workspace-creator/enrichers/mcp-servers";
import { assert } from "@std/assert";
import { AgentContextAdapter } from "../../lib/context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { setupFakeCredentials } from "../../lib/setup-fake-credentials.ts";

await loadCredentials();
setupFakeCredentials("all");

const adapter = new AgentContextAdapter();

/** Structured result from the full classification pipeline. */
interface ClassificationPipelineResult {
  plan: { agents: { id: string; name: string; needs: string[] }[] };
  classification: {
    agentId: string;
    agentName: string;
    kind: "bundled" | "llm";
    bundledId?: string;
    mcpTools?: string[];
  }[];
  mcpServers: { id: string }[];
}

/**
 * Runs the full production pipeline:
 * 1. Workspace planner LLM generates a plan with agent needs
 * 2. classifyAgents() runs deterministic matching
 * 3. generateMCPServers() creates MCP configs for non-bundled agents
 */
async function runClassificationPipeline(
  intent: string,
  pipelineAdapter: AgentContextAdapter,
): Promise<ClassificationPipelineResult> {
  const { context } = pipelineAdapter.createContext();

  const result = await workspacePlannerAgent.execute({ intent }, context);
  assert(result.ok, `Workspace planner failed: ${result.ok ? "" : result.error.reason}`);
  assert(result.data.artifactId, "Missing artifact ID");

  const artifactResponse = await parseResult(
    client.artifactsStorage[":id"].$get({ param: { id: result.data.artifactId } }),
  );
  assert(artifactResponse.ok, "Failed to fetch artifact");
  assert(artifactResponse.data.artifact.data.type === "workspace-plan", "Wrong artifact type");

  const plan = WorkspacePlanSchema.parse(artifactResponse.data.artifact.data.data);

  const classified: ClassifiedAgent[] = classifyAgents(plan);
  const mcpServers: MCPServerResult[] = await generateMCPServers(plan.agents, plan.credentials);

  return {
    plan: { agents: plan.agents.map((a) => ({ id: a.id, name: a.name, needs: a.needs })) },
    classification: classified.map((c) => ({
      agentId: c.id,
      agentName: c.name,
      kind: c.type.kind,
      bundledId: c.type.kind === "bundled" ? c.type.bundledId : undefined,
      mcpTools: c.type.kind === "llm" ? c.type.mcpTools : undefined,
    })),
    mcpServers: mcpServers.map((s) => ({ id: s.id })),
  };
}

/** Test case definition for a classification eval. */
interface ClassificationCase extends BaseEvalCase {
  criteria: string;
}

/** Converts a suite of classification cases into EvalRegistrations. */
function buildSuiteEvals(suiteName: string, cases: ClassificationCase[]): EvalRegistration[] {
  return cases.map((testCase) =>
    defineEval({
      name: `email-gmail-classification/${suiteName}/${testCase.id}`,
      adapter,
      config: {
        input: testCase.input,
        run: (input, _context) => runClassificationPipeline(input, adapter),
        score: async (result) => [await llmJudge(result, testCase.criteria)],
        metadata: { suite: suiteName },
      },
    }),
  );
}

// Suite 1: Bundled email agent should handle compose/send scenarios
const bundledEmailEvals = buildSuiteEvals("bundled-email", [
  {
    id: "daily-summary-email",
    name: "bundled - daily summary email",
    input: "Email me a daily summary of completed tasks",
    criteria: `The classification pipeline result should show:
          1. The planner created an agent with needs like "email" or "notifications" (NOT "google-gmail")
          2. classifyAgents classified the email-sending agent as { kind: "bundled", bundledId: "email" }
          3. No "google-gmail" MCP server was generated -- bundled email handles sending
          4. The agent is NOT classified as kind: "llm" with mcpTools containing gmail
          This is a compose/send task -- bundled email (SendGrid) is the correct choice.`,
  },
  {
    id: "build-failure-notification",
    name: "bundled - build failure notification",
    input: "Send a notification to team@company.com when the build fails",
    criteria: `The classification pipeline result should show:
          1. The planner created an agent with needs like "email" or "notifications"
          2. classifyAgents classified the notification agent as { kind: "bundled", bundledId: "email" }
          3. No google-gmail MCP server was generated
          4. Bundled email correctly handles outbound notifications
          This is a notification/send task -- no inbox access needed.`,
  },
  {
    id: "weekly-research-and-email",
    name: "bundled - weekly research and email",
    input:
      "Every Monday at 9am, research cultural events in Luxembourg and email a summary to team@company.com",
    criteria: `The classification pipeline result should show:
          1. The planner created agents including one for email sending
          2. The email-sending agent is classified as { kind: "bundled", bundledId: "email" }
          3. No google-gmail MCP server was generated for the email agent
          4. Other agents (research) may be classified as "llm" -- that's fine
          The email step is compose/send only -- bundled email is correct.`,
  },
]);

// Suite 2: Google Gmail MCP should handle inbox access scenarios
const gmailMcpEvals = buildSuiteEvals("gmail-mcp", [
  {
    id: "search-inbox-for-invoices",
    name: "gmail - search inbox for invoices",
    input: "Search my Gmail inbox for invoices from last month",
    criteria: `The classification pipeline result should show:
          1. The planner created an agent with needs like "google-gmail" or "gmail" for inbox search
          2. classifyAgents classified the inbox-searching agent as { kind: "llm" } (NOT bundled email)
          3. A "google-gmail" MCP server WAS generated in mcpServers
          4. The agent is NOT classified as { kind: "bundled", bundledId: "email" }
          CRITICAL: This requires reading the user's inbox -- bundled email (SendGrid compose-only) cannot do this.`,
  },
  {
    id: "read-unread-emails",
    name: "gmail - read unread emails",
    input: "Read my unread emails and summarize them",
    criteria: `The classification pipeline result should show:
          1. The planner created an agent for reading emails
          2. classifyAgents classified it as { kind: "llm" } (NOT bundled email)
          3. A "google-gmail" MCP server WAS generated
          4. NOT classified as bundled email -- that agent can only compose, not read inbox
          Reading unread emails requires Gmail MCP with OAuth, not SendGrid.`,
  },
  {
    id: "draft-reply-to-boss",
    name: "gmail - draft reply to boss",
    input: "Draft a reply to the latest email from my boss",
    criteria: `The classification pipeline result should show:
          1. The planner created an agent that needs Gmail access (read inbox + create draft)
          2. classifyAgents classified it as { kind: "llm" } (NOT bundled email)
          3. A "google-gmail" MCP server WAS generated
          4. NOT classified as bundled email
          Creating a draft reply requires reading inbox and using Gmail API -- OAuth needed.`,
  },
  {
    id: "inbox-monitoring-and-slack",
    name: "gmail - inbox monitoring and slack",
    input: "When I get an email from clients@important.com, auto-archive it and notify me on Slack",
    criteria: `The classification pipeline result should show:
          1. The planner created agents for: Gmail inbox monitoring/archiving AND Slack notification
          2. The Gmail agent is classified as { kind: "llm" } (NOT bundled email)
          3. A "google-gmail" MCP server WAS generated
          4. The Slack agent may be classified as bundled -- that's correct
          5. The Gmail agent is NOT classified as bundled email
          Inbox monitoring and archiving requires Gmail MCP with OAuth.`,
  },
  {
    id: "periodic-inbox-check-atlas-29x",
    name: "gmail - periodic inbox check (ATLAS-29X)",
    input:
      "Every 15 minutes, check my Gmail for new messages and send me a Slack notification if any are from the sales team",
    criteria: `The classification pipeline result should show:
          1. The planner created agents for: Gmail inbox checking AND Slack notification
          2. The Gmail-checking agent is classified as { kind: "llm" } (NOT bundled email)
          3. A "google-gmail" MCP server WAS generated
          4. The agent is NOT classified as { kind: "bundled", bundledId: "email" }
          CRITICAL: This is the exact scenario from Sentry ATLAS-29X -- polling Gmail inbox.
          Bundled email cannot read inbox. Must route to google-gmail MCP.`,
  },
]);

// Suite 3: Mixed workflows -- both bundled email AND Gmail MCP in same plan
const mixedEvals = buildSuiteEvals("mixed", [
  {
    id: "read-gmail-send-summary",
    name: "mixed - read Gmail send summary",
    input: "Check my Gmail for meeting invites, then email a summary to assistant@company.com",
    criteria: `The classification pipeline result should show:
          1. The planner created separate agents: one for Gmail reading, one for email sending
          2. The Gmail-reading agent is classified as { kind: "llm" } with google-gmail MCP
          3. The email-sending agent is classified as { kind: "bundled", bundledId: "email" }
          4. A "google-gmail" MCP server WAS generated (for the reading agent)
          5. Two different classification types for the two different capabilities
          CRITICAL: Reading inbox = Gmail MCP (OAuth). Sending notification = bundled email (SendGrid).`,
  },
  {
    id: "daily-client-email-digest",
    name: "mixed - daily client email digest",
    input:
      "Every day at 5pm, check my Gmail for emails from clients, analyze urgency, and email me a summary at me@company.com",
    criteria: `The classification pipeline result should show:
          1. The planner created agents for: Gmail reading, analysis, and email sending
          2. The Gmail-reading agent is classified as { kind: "llm" } with google-gmail MCP
          3. The email-sending agent is classified as { kind: "bundled", bundledId: "email" }
          4. A "google-gmail" MCP server WAS generated
          5. Gmail reading and email sending use DIFFERENT agent types
          Reading client emails = Gmail MCP. Sending summary = bundled email.`,
  },
  {
    id: "weekly-digest-calendar-gmail-send",
    name: "mixed - weekly digest calendar Gmail send",
    input:
      "Every Monday, create a weekly digest: pull my Google Calendar events for the week, unread emails from Gmail, then email the digest to summary@example.com",
    criteria: `The classification pipeline result should show:
          1. The planner created agents for: Google Calendar, Gmail reading, and email sending
          2. The Google Calendar agent is classified as { kind: "bundled", bundledId: "google-calendar" }
          3. The Gmail-reading agent is classified as { kind: "llm" } with google-gmail MCP
          4. The email-sending agent is classified as { kind: "bundled", bundledId: "email" }
          5. A "google-gmail" MCP server WAS generated
          6. Calendar = bundled. Gmail inbox = MCP. Send email = bundled. Three different routing decisions.`,
  },
]);

// Suite 4: Edge cases -- "gmail me" (genericized), ambiguous phrasing
const edgeCaseEvals = buildSuiteEvals("edge-cases", [
  {
    id: "gmail-me-genericized",
    name: "edge - gmail me genericized",
    input: "Gmail me the research results when done",
    criteria: `The classification pipeline result should show:
          1. "Gmail me" is genericized usage meaning "email me" -- this is SENDING, not reading inbox
          2. The agent should be classified as { kind: "bundled", bundledId: "email" }
          3. No google-gmail MCP server needed -- this is just sending a message
          4. NOT classified as kind: "llm" with gmail MCP
          "Gmail me" = "email me" = compose/send = bundled email.`,
  },
  {
    id: "retrieve-emails-for-report",
    name: "edge - retrieve emails for report",
    input: "Retrieve all my emails from Gmail and create a report of who contacts me most",
    criteria: `The classification pipeline result should show:
          1. "Retrieve all emails from Gmail" requires inbox access -- OAuth needed
          2. The agent is classified as { kind: "llm" } (NOT bundled email)
          3. A "google-gmail" MCP server WAS generated
          4. NOT classified as bundled email -- SendGrid cannot retrieve inbox
          This explicitly mentions retrieving from Gmail -- must use Gmail MCP.`,
  },
  {
    id: "monitor-inbox-save-to-drive",
    name: "edge - monitor inbox save to Drive",
    input: "Monitor my email inbox for messages with attachments and save them to Google Drive",
    criteria: `The classification pipeline result should show:
          1. "Monitor email inbox" requires reading inbox -- Gmail MCP needed
          2. The inbox-monitoring agent is classified as { kind: "llm" } (NOT bundled email)
          3. A "google-gmail" MCP server WAS generated
          4. A "google-drive" MCP server may also be generated (for saving to Drive)
          Monitoring inbox = reading = Gmail MCP. Bundled email cannot monitor inboxes.`,
  },
  {
    id: "forward-last-email",
    name: "edge - forward last email",
    input: "Forward my last email to bob@company.com",
    criteria: `The classification pipeline result should show:
          1. "Forward my last email" requires reading inbox first -- Gmail MCP needed
          2. The agent is classified as { kind: "llm" } (NOT bundled email)
          3. A "google-gmail" MCP server WAS generated
          4. Even though the end result is "sending" an email, the prerequisite of reading
             the last email means Gmail MCP is required
          Forward = read + send = Gmail MCP for the full operation.`,
  },
]);

export const evals: EvalRegistration[] = [
  ...bundledEmailEvals,
  ...gmailMcpEvals,
  ...mixedEvals,
  ...edgeCaseEvals,
];
