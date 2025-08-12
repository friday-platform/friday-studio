/**
 * Conversation Agent - SDK Architecture Implementation
 *
 * Interactive conversation agent for workspace collaboration with:
 * - Persistent conversation history via daemon storage
 * - Tool execution through MCP server
 * - Real-time streaming responses
 * - Task tracking with todos
 */

import { createAgent } from "@atlas/agent-sdk";
import { createAnthropic } from "@ai-sdk/anthropic";
import { stepCountIs, streamText, type TextStreamPart, ToolSet } from "ai";
import { convertAIStreamToSSE, createRequestEvent } from "@atlas/core";
import type { SSEEvent } from "@atlas/config";
import { conversationStorageTool, conversationTools, streamEvent } from "./tools/mod.ts";
import SYSTEM_PROMPT from "./prompt.txt" with { type: "text" };

type MessageHistory = {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  historyContext: string;
};

/**
 * Get the system prompt with optional conversation history injection
 * Based on existing conversation-agent.ts buildSystemPrompt logic
 */
function getSystemPrompt(
  history?: { messages: Array<{ role: string; content: string }>; historyContext: string },
  customPrompt?: string,
): string {
  let prompt = customPrompt || SYSTEM_PROMPT;

  // Replace the conversation history placeholder if present
  if (history?.historyContext) {
    prompt = prompt.replace(
      "{{CONVERSATION_HISTORY}}",
      `\nConversation History:\n${history.historyContext}\n`,
    );
  } else {
    // Remove the placeholder if no history
    prompt = prompt.replace("{{CONVERSATION_HISTORY}}", "");
  }

  return prompt;
}

/**
 * Extracts metadata from SSE events for tool calls and results.
 * Captures tool names, call IDs, arguments, and results for tracing.
 *
 * @param sseEvent - Server-sent event containing tool execution data
 * @returns Metadata object for tool events, undefined for other event types
 */
function extractSSEMetadata(sseEvent: SSEEvent): Record<string, unknown> | undefined {
  if (sseEvent.type === "tool_call") {
    return {
      toolName: sseEvent.data.toolName,
      toolCallId: sseEvent.data.toolCallId,
      args: sseEvent.data.args,
    };
  }
  if (sseEvent.type === "tool_result") {
    return {
      toolName: sseEvent.data.toolName,
      toolCallId: sseEvent.data.toolCallId,
      result: sseEvent.data.result,
    };
  }
  return undefined;
}

