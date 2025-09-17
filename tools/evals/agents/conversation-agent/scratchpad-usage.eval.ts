import { createAtlasClient } from "@atlas/oapi-client";
import { conversationAgent } from "@atlas/system/agents";
import { assert } from "@std/assert";
import { ConversationAgentContext } from "../../lib/conversation-context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { saveSnapshot } from "../../lib/snapshot.ts";

Deno.test({
  name: "Conversation Agent: Verify scratchpad usage for complex requirements gathering",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await loadCredentials();
    const context = new ConversationAgentContext();
    context.enableTelemetry();
    await context.initialize();

    try {
      const agentContext = context.createContext({ telemetry: true });
      const streamId = agentContext.session.streamId ?? `test-stream-${Date.now()}`;
      const client = createAtlasClient();

      // Initial VC meeting brief request
      const initialResult = await conversationAgent.execute(
        `I'm an early-stage VC and my calendar is full of meetings with startups. At the beginning of every day, I want a brief of all my meetings including:
1. Who I'm meeting with
2. anything I should know about the company/founding team
3. What questions I should be asking them, based on their stage, product readiness, positioning, etc.`,
        agentContext,
      );

      // Check initial notes were taken
      const initialNotes = await client.GET("/api/scratchpad/{streamId}", {
        params: { path: { streamId } },
      });

      await t.step("Agent should take initial notes about requirements", () => {
        assert(
          initialNotes.data && initialNotes.data.notes.length > 0,
          "Agent should have taken notes about initial requirements",
        );

        const notes = initialNotes.data?.notes.map((n) => n.note).join("\n") || "";
        assert(
          notes.includes("VC") || notes.includes("meeting") || notes.includes("brief"),
          "Notes should contain context about VC meeting briefs",
        );
      });

      // Simulate answering clarifying questions
      const clarificationResult = await conversationAgent.execute(
        "I use Google Calendar. Send the briefs to my email at 7:30am PT each morning.",
        agentContext,
      );

      // Check notes after clarification
      const clarificationNotes = await client.GET("/api/scratchpad/{streamId}", {
        params: { path: { streamId } },
      });

      await t.step("Agent should note clarification answers", () => {
        const initialCount = initialNotes.data?.notes.length || 0;
        const clarificationCount = clarificationNotes.data?.notes.length || 0;

        assert(
          clarificationNotes.data && clarificationCount > initialCount,
          "Agent should have added notes after receiving clarification",
        );

        const allNotes = clarificationNotes.data?.notes.map((n) => n.note).join("\n") || "";
        assert(
          allNotes.includes("Google Calendar") ||
            allNotes.includes("7:30am") ||
            allNotes.includes("email"),
          "Notes should contain the clarified requirements",
        );
      });

      // Test referential context ("change that")
      const referentialResult = await conversationAgent.execute(
        "Actually, make that 8am instead",
        agentContext,
      );

      // Check if agent recalls context properly
      const referentialEval = await llmJudge({
        criteria:
          "Atlas should understand 'that' refers to the meeting brief time and acknowledge changing it to 8am",
        agentOutput: referentialResult.text,
      });
      await t.step("Agent should handle referential context using scratchpad", () => {
        assert(referentialEval.pass, referentialEval.justification);
      });

      // Get final notes for snapshot
      const finalNotes = await client.GET("/api/scratchpad/{streamId}", {
        params: { path: { streamId } },
      });

      // Evaluate overall scratchpad usage
      const scratchpadEval = await llmJudge({
        criteria: `The agent should have used the scratchpad effectively:
1. Took notes about initial VC meeting brief requirements
2. Noted clarifications about Google Calendar and email timing
3. Updated notes when time was changed from 7:30am to 8am
4. Notes should be structured and track the evolving requirements`,
        agentOutput: JSON.stringify(finalNotes.data?.notes || [], null, 2),
      });

      await t.step("Overall scratchpad usage quality", () => {
        assert(scratchpadEval.pass, scratchpadEval.justification);
      });

      const metrics = context.getMetrics();

      await saveSnapshot({
        testPath: new URL(import.meta.url),
        data: {
          initialResult,
          clarificationResult,
          referentialResult,
          scratchpadNotes: finalNotes.data?.notes || [],
          metrics,
        },
        pass: referentialEval.pass && scratchpadEval.pass,
      });
    } finally {
      await context.cleanup();
    }
  },
});
