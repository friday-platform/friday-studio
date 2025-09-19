import { conversationAgent } from "@atlas/system/agents";
import { assert } from "@std/assert";
import { ConversationAgentContext } from "../../lib/conversation-context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { saveSnapshot } from "../../lib/snapshot.ts";

Deno.test({
  name: "Conversation Agent: Slack info — requires auth and clarifying details before execution",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await loadCredentials();
    const context = new ConversationAgentContext();
    context.enableTelemetry();
    await context.initialize();

    try {
      const agentContext = context.createContext({ telemetry: true });

      // Intentionally vague request without Slack auth context or message details
      const result = await conversationAgent.execute(
        "Send a Slack message to my team",
        agentContext,
      );

      const metrics = context.getMetrics();

      // Judge that the agent asks for Slack authorization and necessary details (channel/user and message)
      const evaluation = await llmJudge({
        criteria: `The agent should:
1) Check Slack authorization and, if not configured, explicitly ask the user to connect/authorize Slack and stop before executing.
2) Ask concise clarifying questions to gather: target (channel or user), exact message text, and any timing/scheduling if relevant.
3) Not claim that it has sent or posted any message yet, and not start executing a Slack agent without details and authorization.`,
        agentOutput: result.text,
      });

      await t.step("Meets authorization and clarification requirements", () => {
        assert(evaluation.pass, evaluation.justification);
      });

      // Guidance: avoid suggesting incoming webhooks, prefer Slack app OAuth + chat.postMessage
      await t.step("Does not propose using Slack webhooks", () => {
        const out = (result.text || "").toLowerCase();
        const suggestsIncomingWebhook = out.includes("webhook");
        assert(
          !suggestsIncomingWebhook,
          "Should not propose configuring or using Slack Incoming Webhooks",
        );
        // It's okay if the agent mentions not to use webhooks; reject only if proposing them.
      });

      await saveSnapshot({
        testPath: new URL(import.meta.url),
        data: { result, metrics, evaluation },
        pass: evaluation.pass,
      });
    } finally {
      await context.cleanup();
    }
  },
});

Deno.test({
  name: "Conversation Agent: Slack guide — explains setup/capabilities and avoids webhooks",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await loadCredentials();
    const context = new ConversationAgentContext();
    context.enableTelemetry();
    await context.initialize();

    try {
      const agentContext = context.createContext({ telemetry: true });

      // Ask for a guidance/overview rather than execution
      const result = await conversationAgent.execute(
        "I would like to use slack? What I need to setup and how to do that?",
        agentContext,
      );

      const metrics = context.getMetrics();

      const evaluation = await llmJudge({
        criteria: `The agent should:
1) Provide a brief, concrete guide for connecting Slack agent by setting up Slack token.
2) Provide guide how to get the token from slack website.
3) Avoid proposing Slack Incoming Webhooks; prefer Slack agent integration.`,
        agentOutput: result.text,
      });

      await t.step("Provides a Slack guide without proposing webhooks", () => {
        assert(evaluation.pass, evaluation.justification);
      });

      await t.step("Does not propose using Slack webhooks", () => {
        const out = (result.text || "").toLowerCase();
        const suggestsIncomingWebhook = out.includes("webhook");
        assert(
          !suggestsIncomingWebhook,
          "Should not propose configuring or using Slack Incoming Webhooks",
        );
      });

      await saveSnapshot({
        testPath: new URL(import.meta.url),
        data: { result, metrics, evaluation },
        pass: evaluation.pass,
      });
    } finally {
      await context.cleanup();
    }
  },
});