// Export the agent
export const conversationAgent = createAgent({
  id: "conversation",
  displayName: "Conversation Agent",
  version: "1.0.0",
  description: "Interactive conversation agent for workspace collaboration",

  expertise: {
    domains: ["conversation"],
    capabilities: ["interactive-chat"],
    examples: [],
  },

  /**
   * Main conversation handler that processes user prompts with streaming responses.
   * Manages conversation history persistence, tool execution, and real-time event streaming.
   *
   * @param prompt - User's input message
   * @param context - Execution context with session, logger, and available tools
   * @returns Conversation response with text, reasoning, execution flow, and tool calls
   */
  handler: async (prompt, { session, logger, tools }) => {
    if (!session.streamId || !streamEvent.execute) {
      throw new Error("Stream ID is required");
    }

    const anthropic = createAnthropic({
      apiKey: Deno.env.get("ANTHROPIC_API_KEY"),
    });

    const allTools = {
      ...tools,
      ...conversationTools,
    };

    /**
     * @FIXME: this is the wrong level of abstraction. Retrieval should be much more automatic here.
     */
    let history: MessageHistory = {
      messages: [],
      historyContext: "",
    };

    try {
      const result = await conversationStorageTool.execute?.({
        operation: "retrieve",
        streamId: session.streamId,
      }, { messages: [], toolCallId: crypto.randomUUID() });

      if (result?.success && result.operation === "retrieve" && result?.result.messageCount > 0) {
        const messages = result.result.messages;
        const historyContext = messages
          .map((m: { role: string; content: string }) => `${m.role}: ${m.content}`)
          .join("\n");

        history = { messages, historyContext };
      }
    } catch (error) {
      logger.warn("Failed to load conversation history", { error });
    }

    await conversationStorageTool.execute?.(
      {
        streamId: session.streamId,
        operation: "store",
        message: { role: "user", content: prompt },
        metadata: { userId: session.userId, timestamp: new Date().toISOString() },
      },
      { toolCallId: crypto.randomUUID(), messages: [] },
    );

    const requestEvent = createRequestEvent(prompt);
    await streamEvent.execute(
      {
        streamId: session.streamId,
        id: requestEvent.id,
        eventType: requestEvent.type,
        content: requestEvent.data.content,
        timestamp: requestEvent.timestamp,
      },
      { toolCallId: crypto.randomUUID(), messages: [] },
    );

    const { fullStream, text, reasoning } = streamText({
      model: anthropic("claude-sonnet-4-20250514"),
      system: getSystemPrompt(history),
      messages: [{ role: "user", content: prompt }],
      tools: allTools,
      toolChoice: "auto",
      stopWhen: stepCountIs(20),
      temperature: 0.3,
      maxOutputTokens: 12000,
      providerOptions: {
        anthropic: { thinking: { type: "enabled", budgetTokens: 25000 } },
      },
    });

    // I think this can be simpplified.
    const executionFlow = {
      steps: [] as Array<{ type: string; tool?: string; args?: unknown; timestamp: string }>,
      reasoning: [] as string[],
      responseBuffer: "",
      thinkingBuffer: "",
    };

    let prevChunk: TextStreamPart<ToolSet> | undefined = undefined;

    for await (const chunk of fullStream) {
      const sseEvent = convertAIStreamToSSE(chunk, prevChunk);
      prevChunk = chunk;

      if (!sseEvent) {
        logger.debug("Skipped null event from chunk", { chunkType: chunk.type });
        continue;
      }

      await streamEvent.execute(
        {
          id: sseEvent.id,
          streamId: session.streamId,
          eventType: sseEvent.type,
          content: sseEvent.data.content,
          metadata: extractSSEMetadata(sseEvent),
          timestamp: sseEvent.timestamp,
        },
        { toolCallId: crypto.randomUUID(), messages: [] },
      );

      switch (sseEvent.type) {
        case "thinking":
          executionFlow.thinkingBuffer += sseEvent.data.content;
          executionFlow.reasoning.push(sseEvent.data.content);
          break;
        case "text":
          executionFlow.responseBuffer += sseEvent.data.content;
          break;
        case "finish":
          executionFlow.responseBuffer += sseEvent.data.content;
          break;
        case "tool_call":
          executionFlow.steps.push({
            type: "tool_call",
            tool: sseEvent.data.toolName,
            args: sseEvent.data.args,
            timestamp: sseEvent.timestamp,
          });
          logger.info("Tool call initiated", { tool: sseEvent.data.toolName });
          break;
      }
    }

    const finalText = await text;
    const finalReasoning = await reasoning;

    await conversationStorageTool.execute?.(
      {
        streamId: session.streamId,
        operation: "store",
        message: { role: "assistant", content: finalText },
        metadata: { timestamp: new Date().toISOString() },
      },
      { toolCallId: crypto.randomUUID(), messages: [] },
    );

    // Convert reasoning to proper format - prioritize collected reasoning if AI SDK reasoning is empty
    const processedReasoning = finalReasoning.length > 0
      ? finalReasoning.map((item) => item.text).join("\n")
      : executionFlow.reasoning.join("\n");

    logger.debug("🎉", {
      text: finalText || executionFlow.responseBuffer,
      reasoning: processedReasoning,
      executionFlow: executionFlow.steps,
      toolCalls: executionFlow.steps.filter((s) => s.type === "tool_call"),
    });

    return {
      text: finalText || executionFlow.responseBuffer,
      reasoning: processedReasoning,
      executionFlow: executionFlow.steps,
      toolCalls: executionFlow.steps.filter((s) => s.type === "tool_call"),
    };
  },
  environment: {
    required: [{ name: "ANTHROPIC_API_KEY", description: "Claude API key" }],
    optional: [
      { name: "ATLAS_DAEMON_URL", description: "Platform MCP server URL" },
    ],
  },
});
