import { bundledAgents, GoogleCalendarAgentResultSchema } from "@atlas/bundled-agents";
import { assert } from "@std/assert";
import { AgentContextAdapter } from "../../lib/context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { createSlackMCPMockTools } from "../../lib/slack-mcp-mock-tools.ts";
import { saveSnapshot } from "../../lib/snapshot.ts";

Deno.test({
  name: "Extracting Portfolio company meetings",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await loadCredentials();
    const { tools, counters } = createSlackMCPMockTools();
    const adapter = new AgentContextAdapter(tools);
    const context = adapter.createContext();

    // Resolve Slack agent from bundled agents
    const googleCalendarAgent = bundledAgents.find((a) => a.metadata.id === "google-calendar");
    if (!googleCalendarAgent) {
      throw new Error("Google Calendar agent not found in bundled agents");
    }

    // Test channel history summarization (deterministic prompt for eval)
    const result = await googleCalendarAgent.execute(
      `Extract today's meetings from Google Calendar and identify portfolio company events by analyzing event titles and attendees.
      Focus on parsing meeting details to categorize business-related events. Return structured data with meeting times, titles,
      attendees, and portfolio company flags for downstream processing.`,
      context,
    );

    // Basic structural assertions
    const pass = await t.step("Basic validations", () => {
      const parsed = GoogleCalendarAgentResultSchema.parse(result);
      assert(parsed.response.length > 10, "Result.response should have meaningful content");
    });

    // LLM judge for content quality
    const parsed = GoogleCalendarAgentResultSchema.parse(result);
    const evaluation = await llmJudge({
      criteria: `
        The agent should:
        1. Provide a structured summary of events
        2. Be concise and direct without narrative phrases
        3. Include key topics, decisions, action items (with owners if present)
        4. Not include excessive technical details about the execution process
      `,
      agentOutput: parsed.response,
    });

    const qualityPass = await t.step("Content quality", () => {
      assert(evaluation.pass, `LLM judge failed: ${evaluation.justification}`);
    });

    const toolUsagePass = await t.step("Google Calendar tools invoked", () => {
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
