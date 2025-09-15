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
        "I want to create a workspace that watches a folder on my local computer and analyzes the output. I want that output sent to a Slack channel in my organization.",
        agentContext,
      );
      const metrics = context.getMetrics();

      const pass = await t.step("", () => {
        assert(result.text === "", "Called workspace_summary");
      });

      await saveSnapshot({ testPath: new URL(import.meta.url), data: { result, metrics }, pass });
    } finally {
      await context.cleanup();
    }
  },
});
