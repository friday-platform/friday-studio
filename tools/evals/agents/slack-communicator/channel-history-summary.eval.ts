import { bundledAgents } from "@atlas/bundled-agents";
import { assert } from "@std/assert";
import { AgentContextAdapter } from "../../lib/context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { saveSnapshot } from "../../lib/snapshot.ts";
import { createSlackMCPMockTools } from "../../lib/slack-mcp-mock-tools.ts";
import { SlackAgentResultSchema } from "@atlas/bundled-agents";

Deno.test({
  name: "Slack Communicator: Channel history summary",
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

    // Test channel history summarization (deterministic prompt for eval)
    const result = await slackAgent.execute(
      "Summarize the last 30 messages in #engineering. Output: sections for key topics, decisions, action items (with owners if present), blockers, and 3 recent messages (author — short timestamp — brief text).",
      context,
    );

    // Basic structural assertions
    const pass = await t.step("Basic validations", () => {
      const parsed = SlackAgentResultSchema.parse(result);
      assert(parsed.response.length > 10, "Result.response should have meaningful content");
    });

    // LLM judge for content quality
    const parsed = SlackAgentResultSchema.parse(result);
    const evaluation = await llmJudge({
      criteria: `
        The agent should:
        1. Provide a structured summary of channel history
        2. Be concise and direct without narrative phrases
        3. Include key topics, decisions, action items (with owners if present)
        4. Not include excessive technical details about the execution process
      `,
      agentOutput: parsed.response,
    });

    const qualityPass = await t.step("Content quality", () => {
      assert(evaluation.pass, `LLM judge failed: ${evaluation.justification}`);
    });

    const toolUsagePass = await t.step("Slack tools invoked", () => {
      assert(counters.conversations_history > 0, "Should fetch channel history");
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
