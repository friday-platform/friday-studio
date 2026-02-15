<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { client, parseResult } from "@atlas/client/v2";
  import { getAtlasDaemonUrl } from "@atlas/oapi-client";
  import Button from "$lib/components/button.svelte";
  import { Dialog } from "$lib/components/dialog";
  import { Icons } from "$lib/components/icons";
  import { IconSmall } from "$lib/components/icons/small";
  import { getServiceIcon } from "$lib/modules/integrations/icons.svelte";
  import LinkAuthModal from "$lib/modules/messages/link-auth-modal.svelte";
  import { SvelteMap } from "svelte/reactivity";
  import type { Writable } from "svelte/store";
  import { z } from "zod";

  const SecretSchemaSchema = z.object({ required: z.array(z.string()).optional() }).optional();

  function parseSecretSchema(raw: unknown): { required?: string[] } | undefined {
    const result = SecretSchemaSchema.safeParse(raw);
    return result.success ? result.data : undefined;
  }

  function getApiKeyFieldName(provider: ProviderDetails): string | undefined {
    if (provider.secretSchema?.required?.[0]) return provider.secretSchema.required[0];
    const keys = providerKeys[provider.id];
    if (keys?.[0]) return keys[0];
    return undefined;
  }

  type ProviderStatus = "pending" | "connecting" | "connected";

  type ProviderDetails = {
    id: string;
    type: "oauth" | "apikey" | "app_install";
    displayName: string;
    description: string;
    setupInstructions?: string;
    secretSchema?: { required?: string[] };
    status: ProviderStatus;
    popupBlocked: boolean;
    notFound: boolean;
  };

  type Props = {
    missingProviders: string[];
    providerKeys: Record<string, string[]>;
    onComplete: () => void;
    open: Writable<boolean>;
    continueDisabled?: boolean;
  };

  const {
    missingProviders,
    providerKeys,
    onComplete,
    open,
    continueDisabled = false,
  }: Props = $props();

  /** Schema for OAuth callback message from popup window */
  const OAuthCallbackMessageSchema = z.object({
    type: z.literal("oauth-callback"),
    credentialId: z.string(),
    provider: z.string(),
  });

  let providers = new SvelteMap<string, ProviderDetails>();
  let loading = $state(true);

  const allConnected = $derived(
    providers.size > 0 && [...providers.values()].every((p) => p.status === "connected"),
  );

  async function loadProviders(providerIds: string[]) {
    loading = true;
    providers.clear();

    try {
      await Promise.all(
        providerIds.map(async (providerId) => {
          const result = await parseResult(
            client.link.v1.providers[":id"].$get({ param: { id: providerId } }),
          );

          if (result.ok) {
            providers.set(providerId, {
              id: result.data.id,
              type: result.data.type,
              displayName: result.data.displayName,
              description: result.data.description,
              setupInstructions: result.data.setupInstructions,
              secretSchema: parseSecretSchema(result.data.secretSchema),
              status: "pending",
              popupBlocked: false,
              notFound: false,
            });
          } else {
            // Provider not registered — auto-register as API key provider
            const keys = providerKeys[providerId] ?? ["access_token"];
            const secretSchema: Record<string, "string"> = {};
            for (const k of keys) {
              secretSchema[k] = "string";
            }

            const createResult = await parseResult(
              client.link.v1.providers.$post({
                json: {
                  provider: {
                    type: "apikey" as const,
                    id: providerId,
                    displayName: providerId.charAt(0).toUpperCase() + providerId.slice(1),
                    description: `Credentials for ${providerId}`,
                    secretSchema,
                  },
                },
              }),
            );

            if (createResult.ok) {
              // Re-fetch to get the full hydrated provider definition
              const refetch = await parseResult(
                client.link.v1.providers[":id"].$get({ param: { id: providerId } }),
              );
              if (refetch.ok) {
                providers.set(providerId, {
                  id: refetch.data.id,
                  type: refetch.data.type,
                  displayName: refetch.data.displayName,
                  description: refetch.data.description,
                  setupInstructions: refetch.data.setupInstructions,
                  secretSchema: parseSecretSchema(refetch.data.secretSchema),
                  status: "pending",
                  popupBlocked: false,
                  notFound: false,
                });
              }
            } else {
              // Registration failed — show not-found as fallback
              providers.set(providerId, {
                id: providerId,
                type: "apikey",
                displayName: providerId.charAt(0).toUpperCase() + providerId.slice(1),
                description: "",
                status: "pending",
                popupBlocked: false,
                notFound: true,
              });
            }
          }
        }),
      );
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    if (missingProviders.length === 0) return;
    loadProviders(missingProviders);
  });

  let messageListenerActive = false;

  function handleOAuthMessage(event: MessageEvent) {
    if (event.origin !== window.location.origin) return;

    const result = OAuthCallbackMessageSchema.safeParse(event.data);
    if (!result.success) return;

    markProviderConnected(result.data.provider);
  }

  function handleStorageEvent(event: StorageEvent) {
    if (event.key !== "oauth-callback" || !event.newValue) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(event.newValue);
    } catch {
      return;
    }

    const result = OAuthCallbackMessageSchema.safeParse(parsed);
    if (!result.success) return;

    localStorage.removeItem("oauth-callback");
    markProviderConnected(result.data.provider);
  }

  function addMessageListener() {
    if (messageListenerActive) return;
    messageListenerActive = true;
    window.addEventListener("message", handleOAuthMessage);
    window.addEventListener("storage", handleStorageEvent);
  }

  function removeMessageListener() {
    if (!messageListenerActive) return;
    messageListenerActive = false;
    window.removeEventListener("message", handleOAuthMessage);
    window.removeEventListener("storage", handleStorageEvent);
  }

  // Cleanup on destroy
  $effect(() => {
    return () => {
      removeMessageListener();
    };
  });

  function markProviderConnected(providerId: string) {
    const details = providers.get(providerId);
    if (!details) return;

    providers.set(providerId, { ...details, status: "connected" });

    trackEvent(GA4.CREDENTIAL_LINK_SUCCESS, { provider: providerId, type: details.type });
  }

  function startOAuth(provider: ProviderDetails) {
    trackEvent(GA4.CREDENTIAL_LINK_START, { provider: provider.id, type: "oauth" });

    const daemonUrl = getAtlasDaemonUrl();
    const callbackUrl = new URL("/oauth/callback", window.location.origin);
    const url = new URL(`/api/link/v1/oauth/authorize/${provider.id}`, daemonUrl);
    url.searchParams.set("redirect_uri", callbackUrl.href);

    openPopup(url.href, provider);
  }

  function startAppInstall(provider: ProviderDetails) {
    trackEvent(GA4.CREDENTIAL_LINK_START, { provider: provider.id, type: "app_install" });

    const daemonUrl = getAtlasDaemonUrl();
    const callbackUrl = new URL("/oauth/callback", window.location.origin);
    const url = new URL(`/api/link/v1/app-install/${provider.id}/authorize`, daemonUrl);
    url.searchParams.set("redirect_uri", callbackUrl.href);

    openPopup(url.href, provider);
  }

  function openPopup(url: string, provider: ProviderDetails) {
    const width = 600;
    const height = 700;
    const left = Math.round(window.screenX + (window.outerWidth - width) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - height) / 2);
    const features = `width=${width},height=${height},left=${left},top=${top},popup=yes`;

    const popup = window.open(url, "oauth-popup", features);

    if (!popup || popup.closed) {
      providers.set(provider.id, { ...provider, popupBlocked: true });
      return;
    }

    providers.set(provider.id, { ...provider, status: "connecting", popupBlocked: false });

    addMessageListener();
  }

  function startOAuthFallback(provider: ProviderDetails) {
    trackEvent(GA4.OAUTH_FALLBACK_CLICK, { provider: provider.id, type: "oauth" });
    const daemonUrl = getAtlasDaemonUrl();
    const url = new URL(`/api/link/v1/oauth/authorize/${provider.id}`, daemonUrl);
    url.searchParams.set("redirect_uri", window.location.href);
    window.location.href = url.href;
  }

  function startAppInstallFallback(provider: ProviderDetails) {
    trackEvent(GA4.APP_INSTALL_FALLBACK_CLICK, { provider: provider.id });
    const daemonUrl = getAtlasDaemonUrl();
    const url = new URL(`/api/link/v1/app-install/${provider.id}/authorize`, daemonUrl);
    url.searchParams.set("redirect_uri", window.location.href);
    window.location.href = url.href;
  }

  function handleApiKeySuccess(provider: ProviderDetails) {
    markProviderConnected(provider.id);
  }

  async function handleContinue() {
    await onComplete();
    // If retry surfaced new missing providers, keep the dialog open
    if (missingProviders.length === 0) {
      open.set(false);
    }
  }
