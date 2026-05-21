<script lang="ts">
  import { untrack } from "svelte";
  import { Chat as ChatImpl } from "@ai-sdk/svelte";
  import type { AtlasUIMessage } from "@atlas/agent-sdk";
  import { toast } from "@atlas/ui";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { page } from "$app/state";
  import { browser } from "$app/environment";
  import { workspaceQueries } from "$lib/queries";
  import { mergeElicitationIntoCache } from "$lib/queries/elicitation-queries.ts";
  import { subscribeToWorkspaceElicitations } from "$lib/shared-worker/client.ts";
  import { DefaultChatTransport } from "ai";
  import ChatInput, { type InsertedMention } from "./chat-input.svelte";
  import {
    type FileAttachment,
    type ChatAttachment,
    buildFileAttachment,
    classifyAttachment,
    duplicateToast,
    isDuplicateAttachment,
    rejectionToast,
    runFileUpload,
  } from "./chat-attachment.ts";
  import ChatInspector from "./chat-inspector.svelte";
  import ChatMessageList from "./chat-message-list.svelte";
  import ChatSessionUsage from "./chat-session-usage.svelte";
  import { createCursorTrackingFetch } from "./cursor-tracking-fetch.ts";
  import { nextQueueStep } from "./chat-queue.ts";
  import { nextResumeBudgetStep } from "./resume-budget.ts";
  import { nextSpeechChunk } from "./chat-tts.ts";
  import { buildSegments, extractImages } from "@atlas/core/chat/export/render";
  import { extractErrorText, hasErrorPart, hasRenderableContent } from "./message-error.ts";
  import type { ChatMessage, ToolCallDisplay } from "./types";
  import { GetChatResponseSchema } from "./types";

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
  let fullscreen = $state(false);

  function handleGlobalKeydown(e: KeyboardEvent) {
    // Cmd+Shift+D (Debug) — Cmd+Shift+I is intercepted by Chrome DevTools
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "d") {
      e.preventDefault();
      inspectorOpen = !inspectorOpen;
      return;
    }
    // Ctrl+F toggles fullscreen — deliberately Ctrl, never ⌘, so Mac's
    // ⌘+F find-in-page is untouched. Tradeoff: on Windows/Linux Ctrl+F
    // *is* browser find, so it's shadowed inside the chat surface. This
    // is a local dev tool and the in-app shortcut is the priority here;
    // revisit if that becomes a real friction point.
    if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.key === "f") {
      e.preventDefault();
      fullscreen = !fullscreen;
      return;
    }
    if (e.key === "Escape" && fullscreen) {
      fullscreen = false;
    }
  }
  let systemPromptContext: { timestamp: string; systemMessages: string[] } | null = $state(null);

  let chatDragOver = $state(false);
  /**
   * Attachments for the *next* outgoing message. Bound into `ChatInput`
   * via `bind:attachments` so the file picker and the chat-surface drop
   * target share one bucket and one render location (the strip above the input).
   */
  let inputAttachments: ChatAttachment[] = $state([]);

  async function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  function patchInputFile(id: string, patch: Partial<FileAttachment>) {
    inputAttachments = inputAttachments.map((a) =>
      a.kind === "file" && a.id === id ? { ...a, ...patch } : a,
    );

    // Post-upload dedup. See `chat-input.svelte:patchAttachment` for
    // the rationale — server returns `{chatId}/{md5}`, two identical
    // uploads produce identical paths, we collapse the duplicate here.
    if (patch.path) {
      const newPath = patch.path;
      const sharing = inputAttachments.filter(
        (a) => a.kind === "file" && a.path === newPath,
      );
      if (sharing.length > 1) {
        const removed = inputAttachments.find((a) => a.id === id);
        inputAttachments = inputAttachments.filter((a) => a.id !== id);
        if (removed) {
          const summary = duplicateToast([removed.file]);
          if (summary) toast({ ...summary });
        }
      }
    }
  }

  function handleChatDrop(e: DragEvent) {
    e.preventDefault();
    chatDragOver = false;
    if (e.dataTransfer?.files) {
      void addDroppedFiles(e.dataTransfer.files);
    }
  }

  // Safari requires preventDefault on BOTH dragenter and dragover to register
  // the element as a valid drop target; without dragenter prevention it falls
  // back to its default file-open behavior on drop.
  function handleChatDragEnter(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    chatDragOver = true;
  }

  function handleChatDragOver(e: DragEvent) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
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
    const rejected: File[] = [];
    const duplicates: File[] = [];
    for (const file of files) {
      const kind = classifyAttachment(file);
      if (kind === "image") {
        // Images dedup pre-add via dataUrl equality — see
        // chat-input.svelte:addFiles for rationale.
        const dataUrl = await fileToDataUrl(file);
        if (isDuplicateAttachment({ kind: "image", dataUrl }, inputAttachments)) {
          duplicates.push(file);
          continue;
        }
        inputAttachments = [
          ...inputAttachments,
          { kind: "image", id: crypto.randomUUID(), file, dataUrl },
        ];
      } else if (kind === "file") {
        // Files dedup post-upload via the server-returned path — see
        // `patchInputFile` for the reconcile branch.
        const att = buildFileAttachment(file);
        inputAttachments = [...inputAttachments, att];
        runFileUpload({ att, chatId, workspaceId: wsId, onUpdate: patchInputFile });
      } else {
        rejected.push(file);
      }
    }
    const dupSummary = duplicateToast(duplicates);
    if (dupSummary) toast({ ...dupSummary });
    const summary = rejectionToast(rejected);
    if (summary) toast({ ...summary, error: true });
  }

  const CHAT_API = $derived(`/api/daemon/api/workspaces/${encodeURIComponent(wsId)}/chat`);
  let initialMessages: AtlasUIMessage[] = $state([]);
  let rehydrationDone = $state(false);
  let rehydrating = $state(false);
  /** Tries `chat.resumeStream()` once after rehydrate; 204 = no live stream. */
  let shouldResumeStream = $state(false);
  /** True when resume returned 204 and the last loaded message was a user turn. */
  let wasInterrupted = $state(false);

  let error: string | null = $state(null);

  /**
   * Bound on *consecutive no-progress* resume attempts. Resets on forward
   * progress (see {@link nextResumeBudgetStep}) so a multi-minute tool call
   * across many Chrome ~50s fetch caps doesn't exhaust mid-stream.
   */
  const MAX_TURN_RESUMES = 20;
  let resumeAttempts = $state(0);
  let lastSeenEventId: number | undefined = $state(undefined);
  let lastSeenEventIdAtLastFailure: number | undefined = $state(undefined);
  /**
   * Set when the server signals the SSE buffer can't be replayed
   * (`410 Gone` + `X-Stream-Replay-Disabled: true`). Short-circuits
   * auto-resume so we surface the banner instead of burning the 20-attempt
   * budget on a status that won't change.
   */
  let unrecoverableStream = $state(false);

  function resetResumeState(): void {
    resumeAttempts = 0;
    lastSeenEventId = undefined;
    lastSeenEventIdAtLastFailure = undefined;
    unrecoverableStream = false;
  }

  const trackingFetch = createCursorTrackingFetch({
    getCursor: () => lastSeenEventId,
    setCursor: (value) => {
      lastSeenEventId = value;
    },
    isResumeRequest: (input) =>
      typeof input === "string" || input instanceof URL
        ? String(input).endsWith("/stream")
        : input.url.endsWith("/stream"),
    onUnrecoverable: () => {
      unrecoverableStream = true;
    },
  });

  /**
   * Keep the inline HITL cards in sync with Activity.  The card itself
   * queries the replay list, but newly-created elicitations are delivered via
   * NATS/SSE; without this subscription a fresh cached list can briefly render
   * the "open Activity" fallback instead of the inline answer form.
   */
  $effect(() => {
    if (!browser || !wsId) return;

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const elicitation of subscribeToWorkspaceElicitations(wsId, {
          signal: controller.signal,
        })) {
          mergeElicitationIntoCache(queryClient, elicitation);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn("Workspace elicitations stream errored", error);
      }
    })();
    return () => controller.abort();
  });

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

    initialMessages = [];
    error = null;
    wasInterrupted = false;
    rehydrationDone = false;
    // Queued sends belong to the old chat's Chat; don't cross-post them
    // into the chat we're switching to.
    queuedMessages = [];
    // Attachments are per-chat drafts; switching mid-draft must not leak
    // files or images into the new chat. Read the current draft untracked so
    // this chatId/wsId effect does not re-run on every draft reset.
    const draftAttachments = untrack(() => inputAttachments);
    for (const att of draftAttachments) {
      if (att.kind === "file" && att.status === "uploading") att.abortController.abort();
    }
    inputAttachments = [];

    shouldResumeStream = true;
    const token = ++rehydrateToken;
    void rehydrateChat(chatId, token).finally(() => {
      if (token === rehydrateToken) rehydrationDone = true;
    });
  });

  const transport = $derived(
    new DefaultChatTransport({
      api: CHAT_API,
      fetch: trackingFetch,
      prepareSendMessagesRequest({ messages: msgs, id }) {
        // Adapter pulls history server-side; sending msgs[] would waste bandwidth.
        const body: Record<string, unknown> = { id, message: msgs.at(-1), datetime: buildDatetime() };
        return { body };
      },
    }),
  );

  // `rehydrationDone` gates creation so we don't spin up an empty Chat
  // before we know whether we're resuming or starting fresh.
  const chat = $derived(
    rehydrationDone && chatId.length > 0
      ? new ChatImpl<AtlasUIMessage>({
          id: chatId,
          // ChatImpl mutates its `messages` state during send/stream. Do not
          // hand it our `$state` rehydration array directly, or a user send
          // will mutate `initialMessages` and retrigger resume-effect cleanup.
          messages: [...initialMessages],
          transport,
        })
      : null,
  );

  // Route changes and component teardown must abort any active AI SDK stream.
  // Otherwise a chat left waiting on HITL can keep its fetch/SSE connection
  // alive behind the dev-server proxy after the UI moved elsewhere.
  $effect(() => {
    const instance = chat;
    if (!instance) return;
    return () => {
      void instance.stop().catch(() => {});
    };
  });

  // Pick up an in-flight turn the user navigated away from. 204 = no live
  // stream; if the last loaded message was an unanswered user turn, surface
  // the interrupted banner so they can resend.
  //
  // Read `shouldResumeStream` via `untrack` so the synchronous self-write
  // below can't queue a same-tick re-run whose cleanup would `instance.stop()`
  // the just-fired resumeStream. The chatId-change effect sets the flag true
  // BEFORE chat is created, so reading it untracked still observes the right
  // value when this effect runs on the chat null→ChatImpl transition. The
  // trailing-user check is also one-shot; tracking `initialMessages` here would
  // make ChatImpl message pushes re-run this cleanup and abort fresh sends.
  $effect(() => {
    if (!chat) return;
    if (!untrack(() => shouldResumeStream)) return;
    shouldResumeStream = false;
    const instance = chat;
    const hadUnansweredUser = untrack(
      () => initialMessages.length > 0 && initialMessages.at(-1)?.role === "user",
    );
    instance.resumeStream().catch(() => {
      if (hadUnansweredUser) wasInterrupted = true;
    });
    // Abort the old Chat's resume fetch when re-derived or unmounted.
    return () => {
      void instance.stop().catch(() => {});
    };
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

  // Mid-turn fetch drops (Chrome's ~50s streaming cap) get an auto-resume
  // before the banner. Skip if the SDK already rendered an in-message error
  // bubble — session failures (e.g. invalid model) arrive via both a
  // `data-error` chunk and a rejected transport promise.
  $effect(() => {
    if (!chat?.error) return;
    const last = chat.messages.at(-1);
    if (last && last.role === "assistant" && hasErrorPart(last as AtlasUIMessage)) {
      return;
    }
    if (unrecoverableStream) {
      error = chat.error.message;
      return;
    }
    // Terminal errors that fired before any SSE frame landed (e.g. 503
    // no-responders from a downed daemon) won't be recovered by resuming —
    // the GET /stream just 204s. Surface the banner immediately instead of
    // burning the 20-attempt budget.
    if (lastSeenEventId === undefined) {
      error = chat.error.message;
      return;
    }
    const step = nextResumeBudgetStep({
      lastSeenEventId,
      lastSeenEventIdAtLastFailure,
      resumeAttempts,
      maxTurnResumes: MAX_TURN_RESUMES,
    });
    resumeAttempts = step.nextResumeAttempts;
    lastSeenEventIdAtLastFailure = step.nextLastSeenEventIdAtLastFailure;

    if (step.shouldResume) {
      const instance = chat;
      instance.clearError();
      // Failure here re-enters via chat.error on the next tick; if the
      // budget is now exhausted it falls through to the banner.
      instance.resumeStream().catch(() => {});
      return;
    }
    error = chat.error.message;
  });

  const streaming = $derived(chat?.status === "streaming" || chat?.status === "submitted");

  /**
   * Id of the tail message while the chat is in any non-terminal status
   * (streaming, submitted, errored mid-turn). Wider than `streaming` on
   * purpose: a stream that drops into "error" can auto-resume back into
   * "streaming" on the same id (see `resumeStream` below), so we keep
   * the tail gated through that window. `chat-message-list` uses this
   * to skip post-stream DOM affordances per-message — see its
   * `unsettledMessageId` prop docstring.
   */
  const unsettledMessageId = $derived(
    chat && chat.status !== "ready" && chat.messages.length > 0
      ? chat.messages[chat.messages.length - 1]?.id
      : undefined,
  );

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
   * + any attached/dropped files/images — so the flush path is identical to
   * the submit path.
   */
  type QueuedMessageParts = Array<
    | { type: "text"; text: string }
    | { type: "file"; mediaType: string; url: string; filename?: string }
    | { type: "data-credential-linked"; data: { provider: string; displayName: string } }
    | {
        type: "data-env-applied";
        data: { scope: "workspace" | "global"; keys: string[] };
      }
    | {
        type: "data-file-attached";
        data: { paths: string[]; filenames: string[]; mimeTypes: string[] };
      }
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
          resetResumeState();
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

    const envAppliedParts = msg.parts
      .filter(
        (p): p is { type: "data-env-applied"; data: { scope: "workspace" | "global"; keys: string[] } } =>
          typeof p === "object" &&
          p !== null &&
          "type" in p &&
          p.type === "data-env-applied" &&
          "data" in p &&
          typeof p.data === "object" &&
          p.data !== null &&
          "keys" in p.data &&
          Array.isArray(p.data.keys),
      )
      .map((p) => {
        const keys = p.data.keys.filter((k: unknown): k is string => typeof k === "string");
        return keys.length > 0 ? `Set ${keys.join(", ")}.` : "";
      })
      .filter((s) => s.length > 0);

    return [...textParts, ...credentialParts, ...envAppliedParts].join(" ");
  }

  /**
   * Pull per-turn token + cache usage off a UI message. Reads
   * `metadata.usage` first (the persisted shape, set by the chat
   * handler just before append) and falls back to a `data-usage`
   * part on the message (the live-stream shape, emitted from
   * `streamText.onFinish` so the UsageBadge can render the in-flight
   * turn before the first page refresh).
   *
   * Returns `undefined` when neither source is present — legacy chat
   * messages, or turns that haven't reported usage yet.
   */
  function extractTurnUsage(
    msg: AtlasUIMessage,
    metadataRecord: Record<string, unknown>,
  ):
    | {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        cacheWriteTokens?: number;
      }
    | undefined {
    function pickNumber(source: unknown, key: string): number | undefined {
      if (typeof source !== "object" || source === null) return undefined;
      const v = (source as Record<string, unknown>)[key];
      return typeof v === "number" ? v : undefined;
    }

    function shape(source: unknown):
      | {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
        }
      | undefined {
      if (typeof source !== "object" || source === null) return undefined;
      return {
        inputTokens: pickNumber(source, "inputTokens"),
        outputTokens: pickNumber(source, "outputTokens"),
        cacheReadTokens: pickNumber(source, "cacheReadTokens"),
        cacheWriteTokens: pickNumber(source, "cacheWriteTokens"),
      };
    }

    const fromMetadata = shape(metadataRecord.usage);
    if (fromMetadata) return fromMetadata;

    if (Array.isArray(msg.parts)) {
      // Walk in reverse so the latest data-usage part wins on the
      // (rare) case the stream emits more than one.
      for (let i = msg.parts.length - 1; i >= 0; i--) {
        const part = msg.parts[i];
        if (typeof part !== "object" || part === null || !("type" in part)) continue;
        const p = part as { type: unknown; data?: unknown };
        if (p.type === "data-usage") {
          const fromPart = shape(p.data);
          if (fromPart) return fromPart;
        }
      }
    }

    return undefined;
  }


  // Stable per-message first-seen fallback for messages whose metadata
  // carries no timestamp (legacy user messages written before we started
  // stamping, with no following assistant turn to borrow from). A plain
  // Map keeps the value constant across $derived reruns; Date.now() inline
  // would drift on every render and every such message would show "now".
  const firstSeenMs = new Map<string, number>();

  // Per-message converted-display cache. `displayedMessages` re-runs on
  // every streaming chunk because `chat.messages` is reactive and gets
  // mutated in place; without this cache, every historical message
  // re-walks `buildSegments` / `extractImages` / `extractToolCalls` /
  // `extractTurnUsage` per token, which dominated profiling at high
  // streaming rates (50-100 chunks/sec × N messages × ~300us per pipe).
  //
  // The cache is keyed on the message object identity (`WeakMap`) so it
  // auto-evicts when the SDK reassigns or drops a message, and a coarse
  // content signature (`parts.length` + last-part fingerprint) decides
  // whether the cached entry is still valid. Streaming only mutates the
  // tail message, so unchanged history hits the cache every tick.
  type CachedDisplayMessage = { sig: string; result: ChatMessage };
  const displayCache: WeakMap<AtlasUIMessage, CachedDisplayMessage> = new WeakMap();

  function displaySignature(msg: AtlasUIMessage): string {
    const parts = Array.isArray(msg.parts) ? msg.parts : [];
    const lastIdx = parts.length - 1;
    let lastSig = "0";
    if (lastIdx >= 0) {
      const last = parts[lastIdx];
      if (typeof last === "object" && last !== null) {
        const type = "type" in last ? String((last as Record<string, unknown>).type) : "?";
        const text =
          "text" in last && typeof (last as Record<string, unknown>).text === "string"
            ? ((last as Record<string, unknown>).text as string).length
            : 0;
        const state =
          "state" in last ? String((last as Record<string, unknown>).state ?? "") : "";
        lastSig = `${type}:${text}:${state}`;
      }
    }
    return `${parts.length}:${lastSig}`;
  }

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
   * Derive the unified display list of chat turns from the AI SDK.
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
    if (!chat) return [];
    const rawMessages = chat.messages.filter((msg) => {
      if (msg.role !== "assistant") return true;
      return hasRenderableContent(msg);
    });
    const timestamps = assignTimestamps(rawMessages);
    const lastIdx = rawMessages.length - 1;
    const chatMsgs: ChatMessage[] = rawMessages.map((msg, idx) => {
      // Skip the cache for the tail message: streaming chunks (text
      // deltas, delegate sub-chunks, data-usage appends) can arrive
      // without changing the *last* part of `msg.parts`, which is what
      // `displaySignature` fingerprints. The conservative fix is to
      // recompute the tail every tick — it's a single message per
      // render, so the cost is bounded — and rely on the cache for the
      // (much larger) immutable history. Markdown body throttling
      // covers the per-chunk marked + DOMPurify cost separately.
      const isTail = idx === lastIdx;
      const sig = displaySignature(msg);
      const cached = isTail ? undefined : displayCache.get(msg);
      const ts = timestamps.get(msg.id) ?? Date.now();
      if (cached && cached.sig === sig && cached.result.timestamp === ts) {
        return cached.result;
      }
      const m = (typeof msg.metadata === "object" && msg.metadata !== null
        ? msg.metadata
        : {}) as Record<string, unknown>;
      // Resolved @-mentions for this message — server-side resolver
      // stashes a `data-mention-resolved` part per expanded ref. The
      // message-list reads this to swap raw `@ws/chat` tokens for
      // links to the referenced chat. See friday-studio-c7j.
      const mentions: ChatMessage["mentions"] = [];
      const parts = Array.isArray(msg.parts) ? msg.parts : [];
      for (const part of parts) {
        if (typeof part !== "object" || part === null) continue;
        if ((part as { type?: unknown }).type !== "data-mention-resolved") continue;
        const data = (part as { data?: unknown }).data;
        if (typeof data !== "object" || data === null) continue;
        const d = data as Record<string, unknown>;
        if (
          typeof d.workspaceId === "string" &&
          typeof d.chatId === "string" &&
          typeof d.title === "string" &&
          typeof d.snapshot === "string" &&
          typeof d.messageCount === "number" &&
          typeof d.generatedAt === "string"
        ) {
          mentions.push({
            workspaceId: d.workspaceId,
            chatId: d.chatId,
            title: d.title,
            snapshot: d.snapshot,
            messageCount: d.messageCount,
            generatedAt: d.generatedAt,
          });
        }
      }

      const result: ChatMessage = {
        id: msg.id,
        role: (msg.role === "user"
          ? "user"
          : msg.role === "system"
            ? "system"
            : "assistant") as "user" | "assistant" | "system",
        segments: buildSegments(msg),
        timestamp: ts,
        images: extractImages(msg),
        errorText: extractErrorText(msg),
        mentions: mentions.length > 0 ? mentions : undefined,
        metadata: {
          agentId: typeof m.agentId === "string" ? m.agentId : undefined,
          jobName: typeof m.jobName === "string" ? m.jobName : undefined,
          provider: typeof m.provider === "string" ? m.provider : undefined,
          modelId: typeof m.modelId === "string" ? m.modelId : undefined,
          sessionId: typeof m.sessionId === "string" ? m.sessionId : undefined,
          startTimestamp: typeof m.startTimestamp === "string" ? m.startTimestamp : undefined,
          timestamp: typeof m.timestamp === "string" ? m.timestamp : undefined,
          endTimestamp: typeof m.endTimestamp === "string" ? m.endTimestamp : undefined,
          // Token + cache usage. Two sources, in priority order:
          //
          //   1. The persisted `metadata.usage` field (set by the chat
          //      handler just before append). Available on reload and
          //      after the turn has fully settled.
          //   2. A `data-usage` part emitted from streamText.onFinish.
          //      Streamed during the live turn so the UsageBadge can
          //      render before the first reload.
          //
          // The data-part path lets the UI update without waiting for
          // the SDK to re-fetch chat history; both paths produce the
          // same shape, so the UsageBadge consumes either uniformly.
          usage: extractTurnUsage(msg, m),
        },
      };
      if (!isTail) {
        displayCache.set(msg, { sig, result });
      }
      return result;
    });
    return chatMsgs;
  });

  /**
   * Trigger a chat export. Uses `fetch` + Blob + a programmatic anchor
   * click rather than `window.location.href = …` so non-2xx responses
   * (413 over the message/byte cap, 504 timeout, 502 daemon failure)
   * surface as a toast instead of dropping the user on a raw JSON page
   * with no way back.
   *
   * The download filename comes from the response's
   * `content-disposition: attachment; filename="…"` header so the
   * orchestrator stays the source of truth for naming. Falls back to a
   * chatId-derived name if the header is missing.
   */
  let exportInFlight = $state(false);
  async function handleExportChat(): Promise<void> {
    if (exportInFlight) return;
    exportInFlight = true;
    // Outer try/finally guarantees `exportInFlight` is cleared on EVERY
    // exit path — early returns, thrown errors, blob-read failures. A
    // sticky in-flight rune leaves the button permanently disabled until
    // page reload, which is worse than a stale toast.
    try {
      const url = `/api/export/${encodeURIComponent(wsId)}/${encodeURIComponent(chatId)}`;

      let res: Response;
      try {
        res = await fetch(url);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast({ title: "Export failed", description: msg, error: true });
        return;
      }

      if (!res.ok) {
        // Try to surface the structured error body the orchestrator/daemon
        // returns ({error, payloadBytes, limit} for 413, {error} for 504/502).
        // Fall back to status text if the body isn't JSON.
        let description = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: unknown };
          if (typeof body.error === "string" && body.error.length > 0) {
            description = body.error;
          }
        } catch {
          // body wasn't JSON — keep the HTTP fallback
        }
        toast({ title: "Export failed", description, error: true });
        return;
      }

      let blob: Blob;
      try {
        blob = await res.blob();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        toast({ title: "Export failed", description: msg, error: true });
        return;
      }

      const objectUrl = URL.createObjectURL(blob);
      try {
        const cd = res.headers.get("content-disposition") ?? "";
        const filename =
          /filename="?([^"]+)"?/.exec(cd)?.[1] ?? `friday-chat-${chatId.slice(0, 8)}.zip`;
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      } finally {
        URL.revokeObjectURL(objectUrl);
      }
    } finally {
      exportInFlight = false;
    }
  }

  async function handleSubmit(
    text: string,
    attachments: ChatAttachment[] = [],
    mentions: InsertedMention[] = [],
  ) {
    if (!chat) return;
    error = null;
    wasInterrupted = false;

    const parts: QueuedMessageParts = [];

    if (text.length > 0) {
      parts.push({ type: "text", text });
    }

    // Images keep their existing data-URL `file` part path — that's
    // recognized by the provider as a vision input without a tool roundtrip.
    for (const att of attachments) {
      if (att.kind === "image") {
        parts.push({
          type: "file",
          mediaType: att.file.type || "image/png",
          url: att.dataUrl,
          filename: att.file.name,
        });
      }
    }

    // Ship a data-mention-resolved part per autocomplete-picked mention so
    // the optimistic user bubble renders the link with the friendly title
    // immediately — the server resolver runs ahead of persist and
    // overwrites these placeholders with the canonical snapshot
    // (mention-resolver.applyMentionsToMessage dedupes on workspaceId+chatId).
    for (const m of mentions) {
      parts.push({
        type: "data-mention-resolved",
        data: {
          workspaceId: m.workspaceId,
          chatId: m.chatId,
          title: m.title,
          snapshot: "",
          messageCount: 0,
          generatedAt: new Date().toISOString(),
        },
      });
    }

    // Non-image attachments uploaded to scratch. The chat-input's
    // `hasContent` gate blocks send while any upload is still in flight,
    // so by the time we get here `status === "ready"` and `path` is set
    // — but `filter` keeps the runtime defensive against future drift.
    const readyFiles = attachments.filter(
      (a): a is FileAttachment & { path: string } =>
        a.kind === "file" && a.status === "ready" && typeof a.path === "string",
    );
    if (readyFiles.length > 0) {
      parts.push({
        type: "data-file-attached",
        data: {
          paths: readyFiles.map((a) => a.path),
          filenames: readyFiles.map((a) => a.file.name),
          mimeTypes: readyFiles.map((a) => a.mediaType),
        },
      });
    }

    if (parts.length === 0) return;

    // Queue while the current turn is still streaming; the flush effect
    // fires the next turn as soon as status returns to ready. Resetting
    // resume state here would zero the in-flight cursor and force the
    // next Chrome drop into a duplicating full replay — only reset on
    // the actual turn-start path below.
    if (streaming) {
      queuedMessages = [...queuedMessages, parts];
      return;
    }

    resetResumeState();
    void chat.sendMessage({
      role: "user",
      parts,
      metadata: { timestamp: new Date().toISOString() },
    });
  }

  /**
   * Tracks recent credential-linked sends per provider to deduplicate rapid-fire
   * callbacks from multiple connect-service cards for the same provider.
   */
  const recentlyLinked = new Map<string, number>();

  /**
   * Called when the user successfully connects a credential via an inline
   * connect_service card. Sends a lightweight user message so the agent
   * retries on its next turn — the agent re-fetches credential status via
   * `list_integrations` / `describe_integration` on demand.
   */
  function handleCredentialConnected(provider: string): void {
    if (!chat) return;
    const now = Date.now();
    const last = recentlyLinked.get(provider);
    if (last !== undefined && now - last < 5000) return;
    recentlyLinked.set(provider, now);

    const parts: QueuedMessageParts = [
      { type: "data-credential-linked", data: { provider, displayName: provider } },
    ];
    if (streaming) {
      queuedMessages = [...queuedMessages, parts];
      return;
    }
    resetResumeState();
    void chat.sendMessage({
      role: "user",
      parts,
      metadata: { timestamp: new Date().toISOString() },
    });
  }

  /**
   * Called when the user confirms an inline env_set elicitation. Pushes a
   * synthetic `data-env-applied` user message so the agent resumes without
   * the user having to type anything. Mirrors `handleCredentialConnected`.
   *
   * Renders client-side as a right-aligned "Set N variable(s)" pill (see
   * `chat-message-list.svelte`'s env-applied branch), not as a blue user
   * bubble. The agent still receives the structured signal as text via
   * `convertDataPart` server-side.
   */
  function handleEnvApplied(info: { scope: "workspace" | "global"; keys: string[] }): void {
    if (!chat) return;
    const parts: QueuedMessageParts = [
      { type: "data-env-applied", data: { scope: info.scope, keys: info.keys } },
    ];
    if (streaming) {
      queuedMessages = [...queuedMessages, parts];
      return;
    }
    resetResumeState();
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
    "delete_workspace",
    "publish_draft",
    "upsert_agent",
    "upsert_signal",
    "upsert_job",
    "delete_agent",
    "delete_signal",
    "delete_job",
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
      for (const seg of msg.segments) {
        if (seg.type === "tool-burst") {
          scanForInvalidation(seg.calls);
        }
      }
    }
  });
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div
  class="user-chat"
  class:chat-drag-over={chatDragOver}
  class:fullscreen
  ondrop={handleChatDrop}
  ondragenter={handleChatDragEnter}
  ondragover={handleChatDragOver}
  ondragleave={handleChatDragLeave}
  role="presentation"
