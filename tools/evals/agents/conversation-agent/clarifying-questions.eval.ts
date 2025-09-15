import { conversationAgent } from "@atlas/system/agents";
import { assert } from "@std/assert";
import { ConversationAgentContext } from "../../lib/conversation-context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { saveSnapshot } from "../../lib/snapshot.ts";

Deno.test({
  name: "Conversation Agent: Confirm that atlas ask clarifying questions when necessary",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await loadCredentials();
    const context = new ConversationAgentContext();
    context.enableTelemetry();
    await context.initialize();

    try {
      const agentContext = context.createContext({ telemetry: true });

      // Ask for a workspace but don't specify any details
      const result = await conversationAgent.execute(
        "I want to monitor weather in my city",
        agentContext,
      );
      const metrics = context.getMetrics();

      const evaluation = await llmJudge({
        criteria: "Atlas should ask questions like 'What city do you want to monitor weather for?'",
        agentOutput: result.text,
      });

      await t.step("", () => {
        // Direct assertions on the output
        assert(evaluation.pass, evaluation.justification);
      });

      await saveSnapshot({
        testPath: new URL(import.meta.url),
        data: { result, metrics },
        pass: evaluation.pass,
      });
    } finally {
      await context.cleanup();
    }
  },
});
