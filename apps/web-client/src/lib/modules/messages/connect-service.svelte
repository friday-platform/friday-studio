<script lang="ts">
  import type { Chat } from "@ai-sdk/svelte";
  import type { AtlasUIMessage } from "@atlas/agent-sdk";
  import { client, parseResult } from "@atlas/client/v2";
  import { getAtlasDaemonUrl } from "@atlas/oapi-client";
  import Button from "$lib/components/button.svelte";
  import MarkdownContent from "$lib/components/primitives/markdown-content.svelte";
  import { z } from "zod";
  import LinkAuthModal from "./link-auth-modal.svelte";
  import MessageWrapper from "./wrapper.svelte";

  /** Schema for OAuth callback message from popup window */
  const OAuthCallbackMessageSchema = z.object({
    type: z.literal("oauth-callback"),
    credentialId: z.string(),
    provider: z.string(),
  });

  type Props = { provider: string; chat: Chat<AtlasUIMessage> };

  const { provider, chat }: Props = $props();

  let providerDetails = $state<{
    id: string;
    type: "oauth" | "apikey" | "app_install";
    displayName: string;
    description: string;
    setupInstructions?: string;
    secretSchema?: { required?: string[] };
  } | null>(null);
  let error = $state<string | null>(null);
  let popupBlocked = $state(false);

  $effect(() => {
    async function fetchProvider() {
      // Guard against empty provider (can happen during streaming before tool output is populated)
      if (!provider) {
        error = "No provider specified";
        return;
      }

      const result = await parseResult(
        client.link.v1.providers[":id"].$get({ param: { id: provider } }),
      );
      if (result.ok) {
        providerDetails = {
          id: result.data.id,
          type: result.data.type,
          displayName: result.data.displayName,
          description: result.data.description,
          setupInstructions: result.data.setupInstructions,
          secretSchema: result.data.secretSchema as { required?: string[] } | undefined,
        };
      } else {
        error = "Failed to load provider details";
      }
    }
    fetchProvider();
  });

  /**
   * Handle OAuth callback message from popup window.
   * Validates origin and message shape before processing.
   */
  function handleOAuthMessage(event: MessageEvent) {
    // Security: validate origin matches our app
    if (event.origin !== window.location.origin) {
      return;
    }

    const result = OAuthCallbackMessageSchema.safeParse(event.data);
    if (!result.success) {
      return;
    }

    // Only handle messages for our provider
    if (result.data.provider !== provider) {
      return;
    }

    // Clean up listener after successful callback
    removeMessageListener();

    // Send data part to continue the chat
    if (providerDetails) {
      chat.sendMessage({
        parts: [
          {
            type: "data-credential-linked",
            data: { provider: providerDetails.id, displayName: providerDetails.displayName },
          },
        ],
      });
    }
  }

  /**
   * Track whether we've added the message listener to avoid duplicates.
   */
  let messageListenerActive = false;

  /**
   * Add message listener if not already active.
   * Returns cleanup function.
   */
  function addMessageListener() {
    if (messageListenerActive) return;
    messageListenerActive = true;
    window.addEventListener("message", handleOAuthMessage);
  }

  /**
   * Remove message listener and reset tracking state.
   */
  function removeMessageListener() {
    if (!messageListenerActive) return;
    messageListenerActive = false;
    window.removeEventListener("message", handleOAuthMessage);
  }

  // Cleanup message listener on component destroy
  $effect(() => {
    return () => {
      removeMessageListener();
    };
  });

  function startOAuth() {
    popupBlocked = false;

    const daemonUrl = getAtlasDaemonUrl();
    const callbackUrl = new URL("/oauth/callback", window.location.origin);
    const url = new URL(`/api/link/v1/oauth/authorize/${provider}`, daemonUrl);
    url.searchParams.set("redirect_uri", callbackUrl.href);

    const width = 600;
    const height = 700;
    const left = Math.round(window.screenX + (window.outerWidth - width) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - height) / 2);
    const features = `width=${width},height=${height},left=${left},top=${top},popup=yes`;

    const popup = window.open(url.href, "oauth-popup", features);

    if (!popup || popup.closed) {
      popupBlocked = true;
      return;
    }

    addMessageListener();
  }

  /**
   * Fallback: navigate in same tab when popup is blocked for OAuth.
   */
  function startOAuthFallback() {
    const daemonUrl = getAtlasDaemonUrl();
    const url = new URL(`/api/link/v1/oauth/authorize/${provider}`, daemonUrl);
    url.searchParams.set("redirect_uri", window.location.href);
    window.location.href = url.href;
  }

  /**
   * Start OAuth app installation flow in a popup window.
   * Falls back to same-tab navigation if popup is blocked.
   */
  function startAppInstall() {
    popupBlocked = false;

    const daemonUrl = getAtlasDaemonUrl();
    const callbackUrl = new URL("/oauth/callback", window.location.origin);
    const url = new URL(`/api/link/v1/app-install/${provider}/authorize`, daemonUrl);
    url.searchParams.set("redirect_uri", callbackUrl.href);

    // Open popup centered on screen
    const width = 600;
    const height = 700;
    const left = Math.round(window.screenX + (window.outerWidth - width) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - height) / 2);
    const features = `width=${width},height=${height},left=${left},top=${top},popup=yes`;

    const popup = window.open(url.href, "oauth-popup", features);

    if (!popup || popup.closed) {
      // Popup was blocked - fall back to same-tab navigation
      popupBlocked = true;
      return;
    }

    // Add message listener for callback (idempotent)
    addMessageListener();
  }

  /**
   * Fallback: navigate in same tab when popup is blocked.
   */
  function startAppInstallFallback() {
    const daemonUrl = getAtlasDaemonUrl();
    const url = new URL(`/api/link/v1/app-install/${provider}/authorize`, daemonUrl);
    url.searchParams.set("redirect_uri", window.location.href);
    window.location.href = url.href;
  }

  function handleModalSuccess() {
    if (providerDetails) {
      chat.sendMessage({
        parts: [
          {
            type: "data-credential-linked",
            data: { provider: providerDetails.id, displayName: providerDetails.displayName },
          },
        ],
      });
    }
  }
