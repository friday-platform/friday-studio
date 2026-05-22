/**
 * JetStream-backed chat storage.
 *
 * One JetStream stream per chat (CHAT_<workspaceId>_<chatId>) carrying messages.
 * One shared KV bucket (CHATS) carrying per-chat metadata.
 *
 * - Append cost: O(1) — one broker publish, no rewrite of history.
 * - Read cost: stream the per-chat consumer; no full-file parse on append.
 * - Concurrency: in-process FIFO queue per (workspaceId, chatId) above the
 *   broker's per-subject FIFO; KV CAS for compound metadata mutations.
 */

import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { validateAtlasUIMessages } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import { ColorSchema, fail, type Result, randomColor, stringifyError, success } from "@atlas/utils";
import {
  type JetStreamClient,
  type JetStreamManager,
  type KV,
  type NatsConnection,
  headers as natsHeaders,
  RetentionPolicy,
  StorageType,
} from "nats";
import { z } from "zod";

const logger = createLogger({ component: "chat-jetstream-backend" });

const ChatSourceSchema = z.enum(["atlas", "slack", "discord", "telegram", "whatsapp", "teams"]);
type ChatSource = z.infer<typeof ChatSourceSchema>;

const SystemPromptContextSchema = z.object({
  timestamp: z.iso.datetime(),
  systemMessages: z.array(z.string()),
});

/** Chat metadata persisted in the CHATS KV bucket — everything except the messages array. */
const ChatMetadataSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  workspaceId: z.string().min(1),
  source: ChatSourceSchema,
  color: ColorSchema.optional(),
  title: z.string().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  systemPromptContext: SystemPromptContextSchema.optional(),
  contentFilteredMessageIds: z.array(z.string()).optional(),
});

export type ChatMetadata = z.infer<typeof ChatMetadataSchema>;

export type Chat = ChatMetadata & { messages: AtlasUIMessage[] };

const KV_BUCKET = "CHATS";
const SCHEMA_VERSION = "1";
const DEFAULT_MAX_MSG_SIZE = 8 * 1024 * 1024; // 8MB
const DEFAULT_DUPLICATE_WINDOW_NS = 24 * 60 * 60 * 1_000_000_000; // 24h

/**
 * Per-stream limits applied at chat-stream creation. Caller (the daemon)
 * sources these from `readJetStreamConfig()` so all stream creation in
 * the system shares one set of env-var defaults.
 */
export interface ChatStreamLimits {
  maxMsgSize?: number;
  duplicateWindowNs?: number | bigint;
  /**
   * Phase 3 flag for the storage-naming refactor (friday-studio-1z9):
   * when true, freshly created chats use workspaceId-agnostic
   * stream/subject/KV names. Existing legacy-named chats keep working
   * via dual-read regardless of this flag. Default false until the
   * backfill (friday-studio-qoj) has run.
   */
  newNamingEnabled?: boolean;
}

/**
 * Which naming scheme a chat lives under. Legacy = workspaceId baked
 * into the physical names. New = chat-id only. See friday-studio-1z9.
 */
type ChatScheme = "new" | "legacy";

const SAFE_NAME_RE = /[^A-Za-z0-9_-]/g;

/**
 * Sanitize a chat-id / workspace-id component for use in NATS-derived keys.
 *
 * Same rules used for both stream names and KV keys: nats.js's KV `validateKey`
 * accepts `/^[-/=.\w]+$/` (no `:`), and stream names allow only word chars,
 * `-`, `_`. The component IDs that flow through here can contain colons (e.g.
 * Telegram chatIds shaped `telegram:6139663655`) and other punctuation, so we
 * normalize to a single restricted alphabet for both targets. The original
 * chatId is preserved in metadata (`Chat.id`) — only the lookup key is lossy.
 */
function sanitizeKeyComponent(s: string): string {
  return s.replace(SAFE_NAME_RE, "_");
}

function streamName(workspaceId: string, chatId: string): string {
  return `CHAT_${sanitizeKeyComponent(workspaceId)}_${sanitizeKeyComponent(chatId)}`;
}

