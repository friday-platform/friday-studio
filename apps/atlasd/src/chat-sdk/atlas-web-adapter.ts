/**
 * Chat SDK Adapter for the Atlas web UI. Inbound messages dispatch through
 * `chat.processMessage()`; outbound delivery is via StreamRegistry SSE rather
 * than the standard post/edit path, so the web client receives the full
 * AtlasUIMessageChunk stream (tool calls, reasoning, data-*) that
 * Chat SDK's `fromFullStream` normalization would strip.
 */

import { randomUUID } from "node:crypto";
import {
  type AtlasUIMessage,
  normalizeToUIMessages,
  validateAtlasUIMessages,
} from "@atlas/agent-sdk";
import { isTextMimeType, stripMimeParams } from "@atlas/core/artifacts/file-upload";
import { ArtifactStorage } from "@atlas/core/artifacts/server";
import { UserStorage } from "@atlas/core/users/storage";
import { logger } from "@atlas/logger";
import type {
  Adapter,
  AdapterPostableMessage,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
  RawMessage,
  ThreadInfo,
  WebhookOptions,
} from "chat";
import { Message, parseMarkdown, stringifyMarkdown } from "chat";
import { z } from "zod";
import type { ChatTurnRegistry } from "../chat-turn-registry.ts";
import type { StreamBuffer, StreamRegistry } from "../stream-registry.ts";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

const webhookBodySchema = z.object({
  id: z.string().min(1),
  message: z.unknown(),
  datetime: z
    .object({
      timezone: z.string(),
      timestamp: z.string(),
      localDate: z.string(),
      localTime: z.string(),
      timezoneOffset: z.string(),
      latitude: z.string().optional(),
      longitude: z.string().optional(),
    })
    .optional(),
  foreground_workspace_ids: z.array(z.string()).optional(),
});

/** Join the text parts of a validated AtlasUIMessage into a flat string. */
function joinTextParts(message: AtlasUIMessage): string {
  return message.parts
    .filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

/**
 * Pull every artifact id from `data-artifact-attached` parts on a message,
 * preserving message order. Returns a parallel list of `{ id, filename }` so
 * the expander can fall back to a stable filename when the artifact's stored
 * `originalName` is empty.
 */
function collectAttachedArtifactRefs(
  message: AtlasUIMessage,
): Array<{ id: string; filename: string }> {
  const out: Array<{ id: string; filename: string }> = [];
  for (const part of message.parts) {
    if (
      typeof part !== "object" ||
      part === null ||
      !("type" in part) ||
      (part as { type: unknown }).type !== "data-artifact-attached"
    ) {
      continue;
    }
    const data = (part as { data?: unknown }).data;
    if (typeof data !== "object" || data === null) continue;
    const ids = (data as { artifactIds?: unknown }).artifactIds;
    const names = (data as { filenames?: unknown }).filenames;
    if (!Array.isArray(ids)) continue;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (typeof id !== "string") continue;
      const filename =
        Array.isArray(names) && typeof names[i] === "string" ? (names[i] as string) : id;
      out.push({ id, filename });
    }
  }
  return out;
}

/**
 * Inline text-readable user-attached artifacts into the persisted uiMessage
 * as `<attachment …>…</attachment>` text parts the agent's prompt template
 * already understands. Mutates `message.parts` in place — for each
 * `data-artifact-attached` part, the text expansion is inserted immediately
 * BEFORE it so the user bubble's text-then-artifact-list segment order in
 * `buildSegments` matches what the user typed.
 *
 * The expansion lives on the persisted history (rather than just in the
 * adapter's transient `Message.text`) because the workspace-chat agent
 * re-reads history per turn and never sees `Message.text`. UI rendering
 * skips these synthetic text parts via `buildSegments`' attachment-content
 * detector — they're agent-facing, not user-facing.
 *
 * Non-text artifacts (PDF, DOCX, audio, images) emit a bare reference tag
 * instead of inlining bytes; the agent fetches those via `read_artifact` /
 * `parse_artifact` tools rather than feeding the model garbage UTF-8.
 */
