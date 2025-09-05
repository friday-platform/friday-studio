import { conversationAgent } from "@atlas/system/agents";
import { assert } from "@std/assert";
import { ConversationAgentContext } from "../../lib/conversation-context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { saveSnapshot } from "../../lib/snapshot.ts";

Deno.test({
  name: "Conversation Agent: Terminology",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await loadCredentials();
    const context = new ConversationAgentContext();
    context.enableTelemetry();
    await context.initialize();

    try {
      const agentContext = context.createContext({ telemetry: true });

      // Test todo creation and management
      const result = await conversationAgent.execute(
        "I’m a product manager, and I’m conducting discovery for my new product. I want Atlas to take my transcribed meeting notes, analyze them for learnings and next steps, and then share out to the rest of the team.",
        agentContext,
      );
      const metrics = context.getMetrics();
      const trace = context.getTrace();

      const judge = await llmJudge({
        criteria: `
        - The word workspace should not be used.
        - The word agent should not be used.
        - The word tool should not be used.
        `,
        agentOutput: result,
      });

      await saveSnapshot({
        testPath: new URL(import.meta.url),
        data: { result, metrics, trace, judge },
        pass: judge.pass,
      });
    } finally {
      await context.cleanup();
    }
  },
});
