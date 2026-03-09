/**
 * Message Window Manager for Conversation Agent
 *
 * Implements token-aware message history truncation to prevent context window overflow.
 * Removes tool results from old messages while maintaining recent context.
 */

import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { isImageMimeType } from "@atlas/core/artifacts/file-upload";
import { resolveImageParts } from "@atlas/core/artifacts/images";
import { ArtifactStorage } from "@atlas/core/artifacts/storage";
import { pruneMessages } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import {
  convertToModelMessages,
  type ImagePart,
  type ModelMessage,
  type UserModelMessage,
} from "ai";

interface MessageWindowConfig {
  /** Maximum token budget for message history (excluding system prompts) */
  maxTokens: number;
}

// Token estimation constants
const AVG_CHARS_PER_TOKEN = 4;
/** Estimated tokens per image — based on Anthropic's ~1600 token cost for most images */
const TOKENS_PER_IMAGE = 1600;

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
 * Expand artifact-attached data parts into text parts for LLM consumption.
 * Transforms: { type: 'data-artifact-attached', data: { artifactIds: ['uuid'], filenames: ['file.csv'] } }
 * Into: { type: 'text', text: '[Attached artifacts: uuid]' }
 *
 * This ensures artifact IDs are available in the prompt text for agents like
 * data-analyst that extract artifact references via regex.
 */
function expandArtifactAttachedParts(messages: AtlasUIMessage[]): AtlasUIMessage[] {
  return messages.map((msg) => {
    const hasArtifactPart = msg.parts.some((p) => p.type === "data-artifact-attached");
    if (!hasArtifactPart) return msg;

    return {
      ...msg,
      parts: msg.parts.map((part) => {
        if (part.type === "data-artifact-attached" && Array.isArray(part.data.artifactIds)) {
          const ids = part.data.artifactIds;
          const filenames = part.data.filenames ?? [];

          // Build attachment list with both filename and artifact ID
          // Format: "filename (artifact:uuid)" - filename for friendly display, ID for agent processing
          const attachments = ids.map((id, i) => {
            const filename = filenames[i] ?? "file";
            return `${filename} (artifact:${id})`;
          });

          return { type: "text" as const, text: `[Attached files: ${attachments.join(", ")}]` };
        }
        return part;
      }),
    };
  });
}

/**
 * Collect image artifact IDs from the most recent user message only.
 * Uses the mimeTypes array from the event payload (added by task #6).
 * Must be called BEFORE expandArtifactAttachedParts since expansion replaces data parts.
 *
 * Only the last user turn's images are injected as ImageParts — older images
 * are represented by the text fallback from expandArtifactAttachedParts.
 */
function collectImageArtifactIds(messages: AtlasUIMessage[]): string[] {
  const imageIds: string[] = [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "user") continue;

    for (const part of msg.parts) {
      if (part.type !== "data-artifact-attached") continue;
      if (!Array.isArray(part.data.artifactIds)) continue;

      const ids = part.data.artifactIds;
      const mimeTypes = part.data.mimeTypes ?? [];

      for (let j = 0; j < ids.length; j++) {
        const mime = mimeTypes[j];
        const id = ids[j];
        if (id && mime && isImageMimeType(mime)) {
          imageIds.push(id);
        }
      }
    }

    break; // Only process the last user message
  }

  return imageIds;
}

/**
 * Inject resolved ImageParts into the last user ModelMessage.
 * Fetches image artifacts from storage, resolves binary data, and appends
 * ImageParts alongside the existing text content.
 */
async function injectImageParts(
  modelMessages: ModelMessage[],
  imageArtifactIds: string[],
  logger: Logger,
): Promise<ModelMessage[]> {
  if (imageArtifactIds.length === 0) return modelMessages;

  const fetchResult = await ArtifactStorage.getManyLatest({ ids: imageArtifactIds });
  if (!fetchResult.ok) {
    logger.warn("Failed to fetch image artifacts for message injection", {
      error: fetchResult.error,
    });
    return modelMessages;
  }

  const imageParts = await resolveImageParts(fetchResult.data, ArtifactStorage);
  if (imageParts.length === 0) return modelMessages;

  // Find the last user message and append ImageParts to it
  const lastUserIdx = modelMessages.findLastIndex((m) => m.role === "user");
  if (lastUserIdx === -1) return modelMessages;

  const lastUser = modelMessages[lastUserIdx];
  if (!lastUser) return modelMessages;
  const existingContent =
    typeof lastUser.content === "string"
      ? [{ type: "text" as const, text: lastUser.content }]
      : [...lastUser.content];

  const result = [...modelMessages];
  result[lastUserIdx] = {
    ...lastUser,
    content: [...existingContent, ...imageParts],
  } as ModelMessage;

  logger.debug("Injected image parts into last user message", {
    imageCount: imageParts.length,
    artifactIds: imageArtifactIds,
  });

  return result;
}

/**
 * Estimate tokens for any input (message object or string) using robust JSON string length heuristic.
 * ImageParts are assigned a fixed cost (~1600 tokens) instead of serializing binary data.
 */
export function estimateTokens(input: unknown): number {
  if (input === undefined || input === null) return 0;

  // Handle ModelMessage objects — check content array for ImageParts
  if (isModelMessageLike(input) && Array.isArray(input.content)) {
    let tokens = 0;
    for (const part of input.content) {
      if (isImagePartLike(part)) {
        tokens += TOKENS_PER_IMAGE;
      } else {
        tokens += Math.ceil((JSON.stringify(part)?.length || 0) / AVG_CHARS_PER_TOKEN);
      }
    }
    // Add overhead for role and message structure
    tokens += Math.ceil(JSON.stringify({ role: input.role }).length / AVG_CHARS_PER_TOKEN);
    return tokens;
  }

  // Simple, robust heuristic: 1 token ~= 4 characters of JSON representation
  const jsonString = JSON.stringify(input);
  return Math.ceil((jsonString?.length || 0) / AVG_CHARS_PER_TOKEN);
}