</script>

<Dialog.Root
  {open}
  onOpenChange={({ next }) => {
    if (!next) {
      removeMessageListener();
    }
    return next;
  }}
>
  <Dialog.Content size="large">
    <Dialog.Close />

    {#snippet icon()}
      <span style:color="var(--color-yellow)">
        <Icons.Key />
      </span>
    {/snippet}

    {#snippet header()}
      <Dialog.Title>Missing Credentials</Dialog.Title>
      <Dialog.Description>
        <p>Connect the following integrations to add this Space.</p>
      </Dialog.Description>
    {/snippet}

    {#snippet footer()}
      {#if loading}
        <p class="loading">Loading providers...</p>
      {:else}
        <div class="providers">
          {#each [...providers.values()] as provider (provider.id)}
            {@const icon = getServiceIcon(provider.id)}
            <div class="provider-row">
              <div class="provider-info">
                {#if icon}
                  <div class="provider-icon">
                    {#if icon.type === "component"}
                      {@const Component = icon.src}
                      <Component />
                    {:else}
                      <img src={icon.src} alt={`${provider.displayName} logo`} />
                    {/if}
                  </div>
                {/if}
                <span class="provider-name">{provider.displayName}</span>
              </div>

              <div class="provider-action">
                {#if provider.notFound}
                  <span class="not-found-badge">Not found</span>
                {:else if provider.status === "connected"}
                  <span class="connected-badge">
                    <IconSmall.Check />
                    Connected
                  </span>
                {:else if provider.type === "apikey"}
                  {@const fieldName = getApiKeyFieldName(provider)}
                  {#if fieldName}
                    <LinkAuthModal
                      provider={provider.id}
                      displayName={provider.displayName}
                      secretFieldName={fieldName}
                      onSuccess={() => handleApiKeySuccess(provider)}
                    >
                      {#snippet triggerContents()}
                        <Button size="small">Connect</Button>
                      {/snippet}
                    </LinkAuthModal>
                  {:else}
                    <span class="not-found-badge">Missing key schema</span>
                  {/if}
                {:else if provider.type === "app_install"}
                  <Button size="small" onclick={() => startAppInstall(provider)}>Connect</Button>
                {:else}
                  <Button size="small" onclick={() => startOAuth(provider)}>Connect</Button>
                {/if}
              </div>

              {#if provider.popupBlocked}
                <div class="popup-blocked">
                  <p>Popup was blocked by your browser.</p>
                  <button
                    class="fallback-link"
                    onclick={() =>
                      provider.type === "app_install"
                        ? startAppInstallFallback(provider)
                        : startOAuthFallback(provider)}
                  >
                    Continue in this tab instead
                  </button>
                </div>
              {/if}
            </div>
          {/each}
        </div>

        {#if allConnected}
          <Dialog.Button closeOnClick={false} onclick={handleContinue} disabled={continueDisabled}>
            Continue
          </Dialog.Button>
        {/if}
        <Dialog.Cancel>Cancel</Dialog.Cancel>
      {/if}
    {/snippet}
  </Dialog.Content>
</Dialog.Root>

<style>
  .loading {
    font-size: var(--font-size-2);
    opacity: 0.7;
  }

  .providers {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    inline-size: 100%;
  }

  .provider-row {
    align-items: center;
    background-color: var(--color-surface-2);
    border-radius: var(--radius-3);
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-3);
    justify-content: space-between;
    padding: var(--size-3) var(--size-4);
  }

  .provider-info {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .provider-icon {
    flex-shrink: 0;

    & :global(svg),
    img {
      aspect-ratio: 1 / 1;
      inline-size: var(--size-4);
      object-fit: contain;
    }
  }

  .provider-name {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
  }

  .provider-action {
    flex-shrink: 0;
  }

  .connected-badge {
    align-items: center;
    color: var(--color-green);
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    gap: var(--size-1);
  }

  .not-found-badge {
    color: var(--color-red);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .popup-blocked {
    background-color: color-mix(in srgb, var(--color-surface-2), var(--color-text) 5%);
    border-radius: var(--radius-2);
    font-size: var(--font-size-2);
    inline-size: 100%;
    padding: var(--size-3);
  }

  .popup-blocked p {
    margin-block-end: var(--size-2);
    opacity: 0.8;
  }

  .fallback-link {
    background: none;
    border: none;
    color: var(--color-yellow);
    cursor: pointer;
    font-size: var(--font-size-2);
    padding: 0;
    text-decoration: underline;
  }

  .fallback-link:hover {
    color: var(--color-text);
  }
</style>
