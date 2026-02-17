/**
 * Email vs Gmail Classification Pipeline Eval
 *
 * Tests the FULL production pipeline end-to-end:
 *   User intent → Workspace Planner (LLM) → classifyAgents() → generateMCPServers()
 *
 * This goes beyond Suite 5 in workspace-planner.eval.ts which only checks plan quality.
 * Here we verify the FINAL routing decisions: which agents get classified as bundled
 * vs LLM+MCP, and which MCP servers get generated.
 *
 * Background: Sentry ATLAS-29X — 734 recurring errors where the bundled email agent
 * (compose-only, SendGrid) is selected for Gmail retrieval tasks. The classification
 * pipeline has a substring matching bug: extractKeywordsFromNeed("google-gmail")
 * extracts "gmail" → matches bundled email agent → Gmail MCP never checked.
 */

import { client, parseResult } from "@atlas/client/v2";
import { WorkspacePlanSchema } from "@atlas/core/artifacts";
import { logger } from "@atlas/logger";
import { assert } from "@std/assert";
import { evalite } from "evalite";
import {
  type ClassifiedAgent,
  classifyAgents,
} from "../../../packages/system/agents/fsm-workspace-creator/agent-classifier.ts";
import type { MCPServerResult } from "../../../packages/system/agents/fsm-workspace-creator/enrichers/mcp-servers.ts";
import { generateMCPServers } from "../../../packages/system/agents/fsm-workspace-creator/enrichers/mcp-servers.ts";
import { workspacePlannerAgent } from "../../../packages/system/agents/workspace-planner/workspace-planner.agent.ts";
import { AgentContextAdapter } from "../lib/context.ts";
import { LLMJudge } from "../lib/llm-judge.ts";
import { loadCredentials } from "../lib/load-credentials.ts";
import { setupFakeCredentials } from "../lib/setup-fake-credentials.ts";

await loadCredentials();
setupFakeCredentials("all");

const adapter = new AgentContextAdapter();

/**
 * Structured result from the full classification pipeline.
 * Contains enough detail for LLMJudge to evaluate routing correctness.
 */
interface ClassificationPipelineResult {
  /** What the LLM planner generated */
  plan: { agents: { id: string; name: string; needs: string[] }[] };
  /** How classifyAgents() classified each agent */
  classification: {
    agentId: string;
    agentName: string;
    kind: "bundled" | "llm";
    bundledId?: string;
    mcpTools?: string[];
  }[];
  /** What MCP servers generateMCPServers() produced */
  mcpServers: { id: string }[];
}

/**
 * Runs the full production pipeline:
 * 1. Workspace planner LLM generates a plan with agent needs
 * 2. classifyAgents() runs deterministic matching (extractKeywordsFromNeed + matchBundledAgents)
 * 3. generateMCPServers() creates MCP configs for non-bundled agents
 */
