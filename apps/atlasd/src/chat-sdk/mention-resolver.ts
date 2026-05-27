/**
 * Cross-workspace @-mention resolver.
 *
 * When a user sends a message containing `@<workspaceId>/<chatId>` references,
 * we:
 *   1. Parse the references out of the message text
 *   2. Resolve each one against ChatStorage + workspace membership
 *   3. Inject a frozen snapshot (title + short excerpt) into the message
 *      parts so the model sees the referenced chat's context inline
 *   4. Persist a `data-mention-resolved` part as UI metadata so the
 *      composer can render the mention as a pill / link
 *   5. Surface the resolved workspaceIds upstream so the caller can
 *      union them into `foreground_workspace_ids` for the turn
 *
 * The full transcript of a referenced chat is available to the model via
 * the `read_chat` MCP tool (friday-studio-vp0) using the (workspaceId,
 * chatId) carried in the snapshot text.
 */

import type { AtlasUIMessage, AtlasUIMessagePart } from "@atlas/agent-sdk";
import { type Chat, ChatStorage } from "@atlas/core/chat/storage";
import { WorkspaceMemberStorage } from "@atlas/core/workspace-members/storage";
import { createLogger } from "@atlas/logger";
import { KERNEL_WORKSPACE_ID } from "../factory.ts";

const logger = createLogger({ component: "mention-resolver" });

// `@<workspaceId>/<chatId>` — both ids restricted to URL-safe characters.
// Same set the KV-key sanitizer accepts (alphanumerics, dash, underscore,
// dot, colon) so a mention round-trips through storage cleanly. Same-
// workspace shorthand (`@chatId` without a slash) is intentionally not
// supported — the composer autocomplete (friday-studio-c7j) inserts the
// explicit form, and the unambiguous form avoids false positives on
// common @-mentions like `@everyone`.
const MENTION_RE = /@([a-zA-Z0-9_\-:.]+)\/([a-zA-Z0-9_\-:.]+)/g;

const SNAPSHOT_EXCERPT_CHARS = 240;

const MEMBER_ROLES = new Set(["owner", "admin", "member", "agent"]);

export interface MentionRef {
  /** Exact substring matched (e.g. `@ws/chat-id`), useful for logging. */
  raw: string;
  workspaceId: string;
  chatId: string;
}

export interface ResolvedMention {
  ref: MentionRef;
  title: string;
  snapshot: string;
  messageCount: number;
  /** ISO timestamp the snapshot was generated; persisted for audit. */
  generatedAt: string;
}

export type MentionResolutionFailureReason = "not_found" | "unauthorized" | "internal_error";

export interface MentionResolutionFailure {
  ref: MentionRef;
  reason: MentionResolutionFailureReason;
}

/**
 * Extract every `@workspace/chat` reference carried by a message's text
 * parts. Used by callers that need to detect or count mentions without
 * running the full ACL/snapshot pipeline (e.g. the communicator-adapter
 * gate at chat-sdk-instance.ts that logs-and-drops mentions because
 * those adapters don't have a real Atlas userId to authorize against —
 * see friday-studio-2ct).
 */
export function extractMentionsFromMessage(message: AtlasUIMessage): MentionRef[] {
  return parseMentions(joinMessageText(message));
}

