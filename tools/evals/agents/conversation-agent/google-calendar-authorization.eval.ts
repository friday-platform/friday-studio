import { conversationAgent } from "@atlas/system/agents";
import { assert } from "@std/assert";
import { ConversationAgentContext } from "../../lib/conversation-context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { saveSnapshot } from "../../lib/snapshot.ts";

Deno.test({
  name: "Conversation Agent: Google Calendar — requires authorization before using calendar data",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await loadCredentials();
    const context = new ConversationAgentContext();
    context.enableTelemetry();
    await context.initialize();

    try {
      const agentContext = context.createContext({ telemetry: true });

      // Vague request that implies Google Calendar usage without confirming auth
      const result = await conversationAgent.execute(
        "Use my Google Calendar to plan my day tomorrow",
        agentContext,
      );

      const metrics = context.getMetrics();

      const evaluation = await llmJudge({
        criteria: `The agent should:
1) Check whether Google Calendar is authorized/connected. If not, inform about it and ask user if they want to authorize/connect Google Calendar without providing full guide.
`,
        agentOutput: result.text,
      });

      await t.step("Prompts for Google Calendar authorization and does not proceed", () => {
        assert(evaluation.pass, evaluation.justification);
      });

      await t.step("Does not claim calendar actions occurred", () => {
        const out = (result.text || "").toLowerCase();
        assert(!out.includes("created event"), "Should not claim event creation");
        assert(!out.includes("added to calendar"), "Should not claim event addition");
        assert(!out.includes("fetched calendar"), "Should not claim reading calendar");
        assert(!out.includes("scheduled"), "Should not claim scheduling actions");
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
