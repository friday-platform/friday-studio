<script lang="ts">
  import { Chat as ChatImpl } from "@ai-sdk/svelte";
  import type { AtlasUIMessage } from "@atlas/agent-sdk";
  import { GA4, trackApiError, trackEvent, trackNetworkError } from "@atlas/analytics/ga4";
  import { client, parseResult } from "@atlas/client/v2";
  import type { ArtifactWithContents } from "@atlas/core/artifacts";
  import { getAtlasDaemonUrl } from "@atlas/oapi-client";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { afterNavigate, beforeNavigate } from "$app/navigation";
  import {
    ConversationState,
    setConversationContext,
  } from "$lib/modules/conversation/context.svelte";
  import { getDatetimeContext } from "$lib/utils/date";
  import { DefaultChatTransport } from "ai";
  import type { Snippet } from "svelte";
  import { onMount, setContext } from "svelte";

  /**
   * Headless chat provider — owns all functional concerns (transport, Chat
   * instance, navigation guards, reconnection, analytics) and exposes state
   * to children via Svelte context. No DOM output.
   */

  interface Props {
    chatId: string;
    initialMessages: AtlasUIMessage[];
    artifacts: Map<string, ArtifactWithContents>;
    isNew: boolean;
    onPostSuccess?: (chatId: string) => void;
    children: Snippet<[ConversationState]>;
  }

  const { chatId, initialMessages, artifacts, isNew, onPostSuccess, children }: Props = $props();

  // Expose artifacts map to child components via context
  const ARTIFACTS_KEY = Symbol.for("artifacts");
  setContext(ARTIFACTS_KEY, artifacts);

  const queryClient = useQueryClient();

  // Track whether we've already updated the URL for this new chat
  let hasUpdatedUrl = $state(false);

  // AbortController for resumeStream GET requests. The ai-sdk doesn't pass
  // abortSignal to reconnectToStream, so we inject it via our fetch wrapper.
  // This prevents connection leaks when navigating away during stream resume.
  let resumeAbortController = $state<AbortController | null>(null);

  // Server-provided turn start timestamp for accurate timer display after refresh
  let turnStartedAt = $state<number | null>(null);

  // Track stream timing for analytics
  let streamStartTime = $state<number | null>(null);
  let previousStatus = $state<string | null>(null);

  // Controls visibility — starts false, set to true via setTimeout for CSS transition
  let ready = $state(false);

  const transport = $derived(
    new DefaultChatTransport({
      api: `${getAtlasDaemonUrl()}/api/chat`,
      /**
       * Custom fetch wrapper that:
       * 1. Calls onPostSuccess when new chat is created (POST succeeds)
       * 2. Injects AbortSignal into GET requests (resumeStream) since ai-sdk
       *    doesn't pass one, causing connection leaks on navigation
       */
      fetch: async (url, init): Promise<globalThis.Response> => {
        // Clear stale timestamp at start of new request so Progress mounts fresh
        if (init?.method === "POST") {
          turnStartedAt = null;
        }

        // For GET requests (resumeStream), inject our abort controller's signal
        // since ai-sdk's reconnectToStream doesn't pass abortSignal to fetch
        if (init?.method === "GET" || !init?.method) {
          resumeAbortController = new AbortController();
          init = { ...init, signal: resumeAbortController.signal };
        }

        let response: globalThis.Response;
        try {
          response = await fetch(url, init);
        } catch (error) {
          // Track network errors (connection failures, timeouts, etc.)
          const message = error instanceof Error ? error.message : "Network error";
          // Don't track aborted requests (user navigated away)
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            trackNetworkError(String(url), message, init?.method ?? "GET");
          }
          throw error;
        }

        // Track API errors (non-2xx responses)
        if (!response.ok) {
          const errorText = await response
            .clone()
            .text()
            .catch(() => "Unknown error");
          trackApiError(String(url), response.status, errorText, init?.method ?? "GET");
        }

        // Capture server-provided turn start time for accurate timer display
        const startedAt = response.headers.get("X-Turn-Started-At");
        if (startedAt) {
          turnStartedAt = parseInt(startedAt, 10);
        }

        // Refresh sidebar on every successful message (chat's updatedAt changes)
        if (init?.method === "POST" && response.ok) {
          queryClient.invalidateQueries({ queryKey: ["chats"], refetchType: "all" });
          if (!hasUpdatedUrl) {
            hasUpdatedUrl = true;
            onPostSuccess?.(chatId);
          }
        }

        return response;
      },
      prepareSendMessagesRequest({ messages, id }) {
        return { body: { message: messages.at(-1), id, datetime: getDatetimeContext() } };
      },
    }),
  );

  // Create Chat instance — chatId is immutable for this component's lifetime
  const chat = $derived(
    new ChatImpl<AtlasUIMessage>({ id: chatId, messages: initialMessages, transport }),
  );

  $effect(() => {
    if (isNew) {
      hasUpdatedUrl = false;
    }
  });

  // Track streaming lifecycle for analytics
  $effect(() => {
    const currentStatus = chat.status;

    // Stream started
    if (
      (currentStatus === "streaming" || currentStatus === "submitted") &&
      previousStatus !== "streaming" &&
      previousStatus !== "submitted"
    ) {
      streamStartTime = Date.now();
      trackEvent(GA4.STREAM_START, { chat_id: chatId });
    }

    // Stream completed successfully
    if (
      currentStatus === "ready" &&
      (previousStatus === "streaming" || previousStatus === "submitted")
    ) {
      const duration = streamStartTime ? Date.now() - streamStartTime : 0;
      const messageCount = chat.messages?.length ?? 0;
      trackEvent(GA4.STREAM_COMPLETE, { chat_id: chatId, message_count: messageCount, duration });
      streamStartTime = null;
    }

    // Stream errored
    if (
      currentStatus === "error" &&
      (previousStatus === "streaming" || previousStatus === "submitted")
    ) {
      trackEvent(GA4.STREAM_ERROR, {
        chat_id: chatId,
        error_message: chat.error?.message ?? "Unknown error",
      });
      streamStartTime = null;
    }

    previousStatus = currentStatus;
  });

  function setup() {
    ready = false;
    setTimeout(() => {
      ready = true;
    }, 100);
  }

  async function reconnect() {
    // Resume any active stream for existing chats (initial load)
    if (!isNew) {
      try {
        await chat.resumeStream();
      } catch {
        // No active stream to resume - that's expected
      }
    }

    // Handle OAuth return flow
    const url = new URL(window.location.href);
    const credentialId = url.searchParams.get("credential_id");

    if (credentialId) {
      try {
        const result = await parseResult(
          client.link.v1.credentials[":id"].$get({ param: { id: credentialId } }),
        );

        if (result.ok) {
          const { provider } = result.data;
          chat.sendMessage({
            parts: [{ type: "data-credential-linked", data: { provider, displayName: provider } }],
          });
        }
      } catch (error) {
        console.error("Failed to fetch credential details:", error);
      } finally {
        // Clean URL params
        url.searchParams.delete("credential_id");
        window.history.replaceState({}, "", url.toString());
      }
    }
  }

  beforeNavigate((navigation) => {
    if (navigation.type === "goto") return;
    ready = false;
    // Abort active stream to free HTTP connection for the new page's loader.
    // Without this, browser connection limits (6 per origin in HTTP/1.1) cause
    // the navigation to block until the stream completes.
    chat.stop();
    // Also abort any pending resumeStream GET request (ai-sdk doesn't handle this)
    resumeAbortController?.abort();
    resumeAbortController = null;
  });

  afterNavigate(() => {
    setup();
    reconnect();
  });

  // Handle OAuth return flow on initial mount
  onMount(() => {
    setup();
    reconnect();
  });

  /**
   * Stop handler - calls DELETE endpoint to abort server-side stream, then stops client
   */
  async function handleStop() {
    trackEvent(GA4.STREAM_STOP);
    await fetch(`${getAtlasDaemonUrl()}/api/chat/${chatId}/stream`, { method: "DELETE" }).catch(
      () => {},
    );
    chat.stop();
  }

  // Expose all chat state to children via context (reactive getters)
  const context = setConversationContext({
    get chatId() {
      return chatId;
    },
    get chat() {
      return chat;
    },
    handleStop,
    get ready() {
      return ready;
    },
  });

  // Sync server-provided timestamp from fetch wrapper to context
  $effect(() => {
    context.turnStartedAt = turnStartedAt;
  });
</script>

{@render children(context)}