/**
 * Legacy flat subject used by streams created before per-message rollup.
 * Old streams stay on this subject so their existing messages remain
 * matched by the stream's `subjects` config.
 */
function flatSubject(workspaceId: string, chatId: string): string {
  return `chats.${workspaceId}.${chatId}.messages`;
}

/**
 * Per-message subject used by streams created with per-message rollup.
 * Combined with `max_msgs_per_subject: 1` on the stream, publishing again
 * to the same `<msgId>` subject auto-purges the prior copy — turning each
 * `appendMessage` into a snapshot of "the latest state of this message."
 *
 * Why this matters: the agent can call `appendMessage` repeatedly during
 * a turn (e.g. on shutdown abort) and each call replaces the previous
 * snapshot rather than creating a new entry or dedupe-dropping.
 */
function messageSubject(workspaceId: string, chatId: string, messageId: string): string {
  return `chats.${workspaceId}.${chatId}.messages.${messageId}`;
}

/** Wildcard the new stream config registers, accepting any per-message subject. */
function messagesWildcardSubject(workspaceId: string, chatId: string): string {
  return `chats.${workspaceId}.${chatId}.messages.>`;
}

function kvKey(workspaceId: string, chatId: string): string {
  return `${sanitizeKeyComponent(workspaceId)}/${sanitizeKeyComponent(chatId)}`;
}

function kvPrefix(workspaceId: string): string {
  return `${sanitizeKeyComponent(workspaceId)}/`;
}

// ── New-scheme name builders (friday-studio-1z9) ─────────────────────
// Workspace-id is no longer encoded in the physical names; chatId
// alone identifies the chat. Reassignment becomes a single metadata
// CAS instead of a stream rename + uploads move.

function streamNameNew(chatId: string): string {
  return `CHAT_${sanitizeKeyComponent(chatId)}`;
}

function flatSubjectNew(chatId: string): string {
  return `chats.${chatId}.messages`;
}

function messageSubjectNew(chatId: string, messageId: string): string {
  return `chats.${chatId}.messages.${messageId}`;
}

function messagesWildcardSubjectNew(chatId: string): string {
  return `chats.${chatId}.messages.>`;
}

function kvKeyNew(chatId: string): string {
  return sanitizeKeyComponent(chatId);
}

// ── Per-scheme dispatchers ────────────────────────────────────────────

function streamNameFor(scheme: ChatScheme, workspaceId: string, chatId: string): string {
  return scheme === "new" ? streamNameNew(chatId) : streamName(workspaceId, chatId);
}

function flatSubjectFor(scheme: ChatScheme, workspaceId: string, chatId: string): string {
  return scheme === "new" ? flatSubjectNew(chatId) : flatSubject(workspaceId, chatId);
}

function messageSubjectFor(
  scheme: ChatScheme,
  workspaceId: string,
  chatId: string,
  messageId: string,
): string {
  return scheme === "new"
    ? messageSubjectNew(chatId, messageId)
    : messageSubject(workspaceId, chatId, messageId);
}

function messagesWildcardSubjectFor(
  scheme: ChatScheme,
  workspaceId: string,
  chatId: string,
): string {
  return scheme === "new"
    ? messagesWildcardSubjectNew(chatId)
    : messagesWildcardSubject(workspaceId, chatId);
}

function kvKeyFor(scheme: ChatScheme, workspaceId: string, chatId: string): string {
  return scheme === "new" ? kvKeyNew(chatId) : kvKey(workspaceId, chatId);
}

function isStreamNotFound(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err);
  return msg.includes("stream not found") || msg.includes("no stream");
}

function isCASConflict(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err);
  return msg.includes("wrong last sequence") || msg.includes("revision");
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Order messages for display by their conceptual start time.
 * Same logic as the legacy file-backed storage — see storage.ts for rationale.
 */
