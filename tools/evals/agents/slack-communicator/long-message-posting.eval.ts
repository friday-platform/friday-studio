import { slackCommunicatorAgent } from "@atlas/bundled-agents";
import { assert } from "@std/assert";
import { tool } from "ai";
import { z } from "zod";
import { AgentContextAdapter } from "../../lib/context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { createSlackMCPMockTools } from "../../lib/slack-mcp-mock-tools.ts";
import { saveSnapshot } from "../../lib/snapshot.ts";

Deno.test({
  name: "Slack Communicator: Message posting — long message (4000 chars)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await loadCredentials();
    const { tools: baseTools, counters } = createSlackMCPMockTools();
    const captured: { channel: string; text: string }[] = [];

    const tools = {
      ...baseTools,
      conversations_add_message: tool({
        description: "Post a message to a channel",
        inputSchema: z.object({
          channel: z.string(),
          text: z.string(),
          thread_ts: z.string().optional(),
        }),
        execute: (input: { channel: string; text: string; thread_ts?: string }) => {
          counters.conversations_add_message++;
          captured.push({ channel: input.channel, text: input.text });
          return { ok: true, ts: "1725515000.00001" };
        },
      }),
    };

    const adapter = new AgentContextAdapter(tools);
    const context = adapter.createContext();
    const messageSize = 4000;

    const longBody = "A".repeat(messageSize);
    const input = `Post to #engineering: ${longBody}`;

    const result = await slackCommunicatorAgent.execute(input, context);

    const basicPass = await t.step("Basic validations", () => {
      assert(result.response.length > 5, "Result.response should have content");
    });

    const postedPass = await t.step("Message was posted and captured", () => {
      assert(captured.length === 1, "Expected exactly one posted message to be captured");
    });

    const channelPass = await t.step("Posted to engineering channel (by ID)", () => {
      assert(captured.length === 1, "Expected exactly one posted message to be captured");
      assert(captured[0]?.channel === "CENG", "Should resolve channel to CENG");
    });

    const lengthPass = await t.step("Entire body preserved (no truncation)", () => {
      const text = captured[0]?.text ?? "";
      assert(
        text.length >= messageSize,
        `Posted text should be at least ${messageSize} characters long when message size is ${messageSize}`,
      );
      assert(text.includes(longBody), "Posted text should include the entire original body");
    });

    await saveSnapshot({
      testPath: new URL(import.meta.url),
      data: {
        result,
        response: result.response,
        toolCalls: result.toolCalls,
        toolResults: result.toolResults,
        captured,
        counters,
      },
      pass: basicPass && postedPass && channelPass && lengthPass,
    });
  },
});
