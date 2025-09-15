import { slackCommunicatorAgent } from "@atlas/bundled-agents";
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

    const result = await slackCommunicatorAgent.execute(
      "Summarize last 10 messages in #engineering.",
      context,
    );

    const pass = await t.step("Basic validations", () => {
      assert(
        result.response.includes("tools unavailable") ||
          result.response.includes("Slack tools unavailable"),
      );
    });

    const evaluation = await llmJudge({
      criteria: `
        The agent should:
        1. Clearly state inability due to missing Slack tools (e.g., tools unavailable)
        2. Not fabricate channel content or actions
        3. Be concise and factual without narrative phrases
        4. Mention the limitation explicitly (tools unavailable / provide tools)
        5. Avoid excessive technical details
      `,
      agentOutput: result.response,
    });

    const qualityPass = await t.step("Non-fabrication confirmation", () => {
      assert(evaluation.pass, `LLM judge failed: ${evaluation.justification}`);
    });

    await saveSnapshot({
      testPath: new URL(import.meta.url),
      data: {
        result,
        response: result.response,
        toolCalls: result.toolCalls,
        toolResults: result.toolResults,
        evaluation,
        basicPass: pass,
        qualityPass,
      },
      pass: pass && qualityPass,
    });
  },
});