>
  {#if chatDragOver}
    <div class="drop-overlay">
      <span>Drop file here</span>
    </div>
  {/if}


  {#if chat && chat.messages.length > 0}
    <header class="chat-header">
      <!-- Session stats sit at the leading edge of the header; the
           Export button auto-pushes to the trailing edge via its own
           `margin-inline-start: auto`. When the chat has no recorded
           usage yet (legacy chats from before the metric existed),
           `ChatSessionUsage` renders nothing and the button sits alone
           against the leading edge — wrapping in `header-spacer` would
           waste a flex item for the same effect. -->
      <ChatSessionUsage messages={displayedMessages} />
      <button
        class="icon-button"
        type="button"
        onclick={handleExportChat}
        disabled={exportInFlight}
        aria-label={exportInFlight ? "Exporting chat…" : "Export chat"}
        title={exportInFlight ? "Exporting…" : "Export chat"}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 2v8m-4-4 4 4 4-4M3 14h10"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
      <button
        class="icon-button"
        type="button"
        onclick={() => (fullscreen = !fullscreen)}
        aria-label={`${fullscreen ? "Exit" : "Enter"} fullscreen (Ctrl+F)`}
        aria-pressed={fullscreen}
        title={`${fullscreen ? "Exit" : "Enter"} fullscreen (Ctrl+F)`}
      >
        {#if fullscreen}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M10 2v3a1 1 0 0 0 1 1h3M6 14v-3a1 1 0 0 0-1-1H2M14 6h-3a1 1 0 0 1-1-1V2M2 10h3a1 1 0 0 1 1 1v3"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        {:else}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M2 6V3a1 1 0 0 1 1-1h3M14 6V3a1 1 0 0 0-1-1h-3M2 10v3a1 1 0 0 0 1 1h3M14 10v3a1 1 0 0 1-1 1h-3"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        {/if}
      </button>
    </header>
  {/if}

  <div class="chat-body">
    <div class="chat-main">
      {#if rehydrating}
        <div class="rehydrating-indicator">Loading conversation...</div>
      {/if}

      <ChatMessageList
        messages={displayedMessages}
        onCredentialConnected={handleCredentialConnected}
        onEnvApplied={handleEnvApplied}
        {thinking}
        workspaceId={wsId}
        {chatId}
        {unsettledMessageId}
      />

      {#if wasInterrupted}
        <div class="interrupted-banner" role="status">
          Response was interrupted.
          <button
            class="interrupted-retry"
            onclick={() => {
              wasInterrupted = false;
              const lastUser = displayedMessages.findLast((m) => m.role === "user");
              const lastText = lastUser?.segments
                ?.filter((s): s is { type: "text"; content: string } => s.type === "text")
                .map((s) => s.content)
                .join("");
              if (lastText) void handleSubmit(lastText);
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
        {#key chatId}
          <ChatInput
            workspaceId={wsId}
            {chatId}
            onsubmit={handleSubmit}
            bind:attachments={inputAttachments}
            {streaming}
            {stopping}
            onstop={handleStop}
            {ttsEnabled}
            onttsToggle={ttsSupported ? toggleTts : undefined}
          />
        {/key}
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

  .chat-header {
    align-items: center;
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    flex-shrink: 0;
    gap: var(--size-2);
    padding: var(--size-2) var(--size-4);
  }

  .icon-button {
    align-items: center;
    background: none;
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-1);
    color: inherit;
    cursor: pointer;
    display: inline-flex;
    justify-content: center;
    padding: var(--size-1);
  }

  /* The first .icon-button after .session-usage pushes itself (and any
     siblings) to the trailing edge. Replaces the role .new-chat-button
     used to play when the export button was a text pill. */
  .icon-button:first-of-type {
    margin-inline-start: auto;
  }

  .icon-button:hover:not(:disabled) {
    background-color: color-mix(in srgb, var(--color-text), transparent 95%);
  }

  .icon-button:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  /* Fullscreen mode: lift the chat surface out of its ListDetail slot
     to cover the sidebar and any surrounding chrome. Ctrl+F toggles,
     Esc exits — the keydown handler at the top of the component owns
     both. The box-shadow paints a `--surface-dark` slab outside the
     chat so the gap doesn't leak the underlying sidebar / header
     chrome through. */
  .user-chat.fullscreen {
    background: var(--surface);
    border-radius: var(--radius-7);
    box-shadow: 0 0 0 100vmax var(--surface-dark);
    inset: var(--size-1-5);
    overflow: hidden;
    position: fixed;
    z-index: 100;
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

</style>
