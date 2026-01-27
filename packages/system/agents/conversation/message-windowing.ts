/**
 * Message Window Manager for Conversation Agent
 *
 * Implements token-aware message history truncation to prevent context window overflow.
 * Removes tool results from old messages while maintaining recent context.
 */

import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { pruneMessages } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import { convertToModelMessages, type ModelMessage } from "ai";

interface MessageWindowConfig {
  /** Maximum token budget for message history (excluding system prompts) */
  maxTokens: number;
}

// Token estimation constants
const AVG_CHARS_PER_TOKEN = 4;

/**
 * Expand credential-linked data parts into text parts for LLM consumption.
 * Transforms: { type: 'data-credential-linked', data: { displayName: 'Google Calendar' } }
 * Into: { type: 'text', text: '[Connected Google Calendar]' }
 *
 * Note: Uses runtime type checking because the AI SDK's type inference doesn't
 * always include all data event types in the union.
 */
function expandCredentialLinkedParts(messages: AtlasUIMessage[]): AtlasUIMessage[] {
  return messages.map((msg) => {
    const hasCredentialPart = msg.parts.some((p) => p.type === "data-credential-linked");
    if (!hasCredentialPart) return msg;

    return {
      ...msg,
      parts: msg.parts.map((part) => {
        if (part.type === "data-credential-linked" && part.data?.displayName) {
          return { type: "text" as const, text: `[Connected ${part.data.displayName}]` };
        }
        return part;
      }),
    };
  });
}

/**
 * Estimate tokens for any input (message object or string) using robust JSON string length heuristic.
 */
export function estimateTokens(input: unknown): number {
  if (input === undefined || input === null) return 0;
  // Simple, robust heuristic: 1 token ~= 4 characters of JSON representation
  const jsonString = JSON.stringify(input);
  return Math.ceil((jsonString?.length || 0) / AVG_CHARS_PER_TOKEN);
}

/**
 * Truncate message history to fit within token budget.
 * Strategy: Always keep System messages + Newest messages that fit.
 */
export function truncateMessageHistory(
  messages: ModelMessage[],
  { maxTokens }: MessageWindowConfig,
  logger: Logger,
): ModelMessage[] {
  // 1. Separate System messages (High Priority)
  const systemMessages = messages.filter((m) => m.role === "system");
  const conversationMessages = messages.filter((m) => m.role !== "system");

  // Calculate initial usage
  let currentTokens = systemMessages.reduce((sum, m) => sum + estimateTokens(m), 0);

  if (currentTokens > maxTokens) {
    logger.warn("System messages alone exceed token budget", { currentTokens, maxTokens });
    // Fallback: Return just system messages
    return systemMessages;
  }

  // 2. Add recent conversation messages until full (High Priority)
  const keptConversation: ModelMessage[] = [];

  // Iterate backwards from newest to oldest
  for (let i = conversationMessages.length - 1; i >= 0; i--) {
    const msg = conversationMessages.at(i);
    if (!msg) continue;

    const tokens = estimateTokens(msg);

    if (currentTokens + tokens <= maxTokens) {
      keptConversation.unshift(msg);
      currentTokens += tokens;
    } else {
      // Budget full - stop adding older messages
      break;
    }
  }

  const result = [...systemMessages, ...keptConversation];

  logger.debug("Truncated message history", {
    originalCount: messages.length,
    finalCount: result.length,
    finalTokens: currentTokens,
    maxTokens,
  });

  return result;
}

/**
 * Process message history: Convert -> Prune Tool Bloat -> Truncate to Budget
 *
 * Algorithm:
 * 1. Convert to ModelMessages (standard format)
 * 2. Prune tool results (remove heavy outputs from old messages)
 * 3. Truncate based on the PRUNED size (maximize retained context)
 */
export function processMessageHistory(
  messages: AtlasUIMessage[],
  config: MessageWindowConfig,
  logger: Logger,
): ModelMessage[] {
  // 0. Expand credential-linked parts to text before conversion
  const expandedMessages = expandCredentialLinkedParts(messages);

  // 1. Convert to ModelMessages first (to enable pruning)
  const modelMessages = convertToModelMessages(expandedMessages);

  // 2. Prune tool results (Phase 1)
  // This shrinks the "fat" messages BEFORE we calculate budget.
  // We keep tool results only in the last 4 messages for recent context
  // but strip them from older history to save tokens.
  const prunedMessages = pruneMessages({
    messages: modelMessages,
    toolCalls: "before-last-4-messages",
    emptyMessages: "remove",
  });

  // 3. Truncate based on the pruned size (Phase 2)
  // Now that messages are smaller, we can keep more of them.
  const finalMessages = truncateMessageHistory(prunedMessages, config, logger);

  return finalMessages;
}
