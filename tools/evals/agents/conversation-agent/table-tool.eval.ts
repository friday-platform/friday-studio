import { conversationAgent } from "@atlas/system/agents";
import { assert } from "@std/assert";
import { ConversationAgentContext } from "../../lib/conversation-context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { saveSnapshot } from "../../lib/snapshot.ts";

Deno.test({
  name: "Conversation Agent: Table tool calling test",
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
        "Create a table with 3 rows and 3 columns using the table tool. The columns should be 'Name', 'Age', and 'City'. The rows should be 'John', '25', 'New York', 'Jane', '30', 'Los Angeles', 'Jim', '35', 'Chicago'.",
        agentContext,
      );
      const metrics = context.getMetrics();

      const pass = await t.step("", () => {
        assert(result.text === "", "Called table_output");
      });

      await saveSnapshot({ testPath: new URL(import.meta.url), data: { result, metrics }, pass });
    } finally {
      await context.cleanup();
    }
  },
});
