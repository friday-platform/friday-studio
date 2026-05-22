/**
 * Map-reduce summarization for a single chat (friday-studio-6dq).
 *
 * Pipeline:
 *   1. Project messages into a compact text ledger ([role] text per
 *      message). Non-text parts (tool calls, data parts) are dropped —
 *      they're agent-internals that don't help reconstruct the prior
 *      conversation.
 *   2. Chunk the ledger by character budget (proxy for tokens — ~4
 *      chars per token for English). Each chunk goes to `smallLLM`
 *      for a per-chunk summary.
 *   3. Reduce: concatenate the per-chunk summaries and ask the same
 *      model to roll them up into a single bounded-output document.
 *
 * The model role is `labels` (small, fast — the same one `smallLLM`
 * already uses for chat-title generation), so this is throttled by
 * the cheapest configured model.
 *
 * Output size is bounded by a hard `maxOutputTokens` on the reduce
 * step. The map step also caps per-chunk size so a 100k-message
 * source chat doesn't blow up the reduce input.
 */

import type { AtlasUIMessage } from "@atlas/agent-sdk";
import type { Chat } from "@atlas/core/chat/storage";
import { type PlatformModels, smallLLM } from "@atlas/llm";

/** Approx 4 chars per token for English. Chunk target ~6k tokens. */
const CHUNK_MAX_CHARS = 24_000;
/** Cap on per-chunk summary length (tokens) — keeps reduce input bounded. */
const MAP_MAX_OUTPUT_TOKENS = 400;
/** Cap on the final summary length. The whole point of the feature is
 *  a bounded output the calling agent can ingest without overflow. */
const REDUCE_MAX_OUTPUT_TOKENS = 1500;

const MAP_SYSTEM_PROMPT = [
  "You compress a slice of a chat transcript into a compact summary.",
  "Keep: decisions made, key facts established, open questions, code/file/url references, blockers, names of people or systems mentioned.",
  "Drop: pleasantries, repeated information, tool-call mechanics.",
  "Format: short bullets. No preamble, no closing. Be terse.",
].join("\n");

const REDUCE_SYSTEM_PROMPT_BASE = [
  "You merge a sequence of partial chat-transcript summaries into a single coherent summary.",
  "The output must let a separate AI agent pick up the conversation cold — it should know what was decided, what's still open, and what artifacts (files, links, names) matter.",
  "Format: short labeled sections (e.g. 'Context:', 'Decisions:', 'Open questions:', 'References:'). No preamble.",
  "Be terse. If a section has nothing, omit it.",
].join("\n");

function extractMessageText(message: AtlasUIMessage): string {
  const parts: string[] = [];
  for (const part of message.parts) {
    if (part.type !== "text") continue;
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string" && text.trim().length > 0) parts.push(text);
  }
  return parts.join("\n").trim();
}

/** Project the chat into role-prefixed text blocks ready for chunking. */
export function projectMessages(chat: Chat): { ledger: string[]; usedCount: number } {
  const ledger: string[] = [];
  let used = 0;
  for (const message of chat.messages) {
    const text = extractMessageText(message);
    if (!text) continue;
    const role =
      message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : "system";
    ledger.push(`[${role}] ${text}`);
    used += 1;
  }
  return { ledger, usedCount: used };
}

/**
 * Greedy character-budget chunking that keeps whole messages intact.
 * Falls back to splitting an oversized single message across chunks —
 * a 30k-char model response shouldn't crash the summarizer.
 */
export function chunkLedger(ledger: string[], maxChars = CHUNK_MAX_CHARS): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const block of ledger) {
    if (block.length > maxChars) {
      // Flush whatever's in `current` first so the oversized block
      // gets its own dedicated chunks instead of mixing.
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < block.length; i += maxChars) {
        chunks.push(block.slice(i, i + maxChars));
      }
      continue;
    }
    const separator = current ? "\n\n" : "";
    if (current.length + separator.length + block.length > maxChars) {
      chunks.push(current);
      current = block;
    } else {
      current += separator + block;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export interface SummarizeChatInput {
  chat: Chat;
  platformModels: PlatformModels;
  /** Optional steering for the reduce step (e.g. "decisions and open questions"). */
  focus?: string;
  abortSignal?: AbortSignal;
}

export interface SummarizeChatOutput {
  summary: string;
  messageCount: number;
  modelId: string;
  generatedAt: string;
}

/**
 * Returns a bounded-output summary of the given chat. The caller owns
 * caching — this function always re-summarizes on call.
 */
export async function summarizeChat(input: SummarizeChatInput): Promise<SummarizeChatOutput> {
  const generatedAt = new Date().toISOString();
  const modelId = input.platformModels.get("labels").modelId;

  const { ledger, usedCount } = projectMessages(input.chat);
  if (usedCount === 0) {
    return {
      summary: "(empty chat — no text content to summarize)",
      messageCount: 0,
      modelId,
      generatedAt,
    };
  }

  const chunks = chunkLedger(ledger);
  const focusClause = input.focus?.trim()
    ? `\nThe caller asked you to focus on: ${input.focus.trim()}.`
    : "";

  // Map step. Run sequentially rather than in parallel — `smallLLM`
  // shares one inflight slot per provider key on most platforms and a
  // burst of N parallel calls would just queue at the provider anyway.
  // The latency tradeoff is acceptable for the size of chats we expect
  // (tens of chunks at most).
  const partials: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i] ?? "";
    const partial = await smallLLM({
      platformModels: input.platformModels,
      system: MAP_SYSTEM_PROMPT + focusClause,
      prompt: `Chunk ${i + 1} of ${chunks.length} from the source chat:\n\n${chunk}`,
      abortSignal: input.abortSignal,
      maxOutputTokens: MAP_MAX_OUTPUT_TOKENS,
    });
    partials.push(partial.trim());
  }

  // Single-chunk fast path: no reduce needed, the map output IS the
  // summary. Skip the second LLM call.
  if (partials.length === 1) {
    return { summary: partials[0] ?? "", messageCount: usedCount, modelId, generatedAt };
  }

  const reducePrompt = partials.map((p, i) => `--- Partial ${i + 1} ---\n${p}`).join("\n\n");
  const summary = await smallLLM({
    platformModels: input.platformModels,
    system: REDUCE_SYSTEM_PROMPT_BASE + focusClause,
    prompt: reducePrompt,
    abortSignal: input.abortSignal,
    maxOutputTokens: REDUCE_MAX_OUTPUT_TOKENS,
  });

  return { summary: summary.trim(), messageCount: usedCount, modelId, generatedAt };
}
