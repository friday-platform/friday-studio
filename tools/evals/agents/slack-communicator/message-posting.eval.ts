import { slackCommunicatorAgent } from "@atlas/bundled-agents";
import { assert } from "@std/assert";
import { tool } from "ai";
import { z } from "zod/v4";
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

    // Test message posting to specific channel (deterministic eval message)
    const result = await slackCommunicatorAgent.execute(
      "Post to #engineering: Release announcement — v2.3.1 shipped;.",
      context,
    );

    // Basic structural assertions
    const pass = await t.step("Basic validations", () => {
      assert(result.response.length > 5, "Result.response should have content");
    });

    // LLM judge for posting confirmation
    const evaluation = await llmJudge({
      criteria: `
        The agent should:
        1. Confirm that a message was posted to #engineering
        2. Reference the input content: contains "Release announcement — v2.3.1 shipped"
        3. Be concise and factual without narrative phrases
        4. Provide confirmation details like timestamp or channel reference if available
        5. Not include excessive technical execution details
      `,
      agentOutput: result.response,
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
        response: result.response,
        toolCalls: result.toolCalls,
        toolResults: result.toolResults,
        evaluation,
        basicPass: pass,
        qualityPass,
        counters,
      },
      pass: pass && qualityPass && toolUsagePass,
    });
  },
});

Deno.test({
  name: "Slack Communicator: Post message without channel → explicit failure",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await loadCredentials();
    const { tools, counters } = createSlackMCPMockTools();
    const adapter = new AgentContextAdapter(tools);
    const context = adapter.createContext();

    // No channel specified; agent should not guess and must fail clearly
    const result = await slackCommunicatorAgent.execute(
      "Post this: Release announcement — v2.3.1 shipped.",
      context,
    );

    const pass = await t.step("Basic validations", () => {
      assert(result.response.length > 5, "Result.response should have content");
    });

    const noPostPass = await t.step("No posting occurred", () => {
      assert(counters.conversations_add_message === 0, "Should not post without a channel");
    });

    const evaluation = await llmJudge({
      criteria: `
        The agent should:
        1. Not invent a channel or attempt posting
        2. Respond with clear information that the channel has not been found
      `,
      agentOutput: result.response,
    });

    const qualityPass = await t.step("Error messaging quality", () => {
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
        noPostPass,
        qualityPass,
        counters,
      },
      pass: pass && noPostPass && qualityPass,
    });
  },
});

Deno.test({
  name: "Slack Communicator: Post message with resolvable channel name",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await loadCredentials();
    const { tools, counters } = createSlackMCPMockTools();
    const adapter = new AgentContextAdapter(tools);
    const context = adapter.createContext();

    // Provide channel in a resolvable form (plain name without #); mocks include "engineering"
    const result = await slackCommunicatorAgent.execute(
      "Post to channel in which we have a conversation about the release: Release announcement — v2.3.1 shipped.",
      context,
    );

    const pass = await t.step("Basic validations", () => {
      assert(result.response.length > 5, "Result.response should have content");
    });

    const toolUsagePass = await t.step("Tools used for resolution and posting", () => {
      assert(
        counters.channels_list > 0 && counters.conversations_add_message > 0,
        "Should resolve channel by name and perform posting",
      );
    });

    const evaluation = await llmJudge({
      criteria: `
        The agent should:
        1. Confirm that a message was posted to the #release channel
        2. Reference the input content: contains "Release announcement — v2.3.1 shipped"
        3. Be concise and factual
        4. Avoid implementation details
      `,
      agentOutput: result.response,
    });

    const qualityPass = await t.step("Posting confirmation quality", () => {
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
        toolUsagePass,
        counters,
      },
      pass: pass && qualityPass && toolUsagePass,
    });
  },
});

Deno.test({
  name: "Slack Communicator: Message posting — formatting (mrkdwn)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await loadCredentials();
    const { tools: baseTools, counters } = createSlackMCPMockTools();
    const captured: { channel: string; text: string }[] = [];

    const tools = {
      ...baseTools,
      conversations_add_message: tool({
        description: "Post a message to a channel (capture formatting)",
        inputSchema: z.object({
          channel: z.string(),
          text: z.string(),
          thread_ts: z.string().optional(),
        }),
        execute: (input: { channel: string; text: string; thread_ts?: string }) => {
          counters.conversations_add_message++;
          captured.push({ channel: input.channel, text: input.text });
          return { ok: true, ts: "1725514999.00001" };
        },
      }),
    };

    const adapter = new AgentContextAdapter(tools);
    const context = adapter.createContext();

    const result = await slackCommunicatorAgent.execute(
      "Post to #engineering: *Bold* _Italic_ ~Strike~ 1 < 2 and A > B & X. Inline `code` and code block:```js\\nconsole.log('x')\\n``` Mention @alex and link <https://example.com/path?q=1&v=2|Example>",
      context,
    );

    const pass = await t.step("Basic validations", () => {
      assert(result.response.length > 5, "Result.response should have content");
    });

    const postedPass = await t.step("Message was posted and captured", () => {
      assert(captured.length === 1, "Expected exactly one posted message to be captured");
    });

    const channelPass = await t.step("Posted to engineering channel (by ID)", () => {
      assert(captured.length === 1, "Expected exactly one posted message to be captured");
      assert(captured[0]?.channel === "CENG", "Should resolve channel to CENG");
    });

    const formattingPass = await t.step("Slack mrkdwn formatting applied", () => {
      const text = captured[0]?.text ?? "";
      assert(text.includes("`code`"), "Inline code should be wrapped in backticks");
      assert(text.includes("```"), "Should contain a fenced code block");
      assert(text.includes("console.log"), "Code block content should be present");
      assert(text.includes("&lt;"), "Less-than should be escaped");
      assert(text.includes("&gt;"), "Greater-than should be escaped");
      assert(text.includes("&amp;"), "Ampersand should be escaped");
    });

    const evaluation = await llmJudge({
      criteria: `
        The agent should:
        1. Preserve Slack mrkdwn formatting (bold/italic/strike, inline code, code block)
        2. Escape control characters (&, <, >) in text
        3. Resolve the #engineering channel and post there (ID form)
        4. Prefer ID-based mentions/links when used (e.g., <@USERID>, <#CHANNELID>)
      `,
      agentOutput: captured[0]?.text ?? result.response,
    });

    const qualityPass = await t.step("Formatting quality (LLM judge)", () => {
      assert(evaluation.pass, `LLM judge failed: ${evaluation.justification}`);
    });

    await saveSnapshot({
      testPath: new URL(import.meta.url),
      data: {
        result,
        response: result.response,
        toolCalls: result.toolCalls,
        toolResults: result.toolResults,
        captured,
        evaluation,
        basicPass: pass,
        postedPass,
        channelPass,
        formattingPass,
        qualityPass,
        counters,
      },
      pass: pass && postedPass && channelPass && formattingPass && qualityPass,
    });
  },
});
