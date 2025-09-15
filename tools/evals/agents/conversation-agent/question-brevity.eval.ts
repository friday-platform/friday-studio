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
        "I’m a product manager, and I’m conducting discovery for my new product. I want to take my transcribed meeting notes from discovery with users testing my product, analyze them for critical product feedback, and then share out to the rest of the team.",
        agentContext,
      );
      const metrics = context.getMetrics();

      const evaluation = await llmJudge({
        criteria: `Atlas should ask questions like:
        - Where are your files located?
        - What kind of analysis are you looking for?
        - Where do you want to share the results?
        - Who should receive these insights?

        Additional rules, which are very important. Atlas should:
        - Ask at most 5 questions.
        - Not suggest add examples to the questions.
        - Keep the questions concise and to one sentence.
        - Not use words like "automation" or "workspace" or "signal" or "agent" in the questions.
        - Not add marketing speak like "this is the perfect use case..."
        `,
        agentOutput: result.text,
      });

      await t.step("", () => {
        // Direct assertions on the output
        assert(evaluation.pass, evaluation.justification);
      });

      await saveSnapshot({
        testPath: new URL(import.meta.url),
        data: { result, justification: evaluation.justification, metrics, trace },
        pass: evaluation.pass,
      });
    } finally {
      await context.cleanup();
    }
  },
});