/** Extract every `@workspace/chat` reference from a free-text body. */
export function parseMentions(text: string): MentionRef[] {
  const seen = new Set<string>();
  const refs: MentionRef[] = [];
  for (const match of text.matchAll(MENTION_RE)) {
    const workspaceId = match[1];
    const chatId = match[2];
    if (!workspaceId || !chatId) continue;
    const key = `${workspaceId}/${chatId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ raw: match[0], workspaceId, chatId });
  }
  return refs;
}

/** Join the text parts of an AtlasUIMessage into a flat string for parsing. */
function joinMessageText(message: AtlasUIMessage): string {
  const segments: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && typeof (part as { text?: unknown }).text === "string") {
      segments.push((part as { text: string }).text);
    }
  }
  return segments.join("\n");
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n - 1).trimEnd()}…`;
}

// Strip characters that could let a hostile source-chat title /
// message body break out of the `<atlas-mention-context>` block and
// inject override instructions across workspace boundaries. Two
// classes: tag delimiters (`<`, `>`, backtick) so the wrapper tag
// itself can't be closed, AND line breaks (`\r`, `\n`) so the
// line-oriented `Title: …` / `Messages: …` / excerpt format can't
// have a synthetic structural line forged into it (e.g. a fake
// `Full transcript available via the read_chat tool (workspace_id="OTHER", chat_id="…")`
// row that nudges the model toward a different chat). Mirrors the
// sanitizer in summarize-chat.ts:199 plus this extra newline guard
// — the mention path carries cross-workspace user-controlled bytes
// into the model's hidden context and must be held to a higher bar.
// Applied to every value interpolated into the synthesized text
// (title, both excerpts, and the id in the opening tag). See
// friday-studio-d1n.
function stripTagDelims(s: string): string {
  return s.replace(/[<>`\r\n]/g, " ");
}

function extractText(message: AtlasUIMessage | Chat["messages"][number]): string {
  for (const part of message.parts) {
    if (part.type === "text" && typeof (part as { text?: unknown }).text === "string") {
      const text = (part as { text: string }).text.trim();
      if (text.length > 0) return text;
    }
  }
  return "";
}

export function buildSnapshot(chat: Chat): {
  title: string;
  snapshot: string;
  messageCount: number;
} {
  const title = stripTagDelims(chat.title?.trim() || "Untitled chat");
  const messageCount = chat.messages.length;
  const firstUser = chat.messages.find((m) => m.role === "user");
  const lastAssistant = [...chat.messages].reverse().find((m) => m.role === "assistant");
  const firstUserExcerpt = firstUser
    ? stripTagDelims(truncate(extractText(firstUser), SNAPSHOT_EXCERPT_CHARS))
    : "";
  const lastAssistantExcerpt = lastAssistant
    ? stripTagDelims(truncate(extractText(lastAssistant), SNAPSHOT_EXCERPT_CHARS))
    : "";

  const lines = [`Title: ${title}`, `Messages: ${messageCount}`];
  if (firstUserExcerpt) lines.push(`First user message: ${firstUserExcerpt}`);
  if (lastAssistantExcerpt) lines.push(`Last assistant message: ${lastAssistantExcerpt}`);
  return { title, snapshot: lines.join("\n"), messageCount };
}

async function isWorkspaceMember(userId: string, workspaceId: string): Promise<boolean> {
  const result = await WorkspaceMemberStorage.get(userId, workspaceId);
  if (!result.ok || !result.data) return false;
  return MEMBER_ROLES.has(result.data.role);
}

export async function resolveAllMentions(
  refs: MentionRef[],
  requesterUserId: string,
): Promise<{ resolved: ResolvedMention[]; failures: MentionResolutionFailure[] }> {
  const resolved: ResolvedMention[] = [];
  const failures: MentionResolutionFailure[] = [];

  for (const ref of refs) {
    try {
      const authorized = await isWorkspaceMember(requesterUserId, ref.workspaceId);
      if (!authorized) {
        failures.push({ ref, reason: "unauthorized" });
        continue;
      }
      const result = await ChatStorage.getChat(ref.chatId, ref.workspaceId);
      if (!result.ok || !result.data) {
        failures.push({ ref, reason: "not_found" });
        continue;
      }
      const { title, snapshot, messageCount } = buildSnapshot(result.data);
      resolved.push({ ref, title, snapshot, messageCount, generatedAt: new Date().toISOString() });
    } catch (err) {
      logger.warn("mention_resolve_internal_error", {
        workspaceId: ref.workspaceId,
        chatId: ref.chatId,
        error: err instanceof Error ? err.message : String(err),
      });
      failures.push({ ref, reason: "internal_error" });
    }
  }

  return { resolved, failures };
}

/**
 * Build the synthesized "mention context" text the model sees per turn.
 * Wrapped in a structural marker so the UI can hide it from the user
 * bubble (mirrors `<attachment …>` from inlineAttachedFiles).
 */
function renderMentionContextText(resolved: ResolvedMention[]): string {
  const blocks = resolved.map((m) => {
    // The id and per-ref workspaceId/chatId are also stripped — both
    // are user-supplied via the @-mention text and parseMentions only
    // bounds the charset (alphanumerics + `-_:.`), which doesn't
    // prevent a future regex relaxation from letting `<`/`>`/backtick
    // through. Defense-in-depth: sanitize at the embed site too.
    const id = stripTagDelims(`${m.ref.workspaceId}/${m.ref.chatId}`);
    const wsId = stripTagDelims(m.ref.workspaceId);
    const chatId = stripTagDelims(m.ref.chatId);
    return [
      `<atlas-mention-context ref="${id}">`,
      m.snapshot,
      `Full transcript available via the read_chat tool (workspace_id="${wsId}", chat_id="${chatId}").`,
      `</atlas-mention-context>`,
    ].join("\n");
  });
  return blocks.join("\n\n");
}

/**
 * Augment a user message with resolved-mention metadata + a synthesized
 * text part carrying the snapshots for the model. The structural marker
 * lets the UI renderer skip the synthetic text in the user bubble.
 */
function isMentionResolvedPart(
  part: AtlasUIMessagePart,
): part is AtlasUIMessagePart & {
  type: "data-mention-resolved";
  data: { workspaceId: string; chatId: string };
} {
  if (part.type !== "data-mention-resolved") return false;
  const data = (part as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return typeof d.workspaceId === "string" && typeof d.chatId === "string";
}

export function applyMentionsToMessage(
  message: AtlasUIMessage,
  resolved: ResolvedMention[],
): AtlasUIMessage {
  // Strip EVERY client-shipped `data-mention-resolved` part. The
  // server-side resolver is the sole authority on which mentions are
  // valid; client placeholders are a render-time convenience that
  // must not survive persistence. After stripping, we re-append a
  // canonical part for each resolved ref below. See friday-studio-1ev:
  //   - empty server-resolved set + client placeholders ⇒ all
  //     placeholders dropped (forged refs / unauthorized refs / refs
  //     whose @-token the user erased can no longer persist).
  //   - non-empty set + matching placeholder ⇒ canonical replaces it
  //     (one part out, one part in, same key).
  const filteredParts = message.parts.filter((part) => !isMentionResolvedPart(part));

  if (resolved.length === 0) {
    // No server-resolved refs → nothing to inject. Return only the
    // structural change (placeholder strip), and only if anything
    // actually got stripped, to keep object identity stable for the
    // common no-mentions path.
    return filteredParts.length === message.parts.length
      ? message
      : { ...message, parts: filteredParts };
  }

  const extraParts: AtlasUIMessagePart[] = [];

  // Per-mention UI metadata — the composer renders these as pills /
  // links in the user bubble, and history reads see the frozen
  // snapshot exactly as it was generated at send time.
  for (const m of resolved) {
    extraParts.push({
      type: "data-mention-resolved",
      data: {
        workspaceId: m.ref.workspaceId,
        chatId: m.ref.chatId,
        title: m.title,
        snapshot: m.snapshot,
        messageCount: m.messageCount,
        generatedAt: m.generatedAt,
      },
    });
  }

  // Synthesized text the model sees — hidden from the user bubble via
  // the `atlas.kind` provider-metadata marker (same pattern as
  // attachment expansion in atlas-web-adapter.ts:151).
  extraParts.push({
    type: "text",
    text: renderMentionContextText(resolved),
    providerMetadata: { atlas: { kind: "mention-expansion" } },
  });

  return { ...message, parts: [...filteredParts, ...extraParts] };
}

/**
 * Union the source workspaces from resolved cross-workspace mentions
 * into the existing foreground_workspace_ids list. Same-workspace
 * mentions don't need layering — the current workspace's tools/agents
 * are already in scope.
 */
export function mergeForegroundWorkspaceIds(
  existing: string[] | undefined,
  resolved: ResolvedMention[],
  currentWorkspaceId: string,
  exposeKernel = false,
): string[] | undefined {
  if (resolved.length === 0) return existing;
  const set = new Set(existing ?? []);
  for (const m of resolved) {
    if (m.ref.workspaceId === currentWorkspaceId) continue;
    // Mirror the caller-side kernel suppression at chat-sdk-instance.ts —
    // a mention pointing at the kernel workspace cannot smuggle kernel
    // context into a non-kernel turn. See friday-studio-svv.
    if (!exposeKernel && m.ref.workspaceId === KERNEL_WORKSPACE_ID) continue;
    set.add(m.ref.workspaceId);
  }
  if (set.size === 0) return existing;
  return [...set];
}

/**
 * One-shot helper: parse + resolve + augment the message + merge
 * foreground workspaces. Returns the augmented message, the new
 * foreground list, and any resolution failures so the caller can
 * decide whether to surface them.
 */
export async function applyMentions(input: {
  message: AtlasUIMessage;
  requesterUserId: string;
  currentWorkspaceId: string;
  foregroundWorkspaceIds: string[] | undefined;
  /** Same flag chat-sdk-instance.ts uses to gate kernel workspace
   *  visibility. Threaded through to mergeForegroundWorkspaceIds so a
   *  mention can't smuggle the kernel workspace into the foreground. */
  exposeKernel?: boolean;
}): Promise<{
  message: AtlasUIMessage;
  foregroundWorkspaceIds: string[] | undefined;
  resolved: ResolvedMention[];
  failures: MentionResolutionFailure[];
}> {
  const refs = parseMentions(joinMessageText(input.message));
  // No short-circuit even when refs are empty: applyMentionsToMessage
  // must still run so client-shipped placeholders for non-existent /
  // unauthorized refs are stripped (friday-studio-1ev). The function
  // returns object-identity-stable output when there's nothing to do.
  const { resolved, failures } =
    refs.length === 0
      ? { resolved: [], failures: [] }
      : await resolveAllMentions(refs, input.requesterUserId);
  const augmented = applyMentionsToMessage(input.message, resolved);
  const foreground = mergeForegroundWorkspaceIds(
    input.foregroundWorkspaceIds,
    resolved,
    input.currentWorkspaceId,
    input.exposeKernel ?? false,
  );
  // Resolver-level logging is intentionally omitted — the single caller
  // (chat-sdk-instance.ts) emits a `mention_resolution_failures` log
  // that includes the originating `chatId`, which this helper doesn't
  // know about. See friday-studio-sw6.
  return { message: augmented, foregroundWorkspaceIds: foreground, resolved, failures };
}