</script>

<MessageWrapper>
  {#if error}
    <div class="link-auth-error">
      <p>{error}</p>
    </div>
  {:else if providerDetails}
    <div class="link-auth-request">
      <div class="header">
        <h3>Connect {providerDetails.displayName}</h3>
        <p class="description">{providerDetails.description}</p>
      </div>
      {#if providerDetails.type === "oauth"}
        <Button onclick={startOAuth}>
          Connect {providerDetails.displayName}
        </Button>
        {#if popupBlocked}
          <div class="popup-blocked">
            <p>Popup was blocked by your browser.</p>
            <button class="fallback-link" onclick={startOAuthFallback}>
              Continue in this tab instead
            </button>
          </div>
        {/if}
      {:else if providerDetails.type === "app_install"}
        {#if providerDetails.setupInstructions}
          <div class="instructions">
            <MarkdownContent content={providerDetails.setupInstructions} />
          </div>
        {/if}
        <Button onclick={startAppInstall}>
          Install {providerDetails.displayName}
        </Button>
        {#if popupBlocked}
          <div class="popup-blocked">
            <p>Popup was blocked by your browser.</p>
            <button class="fallback-link" onclick={startAppInstallFallback}>
              Continue in this tab instead
            </button>
          </div>
        {/if}
      {:else if providerDetails.type === "apikey" && providerDetails.secretSchema?.required?.[0]}
        {#if providerDetails.setupInstructions}
          <div class="instructions">
            <MarkdownContent content={providerDetails.setupInstructions} />
          </div>
        {/if}
        <LinkAuthModal
          provider={providerDetails.id}
          displayName={providerDetails.displayName}
          secretFieldName={providerDetails.secretSchema.required[0]}
          onSuccess={handleModalSuccess}
        >
          {#snippet triggerContents()}
            <Button>
              Connect {providerDetails?.displayName}
            </Button>
          {/snippet}
        </LinkAuthModal>
      {:else if providerDetails.type === "apikey"}
        <p class="error">Provider missing secret schema</p>
      {:else}
        <Button disabled>
          Connect {providerDetails.displayName}
        </Button>
      {/if}
    </div>
  {:else}
    <div class="link-auth-loading">
      <p>Loading provider details...</p>
    </div>
  {/if}
</MessageWrapper>

<style>
  .link-auth-request {
    background-color: var(--color-surface-1);
    border-radius: var(--radius-4);
    border: var(--size-px) solid var(--color-border-1);
    padding: var(--size-4);
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--size-3);
  }

  .header {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
  }

  .header h3 {
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .description {
    font-size: var(--font-size-2);
    opacity: 0.7;
    margin: 0;
  }

  .link-auth-error,
  .link-auth-loading {
    font-size: var(--font-size-2);
    opacity: 0.7;
    padding: var(--size-3);
  }

  .link-auth-error {
    color: var(--color-red);
  }

  .popup-blocked {
    background-color: color-mix(in srgb, var(--color-surface-2), var(--color-text) 5%);
    border-radius: var(--radius-2);
    padding: var(--size-3);
    font-size: var(--font-size-2);
  }

  .popup-blocked p {
    margin: 0 0 var(--size-2) 0;
    opacity: 0.8;
  }

  .fallback-link {
    background: none;
    color: var(--color-yellow);
    cursor: pointer;
    font-size: var(--font-size-2);
    padding: 0;
    text-decoration: underline;
  }

  .fallback-link:hover {
    color: var(--color-text);
  }

  .instructions {
    background-color: var(--color-surface-1);
    border-radius: var(--radius-3);
    padding: var(--size-3);
    font-size: var(--font-size-2);
    max-inline-size: 100%;
    overflow-x: auto;
  }

  .instructions :global(h2) {
    font-size: var(--font-size-4);
    margin-block-end: var(--size-2);
  }

  .instructions :global(h3) {
    font-size: var(--font-size-3);
    margin-block-start: var(--size-3);
    margin-block-end: var(--size-1);
  }

  .instructions :global(p),
  .instructions :global(li) {
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-3);
  }

  .instructions :global(code) {
    font-size: var(--font-size-1);
  }
</style>
