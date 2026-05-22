/**
 * Cache layer for chat summaries (friday-studio-6dq).
 *
 * Server-side map-reduce summarization is expensive — every map-reduce
 * pass costs N+1 LLM calls. The cache keys on
 * `{workspaceId}.{chatId}.{updatedAtMs}.{focusHash}` so a new message
 * append (which advances `updatedAt`) naturally invalidates without
 * an explicit purge.
 *
 * Storage: JetStream KV bucket `CHAT_SUMMARIES`. `history: 1` keeps a
 * single revision per key — we never need to read prior versions and
 * the cache is best-effort durable. File-backed so summaries survive
 * restarts.
 */

import { createLogger } from "@atlas/logger";
import { type KV, type NatsConnection, StorageType } from "nats";

const logger = createLogger({ component: "chat-summaries-storage" });

const KV_BUCKET = "CHAT_SUMMARIES";
const SAFE_NAME_RE = /[^-/=.\w]/g;
const dec = new TextDecoder();
const enc = new TextEncoder();

/** Persisted summary payload — surfaces back to the agent via the route. */
export interface ChatSummary {
  summary: string;
  messageCount: number;
  modelId: string;
  /** ISO timestamp the summary was generated. */
  generatedAt: string;
}

function sanitizeKeyComponent(s: string): string {
  return s.replace(SAFE_NAME_RE, "_");
}

/**
 * Compose the KV key. Uses periods (NATS-native separator) instead of
 * slashes so the key is a single subject token; downstream filters
 * stay simple if we ever want to list-by-prefix.
 */
function kvKey(input: {
  workspaceId: string;
  chatId: string;
  updatedAtMs: number;
  focusHash: string;
}): string {
  return [
    sanitizeKeyComponent(input.workspaceId),
    sanitizeKeyComponent(input.chatId),
    String(input.updatedAtMs),
    sanitizeKeyComponent(input.focusHash),
  ].join(".");
}

export async function ensureChatSummariesKVBucket(nc: NatsConnection): Promise<KV> {
  const js = nc.jetstream();
  return await js.views.kv(KV_BUCKET, { history: 1, storage: StorageType.File });
}

let cachedKV: KV | null = null;
let connection: NatsConnection | null = null;

export function initChatSummariesStorage(nc: NatsConnection): void {
  connection = nc;
  cachedKV = null;
}

async function kv(): Promise<KV> {
  if (cachedKV) return cachedKV;
  if (!connection) {
    throw new Error(
      "ChatSummariesStorage not initialized — call initChatSummariesStorage(nc) at daemon startup",
    );
  }
  cachedKV = await ensureChatSummariesKVBucket(connection);
  return cachedKV;
}

interface KeyParts {
  workspaceId: string;
  chatId: string;
  updatedAtMs: number;
  focusHash: string;
}

async function get(parts: KeyParts): Promise<ChatSummary | null> {
  try {
    const k = await kv();
    const entry = await k.get(kvKey(parts));
    if (!entry || entry.operation !== "PUT") return null;
    return JSON.parse(dec.decode(entry.value)) as ChatSummary;
  } catch (err) {
    logger.warn("chat_summaries_get_failed", {
      workspaceId: parts.workspaceId,
      chatId: parts.chatId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function put(parts: KeyParts, value: ChatSummary): Promise<void> {
  try {
    const k = await kv();
    await k.put(kvKey(parts), enc.encode(JSON.stringify(value)));
  } catch (err) {
    // Cache write failure is non-fatal — the route still returns the
    // computed summary, just won't be hit on the next call.
    logger.warn("chat_summaries_put_failed", {
      workspaceId: parts.workspaceId,
      chatId: parts.chatId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const ChatSummariesStorage = { get, put };
