import { bundledAgents, SlackAgentResultSchema } from "@atlas/bundled-agents";
import { assert } from "@std/assert";
import { AgentContextAdapter } from "../../lib/context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { saveSnapshot } from "../../lib/snapshot.ts";

Deno.test({
  name: "Slack Communicator: Hallucination guard — no tools provided",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await loadCredentials();
    const adapter = new AgentContextAdapter({});
    const context = adapter.createContext();

    const slackAgent = bundledAgents.find((a) => a.metadata.id === "slack");
    if (!slackAgent) throw new Error("Slack agent not found in bundled agents");

    const result = await slackAgent.execute("Summarize last 10 messages in #engineering.", context);

    const pass = await t.step("Basic validations", () => {
      const parsed = SlackAgentResultSchema.parse(result);
      assert(
        parsed.response.includes("tools unavailable") ||
          parsed.response.includes("Slack tools unavailable"),
      );
    });

    const parsed = SlackAgentResultSchema.parse(result);
    const evaluation = await llmJudge({
      criteria: `
        The agent should:
        1. Clearly state inability due to missing Slack tools (e.g., tools unavailable)
        2. Not fabricate channel content or actions
        3. Be concise and factual without narrative phrases
        4. Mention the limitation explicitly (tools unavailable / provide tools)
        5. Avoid excessive technical details
      `,
      agentOutput: parsed.response,
    });

    const qualityPass = await t.step("Non-fabrication confirmation", () => {
      assert(evaluation.pass, `LLM judge failed: ${evaluation.justification}`);
    });

    await saveSnapshot({
      testPath: new URL(import.meta.url),
      data: {
        result,
        response: parsed.response,
        toolCalls: parsed.toolCalls,
        toolResults: parsed.toolResults,
        evaluation,
        basicPass: pass,
        qualityPass,
      },
      pass: pass && qualityPass,
    });
  },
});
