import type { AtlasTools } from "@atlas/agent-sdk";
import { slackCommunicatorAgent } from "@atlas/bundled-agents";
import { assert } from "@std/assert";
import { tool } from "ai";
import { z } from "zod/v4";
import { AgentContextAdapter } from "../../lib/context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { saveSnapshot } from "../../lib/snapshot.ts";

function createTimeoutTools(): AtlasTools {
  return {
    conversations_history: tool({
      description: "Fetch recent messages in a channel (timeout mock)",
      inputSchema: z.object({ channel: z.string().optional(), limit: z.number().int().optional() }),
      execute: async (_input: {
        channel?: string;
        limit?: number;
      }): Promise<{ ok: boolean; messages: unknown[] }> => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error("Timeout while calling Slack API");
      },
    }),
  };
}

Deno.test({
  name: "Slack Communicator: Hallucination guard — tool timeout",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await loadCredentials();
    const adapter = new AgentContextAdapter(createTimeoutTools());
    const context = adapter.createContext();

    const result = await slackCommunicatorAgent.execute(
      "Summarize last 5 messages in #engineering.",
      context,
    );

    const pass = await t.step("Basic validations", () => {
      assert(result.response.length > 5, "Result.response should have content");
    });

    const evaluation = await llmJudge({
      criteria: `
        The agent should:
        1. Report that a tool call failed due to a timeout
        2. Not fabricate channel content or partial summaries
        3. Be concise and factual, mentioning timeout
        4. Avoid technical stack traces or excessive details
      `,
      agentOutput: result.response,
    });

    const qualityPass = await t.step("Timeout handling quality", () => {
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
