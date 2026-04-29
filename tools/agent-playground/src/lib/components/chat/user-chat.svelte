<script lang="ts">
  import { untrack } from "svelte";
  import { Chat as ChatImpl } from "@ai-sdk/svelte";
  import type { AtlasUIMessage } from "@atlas/agent-sdk";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { workspaceQueries } from "$lib/queries";
  import {
    buildBacklogEntry,
    expandScheduleInput,
    parseScheduleCommand,
    submitBacklogEntry,
  } from "$lib/scheduling/fast-task-scheduler";
  import { DefaultChatTransport } from "ai";
  import ChatInput, { type ImageAttachment } from "./chat-input.svelte";
  import ChatInspector from "./chat-inspector.svelte";
  import ChatListPanel from "./chat-list-panel.svelte";
  import ChatMessageList from "./chat-message-list.svelte";
  import { nextQueueStep } from "./chat-queue.ts";
  import { nextSpeechChunk } from "./chat-tts.ts";
  import { extractToolCalls } from "./extract-tool-calls.ts";
  import { extractErrorText, hasErrorPart, hasRenderableContent } from "./message-error.ts";
  import type { ChatMessage, ImageDisplay, ScheduleProposal, ToolCallDisplay } from "./types";
  import { GetChatResponseSchema } from "./types";
  import {
    accumulateValidationAttempts,
    type ValidationAttemptDisplay,
  } from "./validation-accumulator.ts";
  import type { SessionStreamEvent } from "@atlas/core/session/session-events";
  import { sessionEventStream } from "$lib/utils/session-event-stream";

  const wsId = $derived(page.params.workspaceId ?? "user");
  const queryClient = useQueryClient();
  const configQuery = createQuery(() => workspaceQueries.config(wsId));
  const workspaceName = $derived(
    ((configQuery.data?.config?.workspace as Record<string, unknown> | undefined)?.name as
      | string
      | undefined) ?? wsId,
  );

  interface Props {
    chatId: string;
  }
  const { chatId }: Props = $props();

  let inspectorOpen = $state(false);

  function handleGlobalKeydown(e: KeyboardEvent) {
    // Cmd+Shift+D (Debug) — Cmd+Shift+I is intercepted by Chrome DevTools
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "d") {
      e.preventDefault();
      inspectorOpen = !inspectorOpen;
    }
  }
  let systemPromptContext: { timestamp: string; systemMessages: string[] } | null = $state(null);

  let chatDragOver = $state(false);
  let pendingImages: ImageAttachment[] = $state([]);

  async function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function handleChatDrop(e: DragEvent) {
    e.preventDefault();
    chatDragOver = false;
    if (e.dataTransfer?.files) {
      void addDroppedFiles(e.dataTransfer.files);
    }
  }

  function handleChatDragOver(e: DragEvent) {
    e.preventDefault();
    chatDragOver = true;
  }

  function handleChatDragLeave(e: DragEvent) {
    // Only dismiss if leaving the container (not entering a child)
    if (
      e.currentTarget instanceof HTMLElement &&
      !e.currentTarget.contains(e.relatedTarget as Node)
    ) {
      chatDragOver = false;
    }
  }

  async function addDroppedFiles(files: FileList) {
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      const dataUrl = await fileToDataUrl(file);
      pendingImages = [...pendingImages, { id: crypto.randomUUID(), file, dataUrl }];
    }
  }

  /**
   * Playground chat wired to the `user` workspace via `@ai-sdk/svelte`'s
   * {@link ChatImpl} and {@link DefaultChatTransport}. This component is the
   * thin playground equivalent of `apps/web-client`'s chat-provider, without
   * the production concerns (X-Turn-Started-At timer, GA4 analytics,
   * OAuth return flow, query-client sidebar invalidation, resume-stream
   * abort wiring). It reuses the same backend contract:
   *
   *   - `POST /api/workspaces/<wsId>/chat`          — first and follow-up turns
   *   - `GET  /api/workspaces/<wsId>/chat/:chatId`  — rehydrate on mount
   *
   * The request body shape is controlled via `prepareSendMessagesRequest`
   * and matches what `AtlasWebAdapter.handleWebhook` expects:
   *   { id, message, datetime? }
   *
   * The Chat instance owns message state, streaming, and error handling.
   * The component only adds a parallel `localEvents` channel for the
   * `/schedule` slash-command flow (task briefs expanded via smallLLM and
   * submitted to the FAST autopilot backlog) — that UX is playground-only
   * and never round-trips through the chat agent.
   *
   */
  const CHAT_API = $derived(`/api/daemon/api/workspaces/${encodeURIComponent(wsId)}/chat`);
  let initialMessages: AtlasUIMessage[] = $state([]);
  let rehydrationDone = $state(false);
  let rehydrating = $state(false);
  /**
   * Set when we rehydrate from localStorage — signals the "try to resume an
   * in-flight stream" effect that this chatId may have a live turn on the
   * server (user navigated away mid-response). The effect calls
   * `chat.resumeStream()` once; the server returns 204 when no stream is
   * active, so it's a no-op for finished chats.
   */
  let shouldResumeStream = $state(false);
  /** Set when resumeStream returns 204 and the last loaded message was unanswered. */
  let wasInterrupted = $state(false);

  /**
   * Parallel "local event stream" for playground-specific UI that doesn't
   * originate from the Chat instance: `/schedule` proposal cards, confirm/
   * cancel toasts, and expansion progress messages. Rendered after
   * `chat.messages` in the message list so proposals always appear at the
   * bottom of the thread while they're live.
   */
  let localEvents: ChatMessage[] = $state([]);
  let error: string | null = $state(null);



  /**
   * Cached geolocation — requested once on first chat message. The browser
   * prompts for permission; if denied, lat/lon stay undefined and the agent
   * falls back to timezone-based location guessing.
   */
  let cachedLocation: { latitude: string; longitude: string } | null = null;
  let locationRequested = false;

  function requestLocation(): Promise<void> {
    if (locationRequested) return Promise.resolve();
    locationRequested = true;
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve();
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          cachedLocation = {
            latitude: pos.coords.latitude.toFixed(4),
            longitude: pos.coords.longitude.toFixed(4),
          };
          resolve();
        },
        () => {
          resolve();
        },
        { timeout: 5000, maximumAge: 300000 },
      );
    });
  }

  /**
   * Build the timezone/locale context the backend optionally accepts. The
   * chat-unification plan uses this to show accurate local timestamps in
   * agent replies without hard-coding UTC everywhere. Includes geolocation
   * when available so the agent can give location-accurate answers.
   */
  function buildDatetime(): Record<string, string> {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const offset = now.getTimezoneOffset();
    const sign = offset <= 0 ? "+" : "-";
    const absHours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0");
    const absMins = String(Math.abs(offset) % 60).padStart(2, "0");

    const result: Record<string, string> = {
      timezone: tz,
      timestamp: now.toISOString(),
      localDate: now.toLocaleDateString("en-CA"),
      localTime: now.toLocaleTimeString("en-US", { hour12: false }),
      timezoneOffset: `${sign}${absHours}:${absMins}`,
    };

    if (cachedLocation) {
      result.latitude = cachedLocation.latitude;
      result.longitude = cachedLocation.longitude;
    }

    return result;
  }

  /**
   * Monotonic token for rehydrate operations. Bumped every time a caller
   * starts a new rehydrate; `rehydrateChat` skips every state write whose
   * token is stale. Without this, a chat-list click colliding with a route
   * change could resolve in arbitrary order and render the earlier chat's
   * messages under the newer `chatId`.
   */
  let rehydrateToken = 0;

  /**
   * Rehydrate chat state from the backend using a persisted chatId.
   * On 404 (chat deleted) clears localStorage and starts fresh.
   * Network errors are silent so the caller can retry with a new chatId.
   *
   * `token` is compared against {@link rehydrateToken} at every await barrier.
   * If a newer rehydrate started while this one was in flight, all of this
   * one's writes are skipped so the newer flow owns state exclusively.
   */
  async function rehydrateChat(id: string, token: number): Promise<void> {
    const isStale = () => token !== rehydrateToken;
    if (!isStale()) rehydrating = true;
    try {
      const response = await fetch(`${CHAT_API}/${encodeURIComponent(id)}`);
      if (isStale()) return;
      if (!response.ok) {
        if (response.status === 404) {
          // Chat doesn't exist yet (fresh URL) or was deleted. Proceed with
          // empty state — the server will create the chat on first message.
          shouldResumeStream = false;
        }
        return;
      }
      const json: unknown = await response.json();
      if (isStale()) return;
      const parsed = GetChatResponseSchema.safeParse(json);
      if (!parsed.success) {
        shouldResumeStream = false;
        return;
      }

      // The server returns AI SDK v6 UIMessage-shaped entries (parts array);
      // parse them defensively into AtlasUIMessage[].
      //
      // Stamp `state: "done"` on every rehydrated assistant message — a
      // message loaded from disk is by definition past its live turn, so
      // the `extractToolCalls` reducer's crash fallback can promote any
      // still-in-progress delegate children to `output-error` instead of
      // rendering ghost spinners (AI SDK v6 doesn't set a top-level
      // `state` field on its own, so without this stamp the fallback
      // rule would never fire on reload).
      const rehydrated: AtlasUIMessage[] = [];
      for (const msg of parsed.data.messages) {
        if (
          typeof msg === "object" &&
          msg !== null &&
          "id" in msg &&
          "role" in msg &&
          "parts" in msg &&
          typeof msg.id === "string" &&
          typeof msg.role === "string" &&
          Array.isArray(msg.parts)
        ) {
          // We trust the server-side validator — it ran
          // `validateAtlasUIMessages` on write, so the shape is valid.
          const stamped =
            msg.role === "assistant" ? { ...msg, state: "done" as const } : msg;
          rehydrated.push(stamped as unknown as AtlasUIMessage);
        }
      }

      if (isStale()) return;
      initialMessages = rehydrated;
      systemPromptContext = parsed.data.systemPromptContext ?? null;
    } catch {
      // Silent — server might be temporarily down; the user can still send
      // a fresh message to start a new chat.
    } finally {
      // Only the owner of the latest token gets to flip `rehydrating` back
      // off; stale finalizers leave it alone so the in-flight rehydrate's
      // loading state survives until that one settles.
      if (!isStale()) rehydrating = false;
    }
  }

  // Re-run on chatId change so each chat gets its own state lineage.
  // Navigating between /platform/<ws>/chat/<a> and /platform/<ws>/chat/<b>
  // reuses the component instance (same route, different param), so both
  // `chatId` and `wsId` are tracked here. The body cleans state and
  // rehydrates from the server using the URL chatId.
  // Geolocation is requested on first message submit (handleSubmit), not
  // eagerly — avoids the browser permission prompt on page load.
  //
  // `rehydrationDone` only flips AFTER rehydrateChat resolves. The Chat
  // instance is $derived off it, so we get a single creation with the
  // settled initialMessages — otherwise every message update during
  // rehydrate would recreate the instance and discard any in-flight
  // `chat.resumeStream()` call.
  $effect(() => {
    const _trackWs = wsId; // explicit dependency on workspace route param
    void _trackWs;
    const _trackChat = chatId; // explicit dependency on chatId prop
    void _trackChat;

    localEvents = [];
    initialMessages = [];
    error = null;
    wasInterrupted = false;
    rehydrationDone = false;
    // Queued sends belong to the old chat's Chat; don't cross-post them
    // into the chat we're switching to.
    queuedMessages = [];
    // Validation pills are per-session; on chat switch any old pills
    // belong to a different conversation's sessions and must clear.
    validationEventsBySession = new Map();

    shouldResumeStream = true;
    const token = ++rehydrateToken;
    void rehydrateChat(chatId, token).finally(() => {
      if (token === rehydrateToken) rehydrationDone = true;
    });
  });

  // Transport — re-derived when CHAT_API / prepareSendMessagesRequest would
  // change. Both are stable in this component so it effectively fires once.
  const transport = $derived(
    new DefaultChatTransport({
      api: CHAT_API,
      prepareSendMessagesRequest({ messages: msgs, id }) {
        // The Atlas web adapter only needs the latest message plus the
        // chatId and optional datetime context — it pulls history server-
        // side from ChatStorage. Sending the full `msgs` array would be
        // wasteful bandwidth on long threads.
        const body: Record<string, unknown> = { id, message: msgs.at(-1), datetime: buildDatetime() };
        return { body };
      },
    }),
  );

  // Chat instance — re-derived when chatId or initialMessages change (new
  // chat, post-rehydration). `rehydrationDone` gates creation so we don't
  // spin up an empty Chat before we know whether we're resuming or starting
  // fresh.
  const chat = $derived(
    rehydrationDone && chatId.length > 0
      ? new ChatImpl<AtlasUIMessage>({ id: chatId, messages: initialMessages, transport })
      : null,
  );

  // Resume an in-flight stream after rehydrate. Fires once per chatId that
  // came from localStorage: if the user navigated away mid-response the
  // server's StreamRegistry still has the buffered chunks. `resumeStream()`
  // hits `GET /api/workspaces/<wsId>/chat/<chatId>/stream` — returns 204 when
  // no active stream, otherwise replays everything since the turn started so
  // the assistant's partial message flows in live and finishes normally.
  // Without this, navigating back showed only the persisted user message and
  // the in-flight assistant response was invisible until the next page load
  // (which could be after the stream completed and the message was flushed
  // to ChatStorage).
  $effect(() => {
    if (chat && shouldResumeStream) {
      shouldResumeStream = false;
      const instance = chat;
      // Capture before the async boundary — `initialMessages` is stable here
      // (rehydrateChat already settled), but we can't read it after the await.
      const hadUnansweredUser =
        initialMessages.length > 0 && initialMessages.at(-1)?.role === "user";
      instance.resumeStream().catch(() => {
        // The most common outcome is 204 (no active stream). When the session
        // died mid-response the server has nothing to replay — show an
        // interrupted indicator so the user knows to resend.
        if (hadUnansweredUser) wasInterrupted = true;
      });
      // Effect cleanup: when `chat` is re-derived (wsId change, switchToChat,
      // startNewChat) or the component unmounts, abort the old Chat's
      // resume fetch instead of letting it run until the server hangs up.
      // `chat.stop()` calls the AbortController inside `makeRequest` and
      // rejects the resume promise — swallowed above, so it's safe.
      return () => {
        void instance.stop().catch(() => {});
      };
    }
  });

  // One-shot: auto-submit a seed message planted by the overview start-chat card.
  // Only fires for fresh chats (no prior messages) to avoid replaying on navigation.
  // `untrack` around handleSubmit prevents chat.sendMessage()'s synchronous status
  // mutation from re-triggering this effect mid-execution.
  $effect(() => {
    if (!chat || initialMessages.length > 0) return;
    const key = `chat-seed-${wsId}`;
    const seed = sessionStorage.getItem(key);
    if (!seed) return;
    sessionStorage.removeItem(key);
    untrack(() => void handleSubmit(seed));
  });

  // Propagate transport / Chat errors into the playground error banner, but
  // only when there's no in-message error bubble for this turn. Session
  // failures (e.g. invalid model) arrive via BOTH a `data-error` chunk and
  // a rejected transport promise — rendering both is noisy duplication.
  $effect(() => {
    if (!chat?.error) return;
    const last = chat.messages.at(-1);
    if (last && last.role === "assistant" && hasErrorPart(last as AtlasUIMessage)) {
      return;
    }
    error = chat.error.message;
  });

  const streaming = $derived(chat?.status === "streaming" || chat?.status === "submitted");

  /**
   * "Working on it" indicator: shown after the user sends a message but
   * before anything renders in the assistant bubble. Flips off as soon as
   * the last assistant message has real content (text tokens or a tool
   * call card) — at that point the user has visible feedback and the
   * typing dots would just be noise.
   */
  const thinking = $derived.by<boolean>(() => {
    if (!chat) return false;
    if (chat.status === "submitted") return true;
    if (chat.status !== "streaming") return false;
    const last = chat.messages.at(-1);
    if (!last || last.role !== "assistant") return true;
    const hasText =
      Array.isArray(last.parts) &&
      last.parts.some(
        (p: unknown) =>
          typeof p === "object" &&
          p !== null &&
          "type" in p &&
          (p as { type: string }).type === "text" &&
          "text" in p &&
          typeof (p as { text: unknown }).text === "string" &&
          ((p as { text: string }).text.length > 0),
      );
    const hasToolCall =
      Array.isArray(last.parts) &&
      last.parts.some(
        (p: unknown) =>
          typeof p === "object" &&
          p !== null &&
          "type" in p &&
          typeof (p as { type: string }).type === "string" &&
          (p as { type: string }).type.startsWith("tool-"),
      );
    // Error chunks also terminate the thinking state — the turn produced
    // visible feedback (a red error bubble), just not text.
    return !hasText && !hasToolCall && !hasErrorPart(last as AtlasUIMessage);
  });

  /**
   * Session id of the in-flight turn, extracted from the server's
   * `data-session-start` chunk on the current assistant message. Used by
   * the Stop button to DELETE `/api/sessions/<id>`, which triggers the
   * workspace runtime's AbortController for the session and flips the
   * status to "cancelled" in history.
   */
  const activeSessionId = $derived.by<string | null>(() => {
    if (!chat || !streaming) return null;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const msg = chat.messages[i];
      if (!msg || msg.role !== "assistant" || !Array.isArray(msg.parts)) continue;
      for (const part of msg.parts) {
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          (part as { type: unknown }).type === "data-session-start"
        ) {
          const data = (part as { data?: unknown }).data;
          if (
            typeof data === "object" &&
            data !== null &&
            "sessionId" in data &&
            typeof (data as { sessionId: unknown }).sessionId === "string"
          ) {
            return (data as { sessionId: string }).sessionId;
          }
        }
      }
      break; // only inspect the most recent assistant message
    }
    return null;
  });

  let stopping = $state(false);

  /**
   * Validation lifecycle events received from the daemon's session SSE
   * stream, grouped by sessionId so each assistant message can read pills
   * for its own session via `metadata.sessionId`. Per-session arrays are
   * appended in stream order; the accumulator dedupes by `(actionId,
   * attempt)` and handles out-of-order events.
   *
   * Events accumulate for the lifetime of the chat-page mount; we don't
   * tear down on session boundaries because pills must remain visible
   * after the turn settles. They're cleared on chat switch alongside the
   * other per-chat state.
   */
  let validationEventsBySession: Map<string, SessionStreamEvent[]> = $state(new Map());

  /**
   * Subscribe to the active session's SSE stream and route every
   * `step:validation` event into `validationEventsBySession`. The
   * subscription tears down when `activeSessionId` flips or the
   * component unmounts; SSE 404 is benign (session ended before we
   * subscribed) and the JSON fallback inside `sessionEventStream`
   * yields any persisted events.
   *
   * Reads of `validationEventsBySession` happen inside `untrack` so
   * appending events does not re-trigger this effect.
   */
  $effect(() => {
    const sid = activeSessionId;
    if (!sid) return;

    const controller = new AbortController();

    (async () => {
      try {
        for await (const event of sessionEventStream(sid)) {
          if (controller.signal.aborted) return;
          if ("type" in event && event.type === "step:validation") {
            untrack(() => {
              const next = new Map(validationEventsBySession);
              const list = next.get(sid) ?? [];
              next.set(sid, [...list, event]);
              validationEventsBySession = next;
            });
          }
        }
      } catch (err) {
        // Subscription failures are non-fatal — pills just won't appear
        // for this session. The chat itself keeps working.
        console.warn("validation SSE subscription failed", { sid, err });
      }
    })();

    return () => {
      controller.abort();
    };
  });

  /**
   * Per-session map of validation attempts keyed by FSM `actionId`.
   * Recomputed whenever new events arrive; the accumulator is pure and
   * cheap so deriving on every change is fine.
   */
  const validationAttemptsBySession = $derived.by<Map<string, Map<string, ValidationAttemptDisplay[]>>>(() => {
    const out = new Map<string, Map<string, ValidationAttemptDisplay[]>>();
    for (const [sid, events] of validationEventsBySession) {
      const attempts = accumulateValidationAttempts(events);
      if (attempts.size > 0) out.set(sid, attempts);
    }
    return out;
  });

  /**
   * Abort the in-flight turn both client-side (`chat.stop()` tears down the
   * SSE read loop) and server-side (DELETE /api/sessions/<id> flips the
   * workspace runtime's AbortController). Fire-and-forget on errors — if
   * either side already finished we don't care, the whole flow is idempotent.
   */
  async function handleStop(): Promise<void> {
    if (stopping || !chat) return;
    stopping = true;
    const sid = activeSessionId;
    try {
      void chat.stop().catch(() => {});
      if (sid) {
        await fetch(`/api/daemon/api/sessions/${encodeURIComponent(sid)}`, {
          method: "DELETE",
        }).catch(() => {
          // Server may have already finished — not a user-facing error.
        });
      }
    } finally {
      stopping = false;
    }
  }

  // ─── Text-to-speech (Web Speech API) ──────────────────────────────────
  //
  // The Chrome `chrome.tts` API lives in the extensions sandbox; for a web
  // page, `window.speechSynthesis` is the public surface and uses the same
  // OS voices. Orchestration here: the toggle starts "reading along" with
  // the streaming assistant, feeding completed sentences to `speak()` as
  // they finalize. Past/currently-streaming messages are left alone; only
  // NEW assistant turns are read so flipping the toggle mid-response
  // doesn't suddenly blurt out the backlog.
  const TTS_PREF_KEY = "atlas:chat:ttsEnabled";
  const ttsSupported = typeof window !== "undefined" && "speechSynthesis" in window;

  function loadTtsPref(): boolean {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(TTS_PREF_KEY) === "1";
  }

  let ttsEnabled = $state(ttsSupported && loadTtsPref());
  // message.id of a turn we should NOT read — set when the toggle flips on
  // mid-stream, so only the NEXT turn (and onward) gets read.
  let ttsSkipMessageId = $state<string | null>(null);
  // Per-message raw-text offset (chat-tts.ts#nextSpeechChunk resume cursor).
  let ttsOffsets: Map<string, number> = new Map();

  function toggleTts(): void {
    if (!ttsSupported) return;
    const next = !ttsEnabled;
    ttsEnabled = next;
    try {
      localStorage.setItem(TTS_PREF_KEY, next ? "1" : "0");
    } catch {
      // quota / private mode — pref is best-effort.
    }
    if (!next) {
      // Toggle-off cancels the current utterance and any queued ones so the
      // chat goes quiet immediately rather than finishing the buffer.
      window.speechSynthesis.cancel();
      ttsSkipMessageId = null;
      return;
    }
    // Toggle-on while a turn is already streaming: skip it so the user
    // isn't caught off-guard by mid-sentence audio. If nothing is in
    // flight, next assistant turn starts at offset 0 on arrival.
    if (streaming && chat) {
      for (let i = chat.messages.length - 1; i >= 0; i--) {
        const msg = chat.messages[i];
        if (msg?.role === "assistant") {
          ttsSkipMessageId = msg.id;
          break;
        }
      }
    }
  }

  // Feed new completed sentences from the latest assistant message into
  // speechSynthesis.speak(). Guarded on `ttsEnabled` so the effect is a
  // cheap no-op when TTS is off. Reads the message list reactively so it
  // re-runs every time a text-delta lands.
  $effect(() => {
    if (!ttsEnabled || !ttsSupported || !chat) return;
    // Walk backward to find the latest assistant message — the one being
    // streamed if anything is in flight.
    let latestAssistant: AtlasUIMessage | null = null;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const msg = chat.messages[i];
      if (msg?.role === "assistant") {
        latestAssistant = msg;
        break;
      }
    }
    if (!latestAssistant) return;
    if (latestAssistant.id === ttsSkipMessageId) return;

    const text = extractText(latestAssistant);
    const offset = ttsOffsets.get(latestAssistant.id) ?? 0;
    const chunk = nextSpeechChunk(text, offset);
    if (!chunk.speak) return;
    ttsOffsets.set(latestAssistant.id, chunk.nextOffset);

    const utterance = new SpeechSynthesisUtterance(chunk.speak);
    utterance.rate = 1.05;
    window.speechSynthesis.speak(utterance);
  });

  /**
   * Messages composed while the assistant is still responding. We don't block
   * the input during streaming — users should be able to keep composing —
   * but `@ai-sdk/svelte`'s `sendMessage` can only fire one turn at a time.
   * Buffer here, then flush from a `$effect` that watches `streaming`.
   *
   * Each queued entry is the exact `parts` array we'd have sent live — text
   * + any attached/dropped images — so the flush path is identical to the
   * submit path.
   */
  type QueuedMessageParts = Array<
    | { type: "text"; text: string }
    | { type: "file"; mediaType: string; url: string; filename?: string }
    | { type: "data-credential-linked"; data: { provider: string; displayName: string } }
  >;
  let queuedMessages: QueuedMessageParts[] = $state([]);

  // Drain queued messages one at a time, awaiting each `sendMessage` so the
  // next entry only fires after the previous turn settles.
  //
  // A prior version tried to flush from a bare `$effect` that did
  // `queuedMessages = queuedMessages.slice(1); void chat.sendMessage(...)`.
  // That was racy: `sendMessage` flips status to "submitted" on a microtask,
  // not synchronously. The queue mutation re-invalidated the effect, and a
  // second pass could run before status flipped, dispatching the same entry
  // twice or losing the awaited promise entirely — the visible symptom was
  // a user message posting with no assistant reply.
  //
  // The `flushing` flag pins ownership of the drain to a single async pass;
  // the $effect only kicks it off when idle and the queue has work.
  let flushing = $state(false);

  async function drainQueuedMessages(): Promise<void> {
    if (flushing) return;
    flushing = true;
    try {
      // `chat` and `streaming` can both change across awaits (wsId switch,
      // next turn starting). The pure `nextQueueStep` reducer (unit-tested
      // in chat-queue.test.ts) encapsulates the can-we-dequeue branch so
      // the runtime loop stays small. Null `toSend` means "hold" — exit
      // and let the wsId-tracked $effect below re-kick when state changes.
      while (true) {
        const step = nextQueueStep(queuedMessages, { streaming, hasChat: chat !== null });
        if (step.toSend === null || !chat) break;
        queuedMessages = step.remainder;
        try {
          await chat.sendMessage({
            role: "user",
            parts: step.toSend,
            metadata: { timestamp: new Date().toISOString() },
          });
        } catch {
          // Error surfaces via the `chat.error` effect; don't loop on it.
          break;
        }
      }
    } finally {
      flushing = false;
    }
  }

  $effect(() => {
    if (streaming || queuedMessages.length === 0 || !chat || flushing) return;
    void drainQueuedMessages();
  });

  /**
   * Extract the text content of an {@link AtlasUIMessage} for render. We
   * concatenate all `{type: "text"}` parts and ignore data-event parts
   * (`data-artifact-attached`, etc.) since the playground message list
   * doesn't render those — it's a minimal UI.
   */
  function extractText(msg: AtlasUIMessage): string {
    if (!Array.isArray(msg.parts)) return "";
    const textParts = msg.parts
      .filter(
        (p): p is { type: "text"; text: string } =>
          typeof p === "object" &&
          p !== null &&
          "type" in p &&
          p.type === "text" &&
          "text" in p &&
          typeof p.text === "string",
      )
      .map((p) => p.text);

    const credentialParts = msg.parts
      .filter(
        (p): p is { type: "data-credential-linked"; data: { provider: string; displayName: string } } =>
          typeof p === "object" &&
          p !== null &&
          "type" in p &&
          p.type === "data-credential-linked" &&
          "data" in p &&
          typeof p.data === "object" &&
          p.data !== null &&
          "displayName" in p.data &&
          typeof p.data.displayName === "string",
      )
      .map((p) => `Connected ${p.data.displayName}.`);

    return [...textParts, ...credentialParts].join(" ");
  }

  /**
   * True if a message has anything worth rendering — a text part, a tool
   * call (in any state), or a reasoning part. Used as the phantom filter
   * replacement: the old version required a text part, which hid
   * tool-in-progress messages for 2–6 s while web_fetch / run_code ran.
   * Empty assistants with only `[data-session-start]` (the AI SDK +
   * Svelte $state race-bug phantom) still get filtered because their
   * only part is data-*.
   */
  function extractImages(msg: AtlasUIMessage): ImageDisplay[] {
    if (!Array.isArray(msg.parts)) return [];
    const imgs: ImageDisplay[] = [];
    for (const part of msg.parts) {
      if (typeof part !== "object" || part === null || !("type" in part)) continue;
      const p = part as { type: unknown; url?: unknown; mediaType?: unknown; filename?: unknown };
      if (p.type !== "file" || typeof p.url !== "string") continue;
      const mediaType = typeof p.mediaType === "string" ? p.mediaType : "image/png";
      if (!mediaType.startsWith("image/")) continue;
      imgs.push({
        url: p.url,
        mediaType,
        filename: typeof p.filename === "string" ? p.filename : undefined,
      });
    }
    return imgs;
  }


  // Stable per-message first-seen fallback for messages whose metadata
  // carries no timestamp (legacy user messages written before we started
  // stamping, with no following assistant turn to borrow from). A plain
  // Map keeps the value constant across $derived reruns; Date.now() inline
  // would drift on every render and every such message would show "now".
  const firstSeenMs = new Map<string, number>();

  function extractMetadataTimestamp(msg: AtlasUIMessage): number | null {
    const md = msg.metadata ?? {};
    const iso = md.startTimestamp ?? md.timestamp ?? md.endTimestamp;
    if (typeof iso === "string" && iso.length > 0) {
      const t = new Date(iso).getTime();
      if (!Number.isNaN(t)) return t;
    }
    return null;
  }

  // Assign a timestamp to every rendered message. Messages whose metadata
  // carries a stamp use it directly; messages without one (typically old
  // user messages) borrow the next message's stamp — a user turn is always
  // immediately followed by its assistant reply, so borrowing forward gives
  // a timestamp off by a second or two rather than hours.
  function assignTimestamps(rawMessages: readonly AtlasUIMessage[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const msg of rawMessages) {
      const t = extractMetadataTimestamp(msg);
      if (t !== null) out.set(msg.id, t);
    }
    for (let i = 0; i < rawMessages.length; i++) {
      const msg = rawMessages[i];
      if (!msg) continue;
      if (out.has(msg.id)) continue;
      for (let j = i + 1; j < rawMessages.length; j++) {
        const next = rawMessages[j];
        if (!next) continue;
        const t = out.get(next.id);
        if (t !== undefined) {
          out.set(msg.id, t);
          break;
        }
      }
    }
    for (const msg of rawMessages) {
      if (out.has(msg.id)) continue;
      const seen = firstSeenMs.get(msg.id);
      if (seen !== undefined) {
        out.set(msg.id, seen);
      } else {
        const now = Date.now();
        firstSeenMs.set(msg.id, now);
        out.set(msg.id, now);
      }
    }
    return out;
  }

  /**
   * Derive the unified display list: real chat turns from the AI SDK plus
   * playground-local events (schedule proposals, system toasts). Chat
   * messages come first (ordered by AI SDK), local events tail at the end.
   *
   * **Phantom-assistant filter**: our `AtlasWebAdapter` emits `data-session-
   * start` as the first stream chunk, BEFORE AI SDK's `start` chunk. AI SDK's
   * stream processor hits the data-chunk default case, pushes the part to
   * `state.message.parts`, and calls `write()`. That first `write()` triggers
   * an early `pushMessage()` in Svelte's reactive state while `state.message
   * .id` is still client-generated. When the server's `start` chunk arrives
   * and mutates `state.message.id` to the server id, the subsequent `write()`
   * pushes a *second* assistant entry because the proxy-wrapped first entry
   * doesn't observe the mutation. We end up with two assistants per turn:
   * one with only `[data-session-start]` parts, one with the real text.
   *
   * Filtering assistant entries that have no text/tool/reasoning parts
   * hides the phantom while still letting tool-in-progress messages show
   * up with a live status card before the first text-delta arrives.
   */
  const displayedMessages: ChatMessage[] = $derived.by(() => {
    if (!chat) return [...localEvents];
    const rawMessages = chat.messages.filter((msg) => {
      if (msg.role !== "assistant") return true;
      return hasRenderableContent(msg);
    });
    const timestamps = assignTimestamps(rawMessages);
    const chatMsgs: ChatMessage[] = rawMessages.map((msg) => {
      const m = (typeof msg.metadata === "object" && msg.metadata !== null
        ? msg.metadata
        : {}) as Record<string, unknown>;
      return {
        id: msg.id,
        role: (msg.role === "user"
          ? "user"
          : msg.role === "system"
            ? "system"
            : "assistant") as "user" | "assistant" | "system",
        content: extractText(msg),
        timestamp: timestamps.get(msg.id) ?? Date.now(),
        toolCalls: extractToolCalls(msg),
        images: extractImages(msg),
        errorText: extractErrorText(msg),
        metadata: {
          agentId: typeof m.agentId === "string" ? m.agentId : undefined,
          jobName: typeof m.jobName === "string" ? m.jobName : undefined,
          provider: typeof m.provider === "string" ? m.provider : undefined,
          modelId: typeof m.modelId === "string" ? m.modelId : undefined,
          sessionId: typeof m.sessionId === "string" ? m.sessionId : undefined,
        },
      };
    });
    return [...chatMsgs, ...localEvents];
  });

  /**
   * `/schedule <nl prompt>` — expand via smallLLM into a full FAST task
   * brief, show a proposal card, and only POST to the backlog on confirm.
   * Lives entirely in `localEvents`; never touches the chat agent.
   */
  async function handleScheduleCommand(input: string): Promise<void> {
    localEvents = [
      ...localEvents,
      {
        id: crypto.randomUUID(),
        role: "user",
        content: `/schedule ${input}`,
        timestamp: Date.now(),
      },
    ];

    const thinkingId = crypto.randomUUID();
    localEvents = [
      ...localEvents,
      { id: thinkingId, role: "system", content: "Expanding task brief...", timestamp: Date.now() },
    ];

    try {
      const proposal = await expandScheduleInput(input);
      localEvents = localEvents
        .filter((m) => m.id !== thinkingId)
        .concat({
          id: crypto.randomUUID(),
          role: "system",
          content: "",
          timestamp: Date.now(),
          scheduleProposal: proposal,
        });
    } catch (err) {
      localEvents = localEvents.filter((m) => m.id !== thinkingId);
      const msg = err instanceof Error ? err.message : String(err);
      error = `Schedule expansion failed: ${msg}`;
      console.error("Schedule expansion error", { error: msg });
    }
  }

  /**
   * Confirm / cancel handler wired to schedule proposal cards in the
   * message list. Confirm submits the backlog entry; cancel just dismisses
   * the card and leaves a breadcrumb system toast.
   */
  async function handleScheduleAction(
    action: "confirm" | "cancel",
    messageId: string,
    proposal?: ScheduleProposal,
  ): Promise<void> {
    if (action === "cancel") {
      localEvents = localEvents
        .filter((m) => m.id !== messageId)
        .concat({
          id: crypto.randomUUID(),
          role: "system",
          content: "Scheduling cancelled",
          timestamp: Date.now(),
        });
      return;
    }

    if (action === "confirm" && proposal) {
      localEvents = localEvents.filter((m) => m.id !== messageId);

      try {
        const entry = buildBacklogEntry(proposal);
        const result = await submitBacklogEntry(entry);

        if (result.ok) {
          localEvents = [
            ...localEvents,
            {
              id: crypto.randomUUID(),
              role: "system",
              content: `Queued FAST task ${result.taskId} at priority ${result.priority}`,
              timestamp: Date.now(),
            },
          ];
        } else {
          error = result.error ?? "Failed to queue task";
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error = `Failed to queue task: ${msg}`;
        console.error("Schedule submit error", { error: msg });
      }
    }
  }

  /** Navigate to a fresh chat. The loader generates the new chatId. */
  function startNewChat() {
    goto(`/platform/${encodeURIComponent(wsId)}/chat`);
  }

  /** Navigate to an existing chat (from the chat list panel). */
  function switchToChat(targetChatId: string): void {
    if (targetChatId === chatId) return;
    goto(`/platform/${encodeURIComponent(wsId)}/chat/${encodeURIComponent(targetChatId)}`);
  }

  async function handleSubmit(text: string, inputImages: ImageAttachment[] = []) {
    // Intercept /schedule slash-command before it reaches the chat agent.
    // Run even during streaming — it's a client-only flow.
    const scheduleCmd = parseScheduleCommand(text);
    if (scheduleCmd) {
      void handleScheduleCommand(scheduleCmd.input);
      return;
    }

    if (!chat) return;
    error = null;
    wasInterrupted = false;

    // Merge images from the input component + any dropped on the chat area
    const allImages = [...inputImages, ...pendingImages];
    pendingImages = [];

    const parts: QueuedMessageParts = [];

    if (text.length > 0) {
      parts.push({ type: "text", text });
    }

    for (const img of allImages) {
      parts.push({
        type: "file",
        mediaType: img.file.type || "image/png",
        url: img.dataUrl,
        filename: img.file.name,
      });
    }

    if (parts.length === 0) return;

    // Queue while the current turn is still streaming; the flush effect
    // fires the next turn as soon as status returns to ready.
    if (streaming) {
      queuedMessages = [...queuedMessages, parts];
      return;
    }

    void chat.sendMessage({
      role: "user",
      parts,
      metadata: { timestamp: new Date().toISOString() },
    });
  }

  /**
   * Called when the user successfully connects a credential via an inline
   * connect_service card. Sends a lightweight user message so the agent
   * retries on its next turn with the updated <integrations> state.
   */
  function handleCredentialConnected(provider: string): void {
    if (!chat) return;
    const parts: QueuedMessageParts = [
      { type: "data-credential-linked", data: { provider, displayName: provider } },
    ];
    if (streaming) {
      queuedMessages = [...queuedMessages, parts];
      return;
    }
    void chat.sendMessage({
      role: "user",
      parts,
      metadata: { timestamp: new Date().toISOString() },
    });
  }

  /* ─── Workspace-list cache invalidation on chat-tool mutations ───── */

  /** Tool calls whose completion should trigger a workspace-list refetch. */
  const WORKSPACE_INVALIDATING_TOOLS = new Set([
    "create_workspace",
    "workspace_create",
    "publish_draft",
    "upsert_agent",
    "upsert_signal",
    "upsert_job",
    "remove_item",
    "begin_draft",
    "discard_draft",
    "enable_mcp_server",
    "disable_mcp_server",
  ]);

  /** Track tool-call IDs we've already reacted to so we don't double-fire. */
  const seenToolCallIds = new Set<string>();

  function scanForInvalidation(calls: ToolCallDisplay[]): void {
    for (const call of calls) {
      if (call.toolCallId && WORKSPACE_INVALIDATING_TOOLS.has(call.toolName)) {
        if (call.state === "output-available" || call.state === "output-error") {
          if (!seenToolCallIds.has(call.toolCallId)) {
            seenToolCallIds.add(call.toolCallId);
            void queryClient.invalidateQueries({ queryKey: workspaceQueries.all() });
          }
        }
      }
      if (call.children) {
        scanForInvalidation(call.children);
      }
    }
  }

  $effect(() => {
    for (const msg of displayedMessages) {
      if (msg.toolCalls) {
        scanForInvalidation(msg.toolCalls);
      }
    }
  });
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div
  class="user-chat"
  class:chat-drag-over={chatDragOver}
  ondrop={handleChatDrop}
  ondragover={handleChatDragOver}
  ondragleave={handleChatDragLeave}
  role="presentation"
>
  {#if chatDragOver}
    <div class="drop-overlay">
      <span>Drop image here</span>
    </div>
  {/if}

  {#if pendingImages.length > 0}
    <div class="pending-images-bar">
      {#each pendingImages as img (img.id)}
        <div class="pending-image">
          <img src={img.dataUrl} alt={img.file.name} />
          <button
            onclick={() => {
              pendingImages = pendingImages.filter((i) => i.id !== img.id);
            }}
            aria-label="Remove"
          >
            ✕
          </button>
        </div>
      {/each}
    </div>
  {/if}

  <header class="chat-header">
    <h2>Chat</h2>
    <span class="workspace-badge">{workspaceName}</span>
    <span class="header-spacer"></span>
    {#if chat && chat.messages.length > 0}
      <button class="new-chat-button" onclick={startNewChat} disabled={streaming}>New Chat</button>
    {/if}
  </header>

  <div class="chat-body">
    <div class="chat-main">
      {#if rehydrating}
        <div class="rehydrating-indicator">Loading conversation...</div>
      {/if}

      <ChatMessageList
        messages={displayedMessages}
        onScheduleAction={handleScheduleAction}
        onCredentialConnected={handleCredentialConnected}
        {thinking}
        {validationAttemptsBySession}
      />

      {#if wasInterrupted}
        <div class="interrupted-banner" role="status">
          Response was interrupted.
          <button
            class="interrupted-retry"
            onclick={() => {
              wasInterrupted = false;
              const lastUser = displayedMessages.findLast((m) => m.role === "user");
              if (lastUser?.content) void handleSubmit(lastUser.content);
            }}
          >Resend</button>
        </div>
      {/if}

      {#if error}
        <div class="error-banner" role="alert">
          {error}
        </div>
      {/if}

      <div class="chat-input-area">
        {#if queuedMessages.length > 0}
          <div class="queued-indicator">
            {queuedMessages.length === 1
              ? "1 message queued — will send when the assistant finishes"
              : `${queuedMessages.length} messages queued — will send when the assistant finishes`}
          </div>
        {/if}
        <ChatInput
          onsubmit={handleSubmit}
          {streaming}
          {stopping}
          onstop={handleStop}
          {ttsEnabled}
          onttsToggle={ttsSupported ? toggleTts : undefined}
        />
      </div>
    </div>

    <ChatInspector
      open={inspectorOpen}
      {chatId}
      messages={displayedMessages}
      {systemPromptContext}
      {workspaceName}
      workspaceId={wsId}
      status={streaming ? "streaming" : (chat?.status ?? "idle")}
    />

    <ChatListPanel
      workspaceId={wsId}
      currentChatId={chatId}
      onSelect={switchToChat}
      onDelete={(deletedId, nextChatId) => {
        // Only react when the user nuked the chat they're currently
        // viewing — otherwise the rest of the list stays put and there's
        // nothing to do here. When it IS the current chat, jump to the
        // neighbor the panel picked (older-first, falling back to newer)
        // so browsing history stays fluid. If the list is empty now,
        // start a fresh chat instead of leaving a dead id on screen.
        if (deletedId !== chatId) return;
        if (nextChatId) {
          // switchToChat already persists and kicks off rehydration.
          switchToChat(nextChatId);
        } else {
          startNewChat();
        }
      }}
    />
  </div>
</div>

<style>
  .user-chat {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-block-size: 0;
    overflow: hidden;
  }

  .chat-header {
    align-items: center;
    background-color: var(--surface);
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    flex-shrink: 0;
    gap: var(--size-3);
    padding: var(--size-4) var(--size-5);
    position: sticky;
    inset-block-start: 0;
    z-index: var(--layer-1, 10);
  }

  .chat-header h2 {
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-6);
  }

  .workspace-badge {
    background-color: var(--color-surface-3);
    border-radius: var(--radius-2);
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-size: var(--font-size-1);
    padding: var(--size-0-5) var(--size-2);
  }

  .header-spacer {
    flex: 1;
  }

  .new-chat-button {
    background-color: var(--color-surface-3);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    padding: var(--size-1) var(--size-2-5);
    transition: background-color 150ms ease;
  }

  .new-chat-button:hover:not(:disabled) {
    background-color: var(--color-surface-2);
  }

  .new-chat-button:disabled {
    cursor: default;
    opacity: 0.5;
  }

  .rehydrating-indicator {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
    padding: var(--size-2) var(--size-4);
    text-align: center;
  }

  .interrupted-banner {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    display: flex;
    font-size: var(--font-size-2);
    gap: var(--size-2);
    justify-content: center;
    padding: var(--size-2) var(--size-4);
  }

  .interrupted-retry {
    background: none;
    border: 1px solid currentColor;
    border-radius: var(--radius-1);
    color: inherit;
    cursor: pointer;
    font-size: inherit;
    padding: var(--size-1) var(--size-2);
  }

  .interrupted-retry:hover {
    color: var(--color-text);
  }

  .error-banner {
    background-color: color-mix(in srgb, var(--color-error), transparent 85%);
    border-radius: var(--radius-2);
    color: var(--color-error);
    font-size: var(--font-size-2);
    margin-inline: var(--size-4);
    padding: var(--size-2) var(--size-3);
  }

  .chat-body {
    display: flex;
    flex: 1;
    min-block-size: 0;
    overflow: hidden;
  }

  .chat-main {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-inline-size: 0;
    overflow: hidden;
  }

  .chat-input-area {
    border-block-start: 1px solid var(--color-border-1);
    flex-shrink: 0;
    padding: var(--size-3) var(--size-4);
  }

  .queued-indicator {
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    font-size: var(--font-size-1);
    padding-block-end: var(--size-2);
    text-align: center;
  }

  /* ─── Drag-drop overlay ────────────────────────────────────────────── */

  .user-chat.chat-drag-over {
    position: relative;
  }

  .drop-overlay {
    align-items: center;
    background-color: color-mix(in srgb, var(--color-primary), transparent 85%);
    border: 2px dashed var(--color-primary);
    border-radius: var(--radius-3);
    display: flex;
    inset: var(--size-2);
    justify-content: center;
    position: absolute;
    z-index: 10;
  }

  .drop-overlay span {
    background-color: var(--color-primary);
    border-radius: var(--radius-2);
    color: white;
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
    padding: var(--size-2) var(--size-4);
  }

  .pending-images-bar {
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    gap: var(--size-2);
    overflow-x: auto;
    padding: var(--size-2) var(--size-4);
  }

  .pending-image {
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    flex-shrink: 0;
    overflow: hidden;
    position: relative;
  }

  .pending-image img {
    block-size: 48px;
    display: block;
    inline-size: auto;
    max-inline-size: 80px;
    object-fit: cover;
  }

  .pending-image button {
    align-items: center;
    background-color: color-mix(in srgb, var(--color-surface-1), transparent 20%);
    block-size: 16px;
    border: none;
    border-radius: 50%;
    color: var(--color-text);
    cursor: pointer;
    display: flex;
    font-size: 9px;
    inline-size: 16px;
    inset-block-start: 2px;
    inset-inline-end: 2px;
    justify-content: center;
    position: absolute;
  }

  .pending-image button:hover {
    background-color: var(--color-error);
    color: white;
  }
</style>