function sortMessagesByStartTime(messages: AtlasUIMessage[]): AtlasUIMessage[] {
  const startTime = (m: AtlasUIMessage): number => {
    const md = m.metadata;
    const ts = md?.startTimestamp ?? md?.timestamp;
    if (!ts) return Number.POSITIVE_INFINITY;
    const parsed = Date.parse(ts);
    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
  };
  return messages
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const diff = startTime(a.m) - startTime(b.m);
      return diff !== 0 ? diff : a.i - b.i;
    })
    .map(({ m }) => m);
}

interface ListChatsOptions {
  limit?: number;
  cursor?: number;
}

interface ListChatsResult {
  chats: Omit<Chat, "messages">[];
  nextCursor: number | null;
  hasMore: boolean;
}

/**
 * Per-key promise queue. Compound operations (validate → publish → KV update)
 * for the same chat run in arrival order on the JS event-loop side, even when
 * the broker would accept them in either order.
 */
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tracked = next.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tracked);
  tracked.finally(() => {
    if (queues.get(key) === tracked) queues.delete(key);
  });
  return next as Promise<T>;
}

/**
 * Records the subject layout of a chat stream so {@link appendMessage} knows
 * whether to publish to the per-message subject (new layout — supports
 * snapshot replacement) or the flat legacy subject (old layout — preserves
 * pre-rollup behavior). Cached per stream name to avoid an info-fetch on
 * every append.
 */
interface StreamLayout {
  /** True when the stream was created with per-message subjects + max_msgs_per_subject:1. */
  perMessage: boolean;
}
const streamLayouts = new Map<string, StreamLayout>();

async function ensureChatStream(
  jsm: JetStreamManager,
  workspaceId: string,
  chatId: string,
  limits: ChatStreamLimits,
  scheme: ChatScheme,
): Promise<StreamLayout> {
  const name = streamNameFor(scheme, workspaceId, chatId);
  const cached = streamLayouts.get(name);
  if (cached) return cached;
  try {
    const info = await jsm.streams.info(name);
    const subjects = info.config.subjects ?? [];
    const wildcard = messagesWildcardSubjectFor(scheme, workspaceId, chatId);
    const layout: StreamLayout = { perMessage: subjects.includes(wildcard) };
    streamLayouts.set(name, layout);
    return layout;
  } catch (err) {
    if (!isStreamNotFound(err)) throw err;
  }
  // Fresh stream — create with the per-message rollup layout. Existing
  // chats hit the path above and keep whatever layout they had, so no
  // in-place migration is required.
  const dup = limits.duplicateWindowNs ?? DEFAULT_DUPLICATE_WINDOW_NS;
  await jsm.streams.add({
    name,
    subjects: [messagesWildcardSubjectFor(scheme, workspaceId, chatId)],
    retention: RetentionPolicy.Limits,
    storage: StorageType.File,
    max_msg_size: limits.maxMsgSize ?? DEFAULT_MAX_MSG_SIZE,
    // One message per subject — each per-message subject only ever
    // retains its latest snapshot. Resnapshots auto-purge prior copies.
    max_msgs_per_subject: 1,
    duplicate_window: typeof dup === "bigint" ? Number(dup) : dup,
  });
  logger.info("Created chat stream", { workspaceId, chatId, name, layout: "per-message", scheme });
  const layout: StreamLayout = { perMessage: true };
  streamLayouts.set(name, layout);
  return layout;
}

export interface JetStreamChatBackend {
  createChat(input: {
    chatId: string;
    userId: string;
    workspaceId: string;
    source: ChatSource;
  }): Promise<Result<Chat, string>>;
  getChat(chatId: string, workspaceId: string): Promise<Result<Chat | null, string>>;
  appendMessage(
    chatId: string,
    message: AtlasUIMessage,
    workspaceId: string,
  ): Promise<Result<void, string>>;
  listChats(opts?: ListChatsOptions): Promise<Result<ListChatsResult, string>>;
  listChatsByWorkspace(
    workspaceId: string,
    opts?: ListChatsOptions,
  ): Promise<Result<ListChatsResult, string>>;
  updateChatTitle(
    chatId: string,
    title: string,
    workspaceId: string,
  ): Promise<Result<Chat, string>>;
  deleteChat(chatId: string, workspaceId: string): Promise<Result<void, string>>;
  setSystemPromptContext(
    chatId: string,
    context: { systemMessages: string[] },
    workspaceId: string,
  ): Promise<Result<void, string>>;
  addContentFilteredMessageIds(
    chatId: string,
    messageIds: string[],
    workspaceId: string,
  ): Promise<Result<void, string>>;
}