function isModelMessageLike(input: unknown): input is { role: string; content: unknown } {
  return typeof input === "object" && input !== null && "role" in input && "content" in input;
}

function isImagePartLike(input: unknown): input is ImagePart {
  return typeof input === "object" && input !== null && "type" in input && input.type === "image";
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
 * Process message history: Convert -> Sanitize -> Inject Images -> Prune Tool Bloat -> Truncate to Budget
 *
 * Algorithm:
 * 0. Collect image artifact IDs from data parts (before expansion destroys them)
 * 1. Expand data parts to text (credentials, artifacts)
 * 2. Convert to ModelMessages (standard format)
 * 3. Sanitize tool-call inputs (fix AI SDK undefined input bug)
 * 4. Inject ImageParts for image artifacts into last user message
 * 5. Prune tool results (remove heavy outputs from old messages)
 * 6. Merge consecutive user messages
 * 7. Truncate based on the PRUNED size (maximize retained context)
 */
export async function processMessageHistory(
  messages: AtlasUIMessage[],
  config: MessageWindowConfig,
  logger: Logger,
): Promise<ModelMessage[]> {
  // 0. Collect image artifact IDs before expansion (expansion replaces data parts with text)
  const imageArtifactIds = collectImageArtifactIds(messages);

  // 1. Expand data parts to text before conversion
  // This ensures structured data (credentials, artifacts) is available in prompt text
  let expandedMessages = expandCredentialLinkedParts(messages);
  expandedMessages = expandArtifactAttachedParts(expandedMessages);

  // 2. Convert to ModelMessages first (to enable pruning)
  let modelMessages = convertToModelMessages(expandedMessages);

  // 3. Fix tool-call parts with missing input (AI SDK bug workaround)
  // When a tool call fails Zod validation, AI SDK stores input in rawInput
  // but the validation schema strips it, leaving input as undefined.
  // The Anthropic provider then sends input: undefined → API rejects.
  sanitizeToolCallInputs(modelMessages);

  // 4. Inject ImageParts for image artifacts
  modelMessages = await injectImageParts(modelMessages, imageArtifactIds, logger);

  // 5. Prune tool results (Phase 1)
  // This shrinks the "fat" messages BEFORE we calculate budget.
  // We keep tool results only in the last 4 messages for recent context
  // but strip them from older history to save tokens.
  const prunedMessages = pruneMessages({
    messages: modelMessages,
    toolCalls: "before-last-4-messages",
    emptyMessages: "remove",
  });

  // 6. Merge consecutive user messages (Phase 2)
  // Empty assistant messages (e.g. from content-filter) produce zero model messages
  // after conversion and pruning, creating consecutive user messages that violate
  // the API's alternating role requirement. Merge them to prevent API errors.
  const mergedMessages = mergeConsecutiveUserMessages(prunedMessages, logger);

  // 7. Truncate based on the pruned size (Phase 3)
  // Now that messages are smaller, we can keep more of them.
  const finalMessages = truncateMessageHistory(mergedMessages, config, logger);

  return finalMessages;
}

/**
 * Fix tool-call parts with missing input (AI SDK bug workaround).
 *
 * When a tool call fails Zod validation, AI SDK emits a `tool-input-error` chunk
 * that stores `input: undefined` and `rawInput: chunk.input`. The validation schema
 * (`uiMessagesSchema`) doesn't include `rawInput`, so Zod strips it during
 * `validateUIMessages`. After conversion, `convertToModelMessages` tries
 * `part.input ?? part.rawInput` — both undefined. The Anthropic provider then
 * serializes `input: undefined` as a missing field → API rejects with
 * "tool_use.input: Field required".
 *
 * Mutates in place for efficiency — called before pruning on every turn.
 */
export function sanitizeToolCallInputs(messages: ModelMessage[]): ModelMessage[] {
  for (const message of messages) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "tool-call" && part.input == null) {
          part.input = {};
        }
      }
    }
  }
  return messages;
}

/**
 * Merge consecutive user messages into a single message.
 * This handles corruption from empty assistant messages (e.g. content-filter)
 * that produce zero model messages, leaving consecutive user messages
 * that violate the API's alternating role requirement.
 */
function mergeConsecutiveUserMessages(messages: ModelMessage[], logger: Logger): ModelMessage[] {
  if (messages.length <= 1) return messages;

  const result: ModelMessage[] = [];
  let mergeCount = 0;

  for (const msg of messages) {
    const prev = result[result.length - 1];

    if (prev && prev.role === "user" && msg.role === "user") {
      // Normalize content to array form for both messages
      const prevUser = prev as UserModelMessage;
      const currUser = msg as UserModelMessage;
      const prevParts =
        typeof prevUser.content === "string"
          ? [{ type: "text" as const, text: prevUser.content }]
          : prevUser.content;
      const currParts =
        typeof currUser.content === "string"
          ? [{ type: "text" as const, text: currUser.content }]
          : currUser.content;

      result[result.length - 1] = { role: "user", content: [...prevParts, ...currParts] };
      mergeCount++;
    } else {
      result.push(msg);
    }
  }

  if (mergeCount > 0) {
    logger.warn("Merged consecutive user messages", {
      originalCount: messages.length,
      mergedCount: result.length,
      mergesPerformed: mergeCount,
    });
  }

  return result;
}
