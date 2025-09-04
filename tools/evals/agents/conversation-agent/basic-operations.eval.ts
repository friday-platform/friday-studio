import { conversationAgent } from "@atlas/system/agents";
import { assert } from "@std/assert";
import { ConversationAgentContext } from "../../lib/conversation-context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { saveSnapshot } from "../../lib/snapshot.ts";

Deno.test({
  name: "Conversation Agent: Sample tool calling test",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await loadCredentials();
    const context = new ConversationAgentContext();
    context.enableTelemetry();
    await context.initialize();

    try {
      const agentContext = context.createContext({ telemetry: true });

      // Test todo creation and management
      const result = await conversationAgent.execute(
        "Create a todo list using the todoWrite tool with 3 tasks you make up. Afterwards, please read them back to me using the atlas_todo_read tool.",
        agentContext,
      );
      const metrics = context.getMetrics();
      const trace = context.getTrace();

      const pass = await t.step("", () => {
        assert(metrics?.tools.length === 2);
        assert(metrics.tools.at(0)?.name === "atlas_todo_write", "First, called todo_write");
        assert(metrics.tools.at(1)?.name === "atlas_todo_read", "Second, called todo_read");
      });

      await saveSnapshot({
        testPath: new URL(import.meta.url),
        data: { result, metrics, trace },
        pass,
      });
    } finally {
      await context.cleanup();
    }
  },
});