export async function ensureChatsKVBucket(nc: NatsConnection): Promise<KV> {
  const js = nc.jetstream();
  // views.kv is idempotent — gets or creates.
  return await js.views.kv(KV_BUCKET, { history: 5, storage: StorageType.File });
}

export function createJetStreamChatBackend(
  nc: NatsConnection,
  limits: ChatStreamLimits = {},
): JetStreamChatBackend {
  let cachedKV: KV | null = null;

  async function kv(): Promise<KV> {
    if (cachedKV) return cachedKV;
    cachedKV = await ensureChatsKVBucket(nc);
    return cachedKV;
  }

  function js(): JetStreamClient {
    return nc.jetstream();
  }

  const newNamingEnabled = limits.newNamingEnabled ?? false;

  function parseMetaSafe(raw: Uint8Array): ChatMetadata | null {
    try {
      return ChatMetadataSchema.parse(JSON.parse(dec.decode(raw)));
    } catch (err) {
      logger.warn("chat_metadata_parse_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Locate a chat by checking the new-naming KV key first, then the
   * legacy `<ws>/<chat>` key. Returns the parsed metadata + the scheme
   * the chat lives under so subsequent operations (writes, stream
   * lookups, uploads) target the correct namespace. Mismatched
   * workspaceId in the metadata is treated as "not found" — that's
   * the defense-in-depth ACL from friday-studio-be9.
   */
  async function readChatLocation(
    workspaceId: string,
    chatId: string,
  ): Promise<{ meta: ChatMetadata; scheme: ChatScheme } | null> {
    const k = await kv();
    // Try new naming first. Always, regardless of the flag — a chat
    // created under the new scheme has to be readable even if the
    // flag was later turned off.
    const newEntry = await k.get(kvKeyNew(chatId));
    if (newEntry && newEntry.operation === "PUT") {
      const meta = parseMetaSafe(newEntry.value);
      if (meta && meta.workspaceId === workspaceId) {
        return { meta, scheme: "new" };
      }
    }
    // Fall back to legacy `<ws>/<chat>`.
    const legacyEntry = await k.get(kvKey(workspaceId, chatId));
    if (!legacyEntry || legacyEntry.operation !== "PUT") return null;
    const meta = parseMetaSafe(legacyEntry.value);
    if (!meta) return null;
    if (meta.workspaceId !== workspaceId) {
      logger.warn("chat_metadata_workspace_mismatch", {
        chatId,
        requestedWorkspaceId: workspaceId,
        actualWorkspaceId: meta.workspaceId,
      });
      return null;
    }
    return { meta, scheme: "legacy" };
  }

  async function readMetadata(workspaceId: string, chatId: string): Promise<ChatMetadata | null> {
    return (await readChatLocation(workspaceId, chatId))?.meta ?? null;
  }

  async function writeMetadata(meta: ChatMetadata, scheme: ChatScheme): Promise<void> {
    const k = await kv();
    await k.put(kvKeyFor(scheme, meta.workspaceId, meta.id), enc.encode(JSON.stringify(meta)));
  }

  async function updateMetadata(
    workspaceId: string,
    chatId: string,
    mut: (m: ChatMetadata) => ChatMetadata,
  ): Promise<ChatMetadata> {
    const k = await kv();
    // Find the chat first so we know which key to CAS against. The
    // scheme is stable for the chat's lifetime — no need to re-detect
    // inside the retry loop.
    const located = await readChatLocation(workspaceId, chatId);
    if (!located) {
      throw new Error(`Chat metadata not found: ${chatId}`);
    }
    const key = kvKeyFor(located.scheme, workspaceId, chatId);
    for (let attempt = 0; attempt < 8; attempt++) {
      const entry = await k.get(key);
      if (!entry) {
        throw new Error(`Chat metadata not found: ${key}`);
      }
      const current = ChatMetadataSchema.parse(JSON.parse(dec.decode(entry.value)));
      // Same defense-in-depth ACL as readMetadata — see beads friday-studio-1z9.
      if (current.workspaceId !== workspaceId) {
        throw new Error(
          `Chat metadata workspaceId mismatch: requested ${workspaceId}, actual ${current.workspaceId}`,
        );
      }
      const next = mut(current);
      try {
        await k.update(key, enc.encode(JSON.stringify(next)), entry.revision);
        return next;
      } catch (err) {
        if (isCASConflict(err) && attempt < 7) continue;
        throw err;
      }
    }
    throw new Error(`Chat metadata update failed after 8 CAS retries: ${key}`);
  }

  /**
   * Find the JetStream stream backing a chat — try the new-naming
   * `CHAT_<chatId>` first, fall back to `CHAT_<ws>_<chatId>`. Returns
   * null when neither exists. The dual-read tolerance from
   * friday-studio-m4m: callers don't need to know which scheme the
   * chat lives under.
   */
  async function locateChatStream(
    workspaceId: string,
    chatId: string,
  ): Promise<{ name: string; scheme: ChatScheme } | null> {
    const jsm = await nc.jetstreamManager();
    const candidates: Array<{ name: string; scheme: ChatScheme }> = [
      { name: streamNameNew(chatId), scheme: "new" },
      { name: streamName(workspaceId, chatId), scheme: "legacy" },
    ];
    for (const candidate of candidates) {
      try {
        await jsm.streams.info(candidate.name);
        return candidate;
      } catch (err) {
        if (!isStreamNotFound(err)) throw err;
      }
    }
    return null;
  }

  async function readMessages(workspaceId: string, chatId: string): Promise<AtlasUIMessage[]> {
    const messages: AtlasUIMessage[] = [];
    const located = await locateChatStream(workspaceId, chatId);
    if (!located) return messages;
    const sName = located.name;
    let totalMessages = 0;
    try {
      const jsm = await nc.jetstreamManager();
      const info = await jsm.streams.info(sName);
      totalMessages = Number(info.state.messages);
    } catch (err) {
      if (isStreamNotFound(err)) return messages;
      throw err;
    }
    if (totalMessages === 0) return messages;

    // Read each message by sequence number via direct-get. No consumer
    // involved, so there's no expires-window or pull-batch state to fight.
    // jsm.streams.getMessage({seq}) is a single round-trip RPC per
    // sequence — for chat-sized streams (hundreds of messages tops)
    // that's fine and predictable. Earlier consumer-fetch attempts
    // produced "iterating through states" (best-effort fetch giving
    // partial subsets) and then hangs (loop spinning when the server
    // didn't drain the expected count) — neither acceptable.
    const jsm = await nc.jetstreamManager();
    const stream = await jsm.streams.get(sName);
    let firstSeq: number;
    let lastSeq: number;
    try {
      const info = await jsm.streams.info(sName);
      firstSeq = Number(info.state.first_seq);
      lastSeq = Number(info.state.last_seq);
    } catch (err) {
      if (isStreamNotFound(err)) return messages;
      throw err;
    }
    if (lastSeq < firstSeq) return messages;

    for (let seq = firstSeq; seq <= lastSeq; seq++) {
      try {
        const m = await stream.getMessage({ seq });
        // getMessage may return null/undefined for purged messages.
        // The nats.js typing varies across versions — coerce defensively.
        const data = (m as { data?: Uint8Array }).data;
        if (!data) continue;
        const env = JSON.parse(dec.decode(data)) as { message: AtlasUIMessage; ts: string };
        messages.push(env.message);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // "no message found" or "deleted" — message was purged; skip.
        if (/no message|deleted|not found/i.test(msg)) continue;
        logger.warn("Failed to read chat message", { workspaceId, chatId, seq, error: msg });
      }
    }
    return messages;
  }

  async function createChat(input: {
    chatId: string;
    userId: string;
    workspaceId: string;
    source: ChatSource;
  }): Promise<Result<Chat, string>> {
    try {
      const existing = await readChatLocation(input.workspaceId, input.chatId);
      if (existing) {
        const messages = await readMessages(input.workspaceId, input.chatId);
        logger.debug("Chat already exists, returning existing", {
          chatId: input.chatId,
          messageCount: messages.length,
        });
        return success({ ...existing.meta, messages: sortMessagesByStartTime(messages) });
      }

      // Under the new naming scheme, chatId is a global identifier —
      // no workspaceId prefix on the KV key. Detect cross-workspace
      // collisions before writing so we don't overwrite another
      // workspace's chat. See friday-studio-1z9.
      if (newNamingEnabled) {
        const k = await kv();
        const collision = await k.get(kvKeyNew(input.chatId));
        if (collision && collision.operation === "PUT") {
          const collidingMeta = parseMetaSafe(collision.value);
          if (collidingMeta && collidingMeta.workspaceId !== input.workspaceId) {
            return fail(
              `Chat ID '${input.chatId}' already exists in workspace '${collidingMeta.workspaceId}'`,
            );
          }
        }
      }

      const now = new Date().toISOString();
      const meta: ChatMetadata = {
        id: input.chatId,
        userId: input.userId,
        workspaceId: input.workspaceId,
        source: input.source,
        color: randomColor(),
        createdAt: now,
        updatedAt: now,
      };
      const scheme: ChatScheme = newNamingEnabled ? "new" : "legacy";
      await writeMetadata(meta, scheme);
      logger.debug("Created new chat", { chatId: input.chatId, scheme });
      return success({ ...meta, messages: [] });
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  async function getChat(
    chatId: string,
    workspaceId: string,
  ): Promise<Result<Chat | null, string>> {
    try {
      const meta = await readMetadata(workspaceId, chatId);
      if (!meta) return success(null);
      const messages = await readMessages(workspaceId, chatId);
      return success({ ...meta, messages: sortMessagesByStartTime(messages) });
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  async function appendMessage(
    chatId: string,
    message: AtlasUIMessage,
    workspaceId: string,
  ): Promise<Result<void, string>> {
    try {
      await enqueue(`${workspaceId}/${chatId}`, async () => {
        // Persist the validator's repaired output, not the raw input. The
        // AI SDK emits `tool-*` parts with `state: "output-error"` and
        // `input: undefined / rawInput: …` for unbound-tool errors;
        // `validateAtlasUIMessages` backfills `input` so the persisted
        // bytes round-trip through the SDK schema. Writing the raw
        // message would leave the broken shape in JetStream and force
        // the read-side repair to carry the load forever.
        const [validated] = await validateAtlasUIMessages([message]);
        const repaired = validated ?? message;
        const jsm = await nc.jetstreamManager();
        // Detect the chat's scheme so the stream + subject use the
        // same names the chat was created under. Fresh chats (no
        // metadata yet) get the current default scheme.
        const located = await readChatLocation(workspaceId, chatId);
        const scheme: ChatScheme = located?.scheme ?? (newNamingEnabled ? "new" : "legacy");
        const layout = await ensureChatStream(jsm, workspaceId, chatId, limits, scheme);

        const c = js();
        const envelope = { message: repaired, ts: new Date().toISOString() };
        const h = natsHeaders();
        h.set("Friday-Schema-Version", SCHEMA_VERSION);
        h.set("Friday-Message-Id", message.id);
        // New streams use a per-message subject + max_msgs_per_subject:1 so
        // each `appendMessage` for the same `message.id` snapshot-replaces
        // the prior copy. We deliberately do NOT set `msgID` here — that
        // would trigger the stream's 24h dedup window and silently drop
        // resnapshots. The subject-rollup semantics are sufficient: if a
        // network retry causes two publishes of the identical envelope,
        // the broker stores one and auto-purges the other.
        //
        // Old streams keep their flat subject + msgID dedup so existing
        // chats persist exactly as before.
        const publishSubject = layout.perMessage
          ? messageSubjectFor(scheme, workspaceId, chatId, message.id)
          : flatSubjectFor(scheme, workspaceId, chatId);
        await c.publish(publishSubject, enc.encode(JSON.stringify(envelope)), {
          headers: h,
          ...(layout.perMessage ? {} : { msgID: message.id }),
        });

        const ts = envelope.ts;
        try {
          await updateMetadata(workspaceId, chatId, (m) => ({ ...m, updatedAt: ts }));
        } catch (err) {
          // Metadata-not-found means the chat was deleted between publish and CAS;
          // surface it but the message is already in the stream.
          if (String(err).includes("not found")) {
            logger.warn("Chat metadata missing after publish — chat deleted concurrently?", {
              workspaceId,
              chatId,
            });
          } else {
            throw err;
          }
        }
      });
      return success(undefined);
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  async function listAllMetadata(workspaceId?: string): Promise<ChatMetadata[]> {
    const k = await kv();
    // Legacy keys have the shape `<workspaceId>/<chatId>` (contain a
    // slash). New-naming keys are bare `<chatId>` (no slash). When a
    // workspace filter is requested we can still skip foreign legacy
    // keys cheaply via the prefix check; new-naming keys always go
    // through the metadata-field check below. See friday-studio-m4m.
    const prefix = workspaceId ? kvPrefix(workspaceId) : null;
    const it = await k.keys();
    const allKeys: string[] = [];
    for await (const key of it) {
      if (prefix && key.includes("/") && !key.startsWith(prefix)) continue;
      allKeys.push(key);
    }
    const metas: ChatMetadata[] = [];
    const seenIds = new Set<string>();
    for (const key of allKeys) {
      try {
        const entry = await k.get(key);
        if (!entry || entry.operation !== "PUT") continue;
        const meta = ChatMetadataSchema.parse(JSON.parse(dec.decode(entry.value)));
        // Metadata-field ACL — authoritative under both schemes.
        if (workspaceId && meta.workspaceId !== workspaceId) {
          logger.warn("chat_metadata_workspace_mismatch_in_list", {
            key,
            requestedWorkspaceId: workspaceId,
            actualWorkspaceId: meta.workspaceId,
          });
          continue;
        }
        // A chat could in theory be present under both schemes during
        // backfill — dedupe by (workspaceId, chatId) so each chat
        // only surfaces once. Prefer whichever entry we hit first
        // (KV iteration order is stable for a given snapshot).
        const dedupKey = `${meta.workspaceId}/${meta.id}`;
        if (seenIds.has(dedupKey)) continue;
        seenIds.add(dedupKey);
        metas.push(meta);
      } catch (err) {
        logger.warn("Skipping malformed chat metadata", { key, error: stringifyError(err) });
      }
    }
    return metas;
  }

  async function listChats(opts?: ListChatsOptions): Promise<Result<ListChatsResult, string>> {
    const limit = opts?.limit ?? 25;
    const cursor = opts?.cursor;

    try {
      const all = await listAllMetadata();
      // Mirror legacy listChats: only "global" (non-workspaceId-prefixed) chats.
      // The KV uses "<workspaceId>/<chatId>" so the legacy "global" set
      // corresponds to the system workspaces.
      const GLOBAL = new Set(["friday-conversation", "system"]);
      const filtered = all.filter((m) => GLOBAL.has(m.workspaceId));
      filtered.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

      const afterCursor = cursor
        ? filtered.filter((m) => Date.parse(m.updatedAt) < cursor)
        : filtered;
      const page = afterCursor.slice(0, limit);
      const hasMore = afterCursor.length > limit;
      const last = page.at(-1);
      const nextCursor = hasMore && last ? Date.parse(last.updatedAt) : null;

      return success({ chats: page, nextCursor, hasMore });
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  async function listChatsByWorkspace(
    workspaceId: string,
    opts?: ListChatsOptions,
  ): Promise<Result<ListChatsResult, string>> {
    const limit = opts?.limit ?? 25;
    const cursor = opts?.cursor;

    try {
      const metas = await listAllMetadata(workspaceId);
      metas.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      const afterCursor = cursor ? metas.filter((m) => Date.parse(m.updatedAt) < cursor) : metas;
      const page = afterCursor.slice(0, limit);
      const hasMore = afterCursor.length > limit;
      const last = page.at(-1);
      const nextCursor = hasMore && last ? Date.parse(last.updatedAt) : null;

      return success({ chats: page, nextCursor, hasMore });
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  async function updateChatTitle(
    chatId: string,
    title: string,
    workspaceId: string,
  ): Promise<Result<Chat, string>> {
    try {
      const updated = await updateMetadata(workspaceId, chatId, (m) => ({
        ...m,
        title,
        updatedAt: new Date().toISOString(),
      }));
      const messages = await readMessages(workspaceId, chatId);
      return success({ ...updated, messages: sortMessagesByStartTime(messages) });
    } catch (error) {
      const msg = stringifyError(error);
      if (msg.includes("not found")) return fail("Chat not found");
      return fail(msg);
    }
  }

  async function deleteChat(chatId: string, workspaceId: string): Promise<Result<void, string>> {
    try {
      const k = await kv();
      const jsm = await nc.jetstreamManager();
      // Locate the chat first — DO NOT blind-delete both schemes,
      // because a legacy chat in ws-a and a new-scheme chat in ws-b
      // can both have the same chatId. Blind deletion would smash
      // the unrelated chat. The locator already enforces the
      // workspaceId ACL.
      const located = await readChatLocation(workspaceId, chatId);
      if (!located) {
        logger.debug("Chat already gone", { chatId, workspaceId });
        return success(undefined);
      }
      const name = streamNameFor(located.scheme, workspaceId, chatId);
      try {
        await jsm.streams.delete(name);
      } catch (err) {
        if (!isStreamNotFound(err)) throw err;
      }
      // Drop the layout cache entry — chat IDs aren't reused in practice
      // but a stale entry would mis-route a freshly-created stream's
      // appendMessage to the legacy subject.
      streamLayouts.delete(name);
      await k.delete(kvKeyFor(located.scheme, workspaceId, chatId));
      logger.debug("Deleted chat", { chatId, workspaceId, scheme: located.scheme });
      return success(undefined);
    } catch (error) {
      return fail(stringifyError(error));
    }
  }

  async function setSystemPromptContext(
    chatId: string,
    context: { systemMessages: string[] },
    workspaceId: string,
  ): Promise<Result<void, string>> {
    try {
      await updateMetadata(workspaceId, chatId, (m) => ({
        ...m,
        systemPromptContext: { timestamp: new Date().toISOString(), ...context },
        updatedAt: new Date().toISOString(),
      }));
      return success(undefined);
    } catch (error) {
      const msg = stringifyError(error);
      if (msg.includes("not found")) return fail("Chat not found");
      return fail(msg);
    }
  }

  async function addContentFilteredMessageIds(
    chatId: string,
    messageIds: string[],
    workspaceId: string,
  ): Promise<Result<void, string>> {
    try {
      await updateMetadata(workspaceId, chatId, (m) => {
        const seen = new Set(m.contentFilteredMessageIds ?? []);
        for (const id of messageIds) seen.add(id);
        return { ...m, contentFilteredMessageIds: [...seen], updatedAt: new Date().toISOString() };
      });
      return success(undefined);
    } catch (error) {
      const msg = stringifyError(error);
      if (msg.includes("not found")) return fail("Chat not found");
      return fail(msg);
    }
  }

  return {
    createChat,
    getChat,
    appendMessage,
    listChats,
    listChatsByWorkspace,
    updateChatTitle,
    deleteChat,
    setSystemPromptContext,
    addContentFilteredMessageIds,
  };
}