async function inlineAttachedArtifacts(message: AtlasUIMessage): Promise<void> {
  const refs = collectAttachedArtifactRefs(message);
  if (refs.length === 0) return;

  // Build expansions keyed by artifactId so the in-place splice below can
  // look them up without re-fetching.
  const byId = new Map<string, string>();
  for (const ref of refs) {
    if (byId.has(ref.id)) continue;
    const meta = await ArtifactStorage.get({ id: ref.id });
    if (!meta.ok || meta.data === null) {
      logger.warn("atlas_web_adapter_attached_artifact_missing", {
        artifactId: ref.id,
        error: meta.ok ? "not_found" : meta.error,
      });
      continue;
    }
    if (meta.data.data.type !== "file") continue;
    const mime = stripMimeParams(meta.data.data.mimeType);
    const safeName = ref.filename.replace(/"/g, "&quot;");
    const safeMime = mime.replace(/"/g, "&quot;");
    if (!isTextMimeType(mime)) {
      byId.set(
        ref.id,
        `<attachment filename="${safeName}" mediaType="${safeMime}" artifactId="${ref.id}" />`,
      );
      continue;
    }
    const contents = await ArtifactStorage.readFileContents({ id: ref.id });
    if (!contents.ok) {
      logger.warn("atlas_web_adapter_attached_artifact_read_failed", {
        artifactId: ref.id,
        error: contents.error,
      });
      continue;
    }
    byId.set(
      ref.id,
      `<attachment filename="${safeName}" mediaType="${safeMime}" artifactId="${ref.id}">\n${contents.data}\n</attachment>`,
    );
  }

  if (byId.size === 0) return;

  // Splice expansions into parts. Walk in reverse so insert indices stay
  // valid across mutations. For each `data-artifact-attached`, build one
  // text part containing all of that part's expansions joined with \n and
  // insert it directly before.
  const parts = message.parts as Array<{ type: string } & Record<string, unknown>>;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (!part || part.type !== "data-artifact-attached") continue;
    const data = part.data;
    if (typeof data !== "object" || data === null) continue;
    const ids = (data as { artifactIds?: unknown }).artifactIds;
    if (!Array.isArray(ids)) continue;
    const text = ids
      .filter((id): id is string => typeof id === "string")
      .map((id) => byId.get(id))
      .filter((s): s is string => typeof s === "string")
      .join("\n");
    if (text.length === 0) continue;
    parts.splice(i, 0, { type: "text", text } as never);
  }
}

/**
 * Minimal AtlasUIMessage for the never-called postMessage/editMessage stubs.
 * Real web delivery runs through StreamRegistry SSE; these stubs exist only
 * to satisfy Chat SDK's Adapter interface.
 */
function stubUIMessage(id: string): AtlasUIMessage {
  return { id, role: "assistant", parts: [], metadata: {} };
}

export interface WebChatPayload {
  chatId: string;
  message: string;
  userId: string;
  /**
   * Full validated AtlasUIMessage as it arrived from the web client, including
   * non-text parts (`data-artifact-attached`, etc.). Stashed here because Chat
   * SDK's `Message` type only carries flat `text` — downstream consumers
   * (workspace-chat agent, history renderer) need the original parts.
   */
  uiMessage: AtlasUIMessage;
  datetime?: {
    timezone: string;
    timestamp: string;
    localDate: string;
    localTime: string;
    timezoneOffset: string;
  };
  foregroundWorkspaceIds?: string[];
  /**
   * Server-controlled abort signal for this turn. Sourced from the daemon's
   * ChatTurnRegistry — fires when a follow-up message arrives in the same
   * chat or a DELETE /:chatId/stream is received. Threaded through the Chat
   * SDK handler to triggerFn → fsm-engine so the in-flight model call stops
   * cleanly. Distinct from `Request.signal` (which fires on HTTP disconnect)
   * because `chat.processMessage` is fire-and-forget — the originating
   * request may be long gone before the FSM is done.
   */
  abortSignal?: AbortSignal;
  /**
   * The StreamRegistry buffer this turn owns. The shared chat-sdk handler
   * reads this back instead of calling `streamRegistry.getStream(chatId)`,
   * which has a race window: by the time the handler captures it, a
   * follow-up POST may have already replaced the buffer for the same
   * chatId. Stashing the reference at dispatch makes capture deterministic.
   */
  turnBuffer?: StreamBuffer;
}

export class AtlasWebAdapter implements Adapter<string, WebChatPayload> {
  readonly name = "atlas" as const;
  // Structural marker: `ChatSdkNotifier` filters this adapter out of `list()`
  // and `post()`. We use a structural property (not a name-based allowlist) so
  // any future stub adapter just declares `outboundDeliverable = false` to
  // opt out — no central registry to keep in sync. Real outbound delivery
  // flows through StreamRegistry SSE on the inbound webhook path (see
  // `postMessage` below).
  readonly outboundDeliverable = false;
  readonly userName: string;

  private chat: ChatInstance | null = null;
  private readonly streamRegistry: StreamRegistry;
  private readonly chatTurnRegistry: ChatTurnRegistry | undefined;
  /** Stored so every registry call can scope its key to `(workspaceId,
   *  chatId)` — the route layer no longer threads workspaceId through
   *  the `Request` and chat ids alone aren't tenant-unique. */
  private readonly workspaceId: string;

  constructor(opts: {
    streamRegistry: StreamRegistry;
    chatTurnRegistry?: ChatTurnRegistry;
    workspaceId: string;
    userName?: string;
  }) {
    this.streamRegistry = opts.streamRegistry;
    this.chatTurnRegistry = opts.chatTurnRegistry;
    this.workspaceId = opts.workspaceId;
    this.userName = opts.userName ?? "Friday";
  }

  encodeThreadId(uuid: string): string {
    return uuid;
  }

  decodeThreadId(threadId: string): string {
    return threadId;
  }

  channelIdFromThreadId(threadId: string): string {
    return threadId;
  }

  isDM(_threadId: string): boolean {
    return true;
  }

  // deno-lint-ignore require-await
  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
  }

  parseMessage(raw: WebChatPayload): Message<WebChatPayload> {
    const threadId = this.encodeThreadId(raw.chatId);
    return new Message<WebChatPayload>({
      id: randomUUID(),
      threadId,
      text: raw.message,
      formatted: parseMarkdown(raw.message),
      raw,
      author: {
        userId: raw.userId,
        userName: raw.userId,
        fullName: raw.userId,
        isBot: false,
        isMe: false,
      },
      metadata: { dateSent: new Date(), edited: false },
      attachments: [],
    });
  }

  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content);
  }

  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    if (!this.chat) {
      return new Response("Adapter not initialized", { status: 500 });
    }

    const raw = await request.json();
    const parsed = webhookBodySchema.safeParse(raw);
    if (!parsed.success) {
      return new Response(JSON.stringify({ error: "Invalid request body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Validate the full AtlasUIMessage (parts + data events) at the boundary.
    // The validated message is stashed on `WebChatPayload.uiMessage` so the
    // shared handler can persist the original parts verbatim — `data-artifact-
    // attached` etc. would otherwise be stripped by `toAtlasUIMessage`.
    let uiMessage: AtlasUIMessage;
    try {
      const [validated] = await validateAtlasUIMessages(normalizeToUIMessages(parsed.data.message));
      if (!validated) {
        return new Response(JSON.stringify({ error: "Empty or invalid message" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      // Only user-role messages may be submitted through this endpoint.
      // Assistant and system messages are produced server-side by agents and
      // persisted in-process via ChatStorage. Allowing client-supplied roles
      // here would let any caller seed the chat with a forged assistant or
      // system turn (prompt injection on the next LLM turn).
      if (validated.role !== "user") {
        return new Response(JSON.stringify({ error: "Only user-role messages may be submitted" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }
      uiMessage = validated;
    } catch (err) {
      logger.warn("atlas_web_adapter_message_validation_failed", { error: err });
      return new Response(JSON.stringify({ error: "Invalid message format" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const chatId = parsed.data.id;
    // User-attached artifacts uploaded via the chat input land here as
    // `data-artifact-attached` parts. Mutate the uiMessage to insert
    // `<attachment …>…</attachment>` text parts inline so the workspace-chat
    // agent (which re-reads history per turn from ChatStorage, ignoring
    // `Message.text`) actually sees the content. The UI's `buildSegments`
    // recognizes these synthetic text parts and hides them in the bubble.
    await inlineAttachedArtifacts(uiMessage);
    const messageText = joinTextParts(uiMessage);
    const userId = request.headers.get("X-Atlas-User-Id") ?? UserStorage.getCachedLocalUserId();
    const { datetime, foreground_workspace_ids: foregroundWorkspaceIds } = parsed.data;

    // Create the buffer BEFORE dispatching so we don't lose early events.
    // Capture the buffer reference so the delayed finishStream only closes
    // THIS turn's buffer, even if a follow-up POST has already replaced it.
    const turnBuffer = this.streamRegistry.createStream(this.workspaceId, chatId);

    // The route handler called `chatTurnRegistry.replace(workspaceId, chatId)`
    // before forwarding here — read the controller it registered. Falls back
    // to undefined when the registry isn't wired (test scaffolding); the
    // handler chain treats abortSignal as optional throughout. Capture the
    // controller reference so the post-turn cleanup below only releases
    // entries this turn owns (a follow-up POST would have replaced it).
    const turnController = this.chatTurnRegistry?.get(this.workspaceId, chatId);
    const abortSignal = turnController?.signal;

    const payload: WebChatPayload = {
      chatId,
      message: messageText,
      userId,
      uiMessage,
      datetime,
      foregroundWorkspaceIds,
      abortSignal,
      turnBuffer,
    };
    const message = this.parseMessage(payload);
    this.chat.processMessage(this, chatId, message, {
      ...options,
      waitUntil: (task) => {
        // Close the stream even if the handler was skipped (e.g. dedup).
        // Drain delay: MCP notification delivery is asynchronous — late-arriving
        // StreamContentNotification chunks can be dropped if finishStream sets
        // buffer.active=false before they arrive. A short delay lets in-flight
        // notifications land before we close the stream.
        //
        // Guard with the captured buffer: if a follow-up POST with the same
        // chatId has already called createStream (replacing `turnBuffer` with
        // a fresh one), the original handler's own `finally` has closed
        // `turnBuffer` already, and blindly calling finishStream(chatId) here
        // would rip the subscribers out of the *new* turn's buffer — leaving
        // queued follow-up messages with only the session-start chunk.
        task.finally(() => {
          setTimeout(() => {
            this.streamRegistry.finishStreamIfCurrent(this.workspaceId, chatId, turnBuffer);
          }, 500);
          if (turnController) {
            this.chatTurnRegistry?.release(this.workspaceId, chatId, turnController);
          }
        });
      },
    });

    return this.createSSEResponse(chatId);
  }

  private createSSEResponse(chatId: string): Response {
    const registry = this.streamRegistry;
    const workspaceId = this.workspaceId;
    let sseController: ReadableStreamDefaultController<Uint8Array>;

    const readableStream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        sseController = controller;
        const subscribed = registry.subscribe(workspaceId, chatId, controller);
        if (!subscribed) {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      },
      cancel: () => {
        registry.unsubscribe(workspaceId, chatId, sseController);
        logger.debug("SSE client disconnected", { workspaceId, chatId });
      },
    });

    return new Response(readableStream, { headers: SSE_HEADERS });
  }

  // No-op stubs — Chat SDK's post+edit fallback calls these when stream() is
  // absent. Real web delivery happens via StreamRegistry SSE in handleWebhook.

  // deno-lint-ignore require-await
  async postMessage(
    threadId: string,
    _message: AdapterPostableMessage,
  ): Promise<RawMessage<WebChatPayload>> {
    return {
      id: threadId,
      threadId,
      raw: {
        chatId: threadId,
        message: "",
        userId: this.userName,
        uiMessage: stubUIMessage(threadId),
      },
    };
  }

  editMessage(
    _threadId: string,
    _messageId: string,
    _message: AdapterPostableMessage,
  ): Promise<RawMessage<WebChatPayload>> {
    return Promise.resolve({
      id: "",
      threadId: _threadId,
      raw: { chatId: "", message: "", userId: "", uiMessage: stubUIMessage("") },
    });
  }

  deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    return Promise.resolve();
  }

  addReaction(_threadId: string, _messageId: string, _emoji: EmojiValue | string): Promise<void> {
    return Promise.resolve();
  }

  removeReaction(
    _threadId: string,
    _messageId: string,
    _emoji: EmojiValue | string,
  ): Promise<void> {
    return Promise.resolve();
  }

  startTyping(_threadId: string, _status?: string): Promise<void> {
    return Promise.resolve();
  }

  fetchMessages(_threadId: string, _options?: FetchOptions): Promise<FetchResult<WebChatPayload>> {
    return Promise.resolve({ messages: [], nextCursor: undefined });
  }

  fetchThread(threadId: string): Promise<ThreadInfo> {
    return Promise.resolve({ id: threadId, channelId: threadId, metadata: {} });
  }
}