async function runClassificationPipeline(intent: string): Promise<ClassificationPipelineResult> {
  const { context } = adapter.createContext();

  // Step 1: Run workspace planner LLM
  const result = await workspacePlannerAgent.execute({ intent }, context);
  if (!result.ok) {
    logger.error("Workspace planner failed", { error: result.error });
  }
  assert(result.ok, `Workspace planner failed: ${result.ok ? "" : result.error.reason}`);
  assert(result.data.artifactId, "Missing artifact ID");

  // Fetch the generated plan
  const artifactResponse = await parseResult(
    client.artifactsStorage[":id"].$get({ param: { id: result.data.artifactId } }),
  );
  assert(artifactResponse.ok, "Failed to fetch artifact");
  assert(artifactResponse.data.artifact.data.type === "workspace-plan", "Wrong artifact type");

  const plan = WorkspacePlanSchema.parse(artifactResponse.data.artifact.data.data);

  // Step 2: Run classifyAgents() — exact production code
  const classified: ClassifiedAgent[] = classifyAgents(plan);

  // Step 3: Run generateMCPServers() — exact production code
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

// ============================================================================
// Suite 1: Bundled email agent should handle compose/send scenarios
// These should be classified as bundled email (SendGrid) — no OAuth needed
// ============================================================================
evalite<{ intent: string }, ClassificationPipelineResult, string>(
  "Email vs Gmail Classification - Bundled Email (Send/Compose)",
  {
    data: [
      {
        input: { intent: "Email me a daily summary of completed tasks" },
        expected: `The classification pipeline result should show:
          1. The planner created an agent with needs like "email" or "notifications" (NOT "google-gmail")
          2. classifyAgents classified the email-sending agent as { kind: "bundled", bundledId: "email" }
          3. No "google-gmail" MCP server was generated — bundled email handles sending
          4. The agent is NOT classified as kind: "llm" with mcpTools containing gmail
          This is a compose/send task — bundled email (SendGrid) is the correct choice.`,
      },
      {
        input: { intent: "Send a notification to team@company.com when the build fails" },
        expected: `The classification pipeline result should show:
          1. The planner created an agent with needs like "email" or "notifications"
          2. classifyAgents classified the notification agent as { kind: "bundled", bundledId: "email" }
          3. No google-gmail MCP server was generated
          4. Bundled email correctly handles outbound notifications
          This is a notification/send task — no inbox access needed.`,
      },
      {
        input: {
          intent:
            "Every Monday at 9am, research cultural events in Luxembourg and email a summary to team@company.com",
        },
        expected: `The classification pipeline result should show:
          1. The planner created agents including one for email sending
          2. The email-sending agent is classified as { kind: "bundled", bundledId: "email" }
          3. No google-gmail MCP server was generated for the email agent
          4. Other agents (research) may be classified as "llm" — that's fine
          The email step is compose/send only — bundled email is correct.`,
      },
    ],
    task: (input) => runClassificationPipeline(input.intent),
    scorers: [LLMJudge],
  },
);

// ============================================================================
// Suite 2: Google Gmail MCP should handle inbox access scenarios
// These MUST be classified as LLM + google-gmail MCP — OAuth required
// ============================================================================
evalite<{ intent: string }, ClassificationPipelineResult, string>(
  "Email vs Gmail Classification - Gmail MCP (Read/Search Inbox)",
  {
    data: [
      {
        input: { intent: "Search my Gmail inbox for invoices from last month" },
        expected: `The classification pipeline result should show:
          1. The planner created an agent with needs like "google-gmail" or "gmail" for inbox search
          2. classifyAgents classified the inbox-searching agent as { kind: "llm" } (NOT bundled email)
          3. A "google-gmail" MCP server WAS generated in mcpServers
          4. The agent is NOT classified as { kind: "bundled", bundledId: "email" }
          CRITICAL: This requires reading the user's inbox — bundled email (SendGrid compose-only) cannot do this.
          The correct classification is kind: "llm" with google-gmail MCP server.`,
      },
      {
        input: { intent: "Read my unread emails and summarize them" },
        expected: `The classification pipeline result should show:
          1. The planner created an agent for reading emails
          2. classifyAgents classified it as { kind: "llm" } (NOT bundled email)
          3. A "google-gmail" MCP server WAS generated
          4. NOT classified as bundled email — that agent can only compose, not read inbox
          Reading unread emails requires Gmail MCP with OAuth, not SendGrid.`,
      },
      {
        input: { intent: "Draft a reply to the latest email from my boss" },
        expected: `The classification pipeline result should show:
          1. The planner created an agent that needs Gmail access (read inbox + create draft)
          2. classifyAgents classified it as { kind: "llm" } (NOT bundled email)
          3. A "google-gmail" MCP server WAS generated
          4. NOT classified as bundled email
          Creating a draft reply requires reading inbox and using Gmail API — OAuth needed.`,
      },
      {
        input: {
          intent:
            "When I get an email from clients@important.com, auto-archive it and notify me on Slack",
        },
        expected: `The classification pipeline result should show:
          1. The planner created agents for: Gmail inbox monitoring/archiving AND Slack notification
          2. The Gmail agent is classified as { kind: "llm" } (NOT bundled email)
          3. A "google-gmail" MCP server WAS generated
          4. The Slack agent may be classified as bundled — that's correct
          5. The Gmail agent is NOT classified as bundled email
          Inbox monitoring and archiving requires Gmail MCP with OAuth.`,
      },
      {
        input: {
          intent:
            "Every 15 minutes, check my Gmail for new messages and send me a Slack notification if any are from the sales team",
        },
        expected: `The classification pipeline result should show:
          1. The planner created agents for: Gmail inbox checking AND Slack notification
          2. The Gmail-checking agent is classified as { kind: "llm" } (NOT bundled email)
          3. A "google-gmail" MCP server WAS generated
          4. The agent is NOT classified as { kind: "bundled", bundledId: "email" }
          CRITICAL: This is the exact scenario from Sentry ATLAS-29X — polling Gmail inbox.
          Bundled email cannot read inbox. Must route to google-gmail MCP.`,
      },
    ],
    task: (input) => runClassificationPipeline(input.intent),
    scorers: [LLMJudge],
  },
);

// ============================================================================
// Suite 3: Mixed workflows — both bundled email AND Gmail MCP in same plan
// ============================================================================
evalite<{ intent: string }, ClassificationPipelineResult, string>(
  "Email vs Gmail Classification - Mixed Workflows",
  {
    data: [
      {
        input: {
          intent:
            "Check my Gmail for meeting invites, then email a summary to assistant@company.com",
        },
        expected: `The classification pipeline result should show:
          1. The planner created separate agents: one for Gmail reading, one for email sending
          2. The Gmail-reading agent is classified as { kind: "llm" } with google-gmail MCP
          3. The email-sending agent is classified as { kind: "bundled", bundledId: "email" }
          4. A "google-gmail" MCP server WAS generated (for the reading agent)
          5. Two different classification types for the two different capabilities
          CRITICAL: Reading inbox = Gmail MCP (OAuth). Sending notification = bundled email (SendGrid).
          These are different capabilities and MUST use different agents.`,
      },
      {
        input: {
          intent:
            "Every day at 5pm, check my Gmail for emails from clients, analyze urgency, and email me a summary at me@company.com",
        },
        expected: `The classification pipeline result should show:
          1. The planner created agents for: Gmail reading, analysis, and email sending
          2. The Gmail-reading agent is classified as { kind: "llm" } with google-gmail MCP
          3. The email-sending agent is classified as { kind: "bundled", bundledId: "email" }
          4. A "google-gmail" MCP server WAS generated
          5. Gmail reading and email sending use DIFFERENT agent types
          Reading client emails = Gmail MCP. Sending summary = bundled email.`,
      },
      {
        input: {
          intent:
            "Every Monday, create a weekly digest: pull my Google Calendar events for the week, unread emails from Gmail, then email the digest to summary@example.com",
        },
        expected: `The classification pipeline result should show:
          1. The planner created agents for: Google Calendar, Gmail reading, and email sending
          2. The Google Calendar agent is classified as { kind: "bundled", bundledId: "google-calendar" }
          3. The Gmail-reading agent is classified as { kind: "llm" } with google-gmail MCP
          4. The email-sending agent is classified as { kind: "bundled", bundledId: "email" }
          5. A "google-gmail" MCP server WAS generated
          6. Calendar = bundled. Gmail inbox = MCP. Send email = bundled. Three different routing decisions.`,
      },
    ],
    task: (input) => runClassificationPipeline(input.intent),
    scorers: [LLMJudge],
  },
);

// ============================================================================
// Suite 4: Edge cases — "gmail me" (genericized), ambiguous phrasing
// ============================================================================
evalite<{ intent: string }, ClassificationPipelineResult, string>(
  "Email vs Gmail Classification - Edge Cases",
  {
    data: [
      {
        input: { intent: "Gmail me the research results when done" },
        expected: `The classification pipeline result should show:
          1. "Gmail me" is genericized usage meaning "email me" — this is SENDING, not reading inbox
          2. The agent should be classified as { kind: "bundled", bundledId: "email" }
          3. No google-gmail MCP server needed — this is just sending a message
          4. NOT classified as kind: "llm" with gmail MCP
          "Gmail me" = "email me" = compose/send = bundled email.`,
      },
      {
        input: {
          intent: "Retrieve all my emails from Gmail and create a report of who contacts me most",
        },
        expected: `The classification pipeline result should show:
          1. "Retrieve all emails from Gmail" requires inbox access — OAuth needed
          2. The agent is classified as { kind: "llm" } (NOT bundled email)
          3. A "google-gmail" MCP server WAS generated
          4. NOT classified as bundled email — SendGrid cannot retrieve inbox
          This explicitly mentions retrieving from Gmail — must use Gmail MCP.`,
      },
      {
        input: {
          intent:
            "Monitor my email inbox for messages with attachments and save them to Google Drive",
        },
        expected: `The classification pipeline result should show:
          1. "Monitor email inbox" requires reading inbox — Gmail MCP needed
          2. The inbox-monitoring agent is classified as { kind: "llm" } (NOT bundled email)
          3. A "google-gmail" MCP server WAS generated
          4. A "google-drive" MCP server may also be generated (for saving to Drive)
          Monitoring inbox = reading = Gmail MCP. Bundled email cannot monitor inboxes.`,
      },
      {
        input: { intent: "Forward my last email to bob@company.com" },
        expected: `The classification pipeline result should show:
          1. "Forward my last email" requires reading inbox first — Gmail MCP needed
          2. The agent is classified as { kind: "llm" } (NOT bundled email)
          3. A "google-gmail" MCP server WAS generated
          4. Even though the end result is "sending" an email, the prerequisite of reading
             the last email means Gmail MCP is required
          Forward = read + send = Gmail MCP for the full operation.`,
      },
    ],
    task: (input) => runClassificationPipeline(input.intent),
    scorers: [LLMJudge],
  },
);
