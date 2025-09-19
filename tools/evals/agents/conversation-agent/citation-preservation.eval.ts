import { conversationAgent } from "@atlas/system/agents";
import { assert } from "@std/assert";
import { ConversationAgentContext } from "../../lib/conversation-context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { saveSnapshot } from "../../lib/snapshot.ts";

Deno.test({
  name: "Conversation Agent: Research response retains source citations",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await loadCredentials();
    const context = new ConversationAgentContext();
    context.enableTelemetry();
    await context.initialize();

    try {
      const agentContext = context.createContext({ telemetry: true });

      // Ask for a research-style answer where citations are critical
      const result = await conversationAgent.execute(
        "Research the benefits of interval training vs steady-state cardio and provide a brief comparison.",
        agentContext,
      );

      const metrics = context.getMetrics();

      const evaluation = await llmJudge({
        criteria: `The agent should:
1) Provide a short comparison with explicit inline citations (e.g., [1], [2]) next to claims.
2) Avoid removing or truncating citations.
3) If links are available, include them or otherwise provide a references section mapping [n] to sources.`,
        agentOutput: result.text,
      });

      await t.step("Research output keeps citations and references", () => {
        assert(evaluation.pass, evaluation.justification);
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
