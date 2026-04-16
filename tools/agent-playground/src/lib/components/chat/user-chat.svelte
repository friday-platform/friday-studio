<script lang="ts">
  import { Chat as ChatImpl } from "@ai-sdk/svelte";
  import type { AtlasUIMessage } from "@atlas/agent-sdk";
  import { createQuery } from "@tanstack/svelte-query";
  import { DefaultChatTransport } from "ai";
  import { page } from "$app/state";
  import { onMount } from "svelte";
  import {
    buildBacklogEntry,
    expandScheduleInput,
    parseScheduleCommand,
    submitBacklogEntry,
  } from "$lib/scheduling/fast-task-scheduler";
  import { workspaceQueries } from "$lib/queries";
  import ChatInput, { type ImageAttachment } from "./chat-input.svelte";
  import ChatInspector from "./chat-inspector.svelte";

  const wsId = $derived(page.params.workspaceId ?? "user");
  const configQuery = createQuery(() => workspaceQueries.config(wsId));
  const workspaceName = $derived(
    (configQuery.data?.config?.workspace as Record<string, unknown> | undefined)?.name as string | undefined
      ?? wsId,
  );

  let inspectorOpen = $state(false);

  function handleGlobalKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "i") {
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
    if (e.currentTarget instanceof HTMLElement && !e.currentTarget.contains(e.relatedTarget as Node)) {
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
  import ChatMessageList from "./chat-message-list.svelte";
  import type { ChatMessage, ImageDisplay, ScheduleProposal, ToolCallDisplay } from "./types";
  import { GetChatResponseSchema } from "./types";

  /**
   * Playground chat wired to the `user` workspace via `@ai-sdk/svelte`'s
   * {@link ChatImpl} and {@link DefaultChatTransport}. This component is the
   * thin playground equivalent of `apps/web-client`'s chat-provider, without
   * the production concerns (X-Turn-Started-At timer, GA4 analytics,
   * OAuth return flow, query-client sidebar invalidation, resume-stream
   * abort wiring). It reuses the same backend contract:
   *
   *   - `POST /api/workspaces/user/chat`  — first and follow-up turns
   *   - `GET  /api/workspaces/user/chat/:chatId` — rehydrate on mount
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
   */
  const CHAT_API = "/api/daemon/api/workspaces/user/chat";
  const STORAGE_KEY = "playground:lastChatId";

  // Chat identity. Initialized on mount: rehydrate from localStorage if a
  // persisted chatId exists, otherwise generate a fresh UUID. `ChatImpl` is
  // re-derived when chatId changes (e.g. "New Chat" button, rehydration).
  let chatId: string = $state("");
  let initialMessages: AtlasUIMessage[] = $state([]);
  let rehydrationDone = $state(false);
  let rehydrating = $state(false);

  /**
   * Parallel "local event stream" for playground-specific UI that doesn't
   * originate from the Chat instance: `/schedule` proposal cards, confirm/
   * cancel toasts, and expansion progress messages. Rendered after
   * `chat.messages` in the message list so proposals always appear at the
   * bottom of the thread while they're live.
   */
  let localEvents: ChatMessage[] = $state([]);
  let error: string | null = $state(null);

  function persistChatId(id: string) {
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // localStorage may be unavailable (private mode, quota)
    }
  }

  function clearPersistedChatId() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore
    }
  }

  function getPersistedChatId(): string | null {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

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
      if (!navigator.geolocation) { resolve(); return; }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          cachedLocation = {
            latitude: pos.coords.latitude.toFixed(4),
            longitude: pos.coords.longitude.toFixed(4),
          };
          resolve();
        },
        () => { resolve(); },
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
   * Rehydrate chat state from the backend using a persisted chatId.
   * On 404 (chat deleted) clears localStorage and starts fresh.
   * Network errors are silent so the caller can retry with a new chatId.
   */
  async function rehydrateChat(id: string): Promise<void> {
    rehydrating = true;
    try {
      const response = await fetch(`${CHAT_API}/${encodeURIComponent(id)}`);
      if (!response.ok) {
        if (response.status === 404) clearPersistedChatId();
        return;
      }
      const json: unknown = await response.json();
      const parsed = GetChatResponseSchema.safeParse(json);
      if (!parsed.success) {
        clearPersistedChatId();
        return;
      }

      // The server returns AI SDK v6 UIMessage-shaped entries (parts array);
      // parse them defensively into AtlasUIMessage[].
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
          rehydrated.push(msg as unknown as AtlasUIMessage);
        }
      }

      chatId = parsed.data.chat.id;
      initialMessages = rehydrated;
      systemPromptContext = parsed.data.systemPromptContext ?? null;
    } catch {
      // Silent — server might be temporarily down; the user can still send
      // a fresh message to start a new chat.
    } finally {
      rehydrating = false;
    }
  }

  onMount(async () => {
    // Request geolocation eagerly — browser caches the permission, so
    // subsequent calls are instant. Doing it on mount means the first
    // message already has coordinates without waiting for the prompt.
    void requestLocation();

    const saved = getPersistedChatId();
    if (saved) {
      await rehydrateChat(saved);
    }
    if (!chatId) {
      chatId = crypto.randomUUID();
    }
    rehydrationDone = true;
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
        return {
          body: {
            id,
            message: msgs.at(-1),
            datetime: buildDatetime(),
          },
        };
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

  // Persist chatId once the Chat instance has any messages (first turn
  // succeeded). Clears on "New Chat" which resets chatId.
  $effect(() => {
    if (chat && chat.messages.length > 0 && chatId.length > 0) {
      persistChatId(chatId);
    }
  });

  // Propagate transport / Chat errors into the playground error banner.
  $effect(() => {
    if (chat?.error) {
      error = chat.error.message;
    }
  });

  const streaming = $derived(chat?.status === "streaming" || chat?.status === "submitted");

  /**
   * Extract the text content of an {@link AtlasUIMessage} for render. We
   * concatenate all `{type: "text"}` parts and ignore data-event parts
   * (`data-artifact-attached`, etc.) since the playground message list
   * doesn't render those — it's a minimal UI.
   */
  function extractText(msg: AtlasUIMessage): string {
    if (!Array.isArray(msg.parts)) return "";
    return msg.parts
      .filter(
        (p): p is { type: "text"; text: string } =>
          typeof p === "object" &&
          p !== null &&
          "type" in p &&
          p.type === "text" &&
          "text" in p &&
          typeof p.text === "string",
      )
      .map((p) => p.text)
      .join("");
  }

  /**
   * Extract tool-call parts from an {@link AtlasUIMessage} in stream order.
   *
   * AI SDK v6 emits one part per tool invocation, typed either as
   * `tool-<name>` (static tools — our `web_fetch`, `run_code`, etc. are
   * registered this way via `createWebFetchTool` / `createRunCodeTool`) or
   * as `dynamic-tool` (runtime-resolved). Both carry `toolCallId`, `state`,
   * `input`, and — on success — `output`. We flatten both shapes into
   * {@link ToolCallDisplay} so the message list can render them as status
   * cards without caring about the static/dynamic distinction.
   *
   * Without this extraction, tool activity was invisible: the user would
   * see a long pause between "Friday" and the final text reply while
   * web_fetch / run_code ran in the background.
   */
  function extractToolCalls(msg: AtlasUIMessage): ToolCallDisplay[] {
    if (!Array.isArray(msg.parts)) return [];
    const calls: ToolCallDisplay[] = [];
    for (const part of msg.parts) {
      if (typeof part !== "object" || part === null || !("type" in part)) continue;
      const type = (part as { type: unknown }).type;
      if (typeof type !== "string") continue;

      // Both static (`tool-<name>`) and dynamic (`dynamic-tool`) carry the
      // same shape of state / input / output / errorText / toolCallId
      // fields, so we cast via a common structural interface once we know
      // the part is a tool.
      const isStatic = type.startsWith("tool-");
      const isDynamic = type === "dynamic-tool";
      if (!isStatic && !isDynamic) continue;

      const tp = part as {
        type: string;
        toolCallId?: unknown;
        toolName?: unknown;
        state?: unknown;
        input?: unknown;
        output?: unknown;
        errorText?: unknown;
      };

      const toolCallId = typeof tp.toolCallId === "string" ? tp.toolCallId : "";
      const toolName = isDynamic
        ? typeof tp.toolName === "string"
          ? tp.toolName
          : "tool"
        : type.slice("tool-".length);
      const state = typeof tp.state === "string" ? tp.state : "input-streaming";

      calls.push({
        toolCallId,
        toolName,
        state: state as ToolCallDisplay["state"],
        input: tp.input,
        output: tp.output,
        errorText: typeof tp.errorText === "string" ? tp.errorText : undefined,
      });
    }
    return calls;
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

  function hasRenderableContent(msg: AtlasUIMessage): boolean {
    if (!Array.isArray(msg.parts)) return false;
    return msg.parts.some((p) => {
      if (typeof p !== "object" || p === null || !("type" in p)) return false;
      const t = (p as { type: unknown }).type;
      if (typeof t !== "string") return false;
      return (
        t === "text" || t === "file" || t === "reasoning" || t === "dynamic-tool" || t.startsWith("tool-")
      );
    });
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
    const chatMsgs: ChatMessage[] = chat
      ? chat.messages
          .filter((msg) => {
            if (msg.role !== "assistant") return true;
            return hasRenderableContent(msg);
          })
          .map((msg) => ({
            id: msg.id,
            role: msg.role === "user" ? "user" : msg.role === "system" ? "system" : "assistant",
            content: extractText(msg),
            timestamp: Date.now(),
            toolCalls: extractToolCalls(msg),
            images: extractImages(msg),
          }))
      : [];
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
      {
        id: thinkingId,
        role: "system",
        content: "Expanding task brief...",
        timestamp: Date.now(),
      },
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

  /** Reset to a fresh chat — clears persistence and starts a new chatId. */
  function startNewChat() {
    clearPersistedChatId();
    localEvents = [];
    initialMessages = [];
    chatId = crypto.randomUUID();
    error = null;
  }

  async function handleSubmit(text: string, inputImages: ImageAttachment[] = []) {
    if (streaming) return;

    // Request geolocation on first message (browser prompts once)
    await requestLocation();

    // Intercept /schedule slash-command before it reaches the chat agent.
    const scheduleCmd = parseScheduleCommand(text);
    if (scheduleCmd) {
      void handleScheduleCommand(scheduleCmd.input);
      return;
    }

    if (!chat) return;
    error = null;

    // Merge images from the input component + any dropped on the chat area
    const allImages = [...inputImages, ...pendingImages];
    pendingImages = [];

    const parts: Array<
      | { type: "text"; text: string }
      | { type: "file"; mediaType: string; url: string; filename?: string }
    > = [];

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

    void chat.sendMessage({
      role: "user",
      parts,
    });
  }
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
          <button onclick={() => { pendingImages = pendingImages.filter(i => i.id !== img.id); }} aria-label="Remove">✕</button>
        </div>
      {/each}
    </div>
  {/if}

  <header class="chat-header">
    <h2>Chat</h2>
    <span class="workspace-badge">{workspaceName}</span>
    <span class="header-spacer"></span>
    {#if chat && chat.messages.length > 0}
      <button class="new-chat-button" onclick={startNewChat} disabled={streaming}>
        New Chat
      </button>
    {/if}
    <button
      class="inspector-toggle"
      class:active={inspectorOpen}
      onclick={() => inspectorOpen = !inspectorOpen}
      aria-label="Toggle inspector"
    >
      <kbd>&#8984;&#8679;I</kbd>
    </button>
  </header>

  <div class="chat-body">
    <div class="chat-main">
      {#if rehydrating}
        <div class="rehydrating-indicator">Loading conversation...</div>
      {/if}

      <ChatMessageList messages={displayedMessages} onScheduleAction={handleScheduleAction} />

      {#if error}
        <div class="error-banner" role="alert">
          {error}
        </div>
      {/if}

      <div class="chat-input-area">
        <ChatInput disabled={streaming} onsubmit={handleSubmit} />
      </div>
    </div>

    <ChatInspector
      open={inspectorOpen}
      {chatId}
      messages={displayedMessages}
      {systemPromptContext}
      {workspaceName}
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

  .chat-header {
    align-items: center;
    background-color: var(--color-surface-1);
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

  .inspector-toggle {
    align-items: center;
    background: transparent;
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    cursor: pointer;
    display: flex;
    justify-content: center;
    padding: var(--size-0-5) var(--size-1-5);
    transition: all 100ms ease;
  }

  .inspector-toggle kbd {
    font-family: var(--font-family-sans);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-5);
    letter-spacing: 0.02em;
  }

  .inspector-toggle:hover {
    background-color: var(--color-surface-3);
    color: var(--color-text);
  }

  .inspector-toggle.active {
    background-color: var(--color-primary);
    border-color: var(--color-primary);
    color: white;
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
