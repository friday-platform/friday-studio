import { bundledAgents, SlackAgentResultSchema } from "@atlas/bundled-agents";
import { assert } from "@std/assert";
import { AgentContextAdapter } from "../../lib/context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { createSlackMCPMockTools } from "../../lib/slack-mcp-mock-tools.ts";
import { saveSnapshot } from "../../lib/snapshot.ts";

Deno.test({
  name: "Slack Communicator: Message posting",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await loadCredentials();
    const { tools, counters } = createSlackMCPMockTools();
    const adapter = new AgentContextAdapter(tools);
    const context = adapter.createContext();

    // Resolve Slack agent from bundled agents
    const slackAgent = bundledAgents.find((a) => a.metadata.id === "slack");
    if (!slackAgent) {
      throw new Error("Slack agent not found in bundled agents");
    }

    // Test message posting to specific channel (deterministic eval message)
    const result = await slackAgent.execute(
      "Post to #engineering: [EVAL] Release announcement — v2.3.1 shipped; include concise confirmation.",
      context,
    );

    // Basic structural assertions
    const pass = await t.step("Basic validations", () => {
      const parsed = SlackAgentResultSchema.parse(result);
      assert(parsed.response.length > 5, "Result.response should have content");
    });

    // LLM judge for posting confirmation
    const parsed = SlackAgentResultSchema.parse(result);
    const evaluation = await llmJudge({
      criteria: `
        The agent should:
        1. Confirm that a message was posted to #engineering
        2. Reference the eval content: contains "[EVAL]" and mentions v2.3.1
        3. Be concise and factual without narrative phrases
        4. Provide confirmation details like timestamp or channel reference if available
        5. Not include excessive technical execution details
      `,
      agentOutput: parsed.response,
    });

    const qualityPass = await t.step("Posting confirmation quality", () => {
      assert(evaluation.pass, `LLM judge failed: ${evaluation.justification}`);
    });

    const toolUsagePass = await t.step("Slack tools invoked", () => {
      assert(
        counters.conversations_add_message + counters.channels_list + counters.users_list > 0,
        "No Slack tools were invoked during execution",
      );
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
        counters,
      },
      pass: pass && qualityPass && toolUsagePass,
    });
  },
});
