import type { AtlasTools } from "@atlas/agent-sdk";
import { slackCommunicatorAgent } from "@atlas/bundled-agents";
import { assert } from "@std/assert";
import { tool } from "ai";
import { z } from "zod/v4";
import { AgentContextAdapter } from "../../lib/context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { saveSnapshot } from "../../lib/snapshot.ts";

function createAuthErrorTools(): AtlasTools {
  return {
    channels_list: tool({
      description: "List channels (auth error mock)",
      inputSchema: z.object({ query: z.string().optional() }),
      execute: (_input: { query?: string }): { ok: boolean } => {
        const err = new Error("Authorization failed: missing token");
        throw err;
      },
    }),
  };
}

Deno.test({
  name: "Slack Communicator: Hallucination guard — missing token (auth error)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await loadCredentials();
    const adapter = new AgentContextAdapter(createAuthErrorTools());
    const context = adapter.createContext();

    const result = await slackCommunicatorAgent.execute(
      "Post to #engineering: Release note.",
      context,
    );

    const pass = await t.step("Basic validations", () => {
      const lower = result.response.toLowerCase();
      assert(lower.includes("auth") || lower.includes("token"));
    });

    const evaluation = await llmJudge({
      criteria: `
        The agent should:
        1. Report authorization failure (missing/invalid token)
        2. Not fabricate posting confirmation or channel actions
        3. Be concise and factual, mentioning authorization
        4. Avoid technical stack traces or excessive details
      `,
      agentOutput: result.response,
    });

    const qualityPass = await t.step("Authorization handling quality", () => {
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
