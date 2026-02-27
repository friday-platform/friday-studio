<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { client, parseResult } from "@atlas/client/v2";
  import { getAtlasDaemonUrl } from "@atlas/oapi-client";
  import { createDialog } from "@melt-ui/svelte";
  import {
    createColumnHelper,
    createTable,
    getCoreRowModel,
    renderComponent,
  } from "@tanstack/svelte-table";
  import { invalidateAll } from "$app/navigation";
  import Button from "$lib/components/button.svelte";
  import { Table } from "$lib/components/table";
  import Logo from "$lib/modules/integrations/logo-column.svelte";
  import LinkAuthModal from "$lib/modules/messages/link-auth-modal.svelte";
  import { tick } from "svelte";
  import { fade } from "svelte/transition";
  import { z } from "zod";
  import type { PageData } from "../$types";
  import ConnectButtonCell from "./connect-button-cell.svelte";

  type Provider = PageData["providers"][number];

  type Props = { providers: Provider[] };

  let { providers }: Props = $props();

  let searchQuery = $state("");

  const {
    elements: { trigger, overlay, content, portalled, close, title },
    states: { open },
  } = createDialog({ forceVisible: true, portal: "body" });

  // Track which API key provider is being connected (rendered outside dialog)
  let apiKeyProvider = $state<{ id: string; displayName: string; secretFieldName: string } | null>(
    null,
  );

  let apiKeyTriggerEl = $state<HTMLElement | null>(null);

  const sortedProviders = $derived(
    [...providers].sort((a, b) => a.displayName.localeCompare(b.displayName)),
  );

  const filteredProviders = $derived(
    searchQuery.trim() === ""
      ? sortedProviders
      : sortedProviders.filter((p) =>
          p.displayName.toLowerCase().includes(searchQuery.toLowerCase()),
        ),
  );

  // --- Popup / OAuth / App Install logic (absorbed from connect-provider-cell) ---

  const OAuthCallbackMessageSchema = z.object({
    type: z.literal("oauth-callback"),
    credentialId: z.string(),
    provider: z.string(),
  });

  const SecretSchemaShape = z.object({ required: z.array(z.string()) }).partial();

  let popupBlocked = $state(false);
  let popupBlockedProviderId = $state<string | null>(null);
  let popupProviderType = $state<string | null>(null);

  function handleOAuthMessage(event: MessageEvent) {
    if (event.origin !== window.location.origin) return;

    const result = OAuthCallbackMessageSchema.safeParse(event.data);
    if (!result.success) return;

    completeFlow();
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
    completeFlow();
  }

  function completeFlow() {
    removeListeners();
    if (popupBlockedProviderId && popupProviderType) {
      trackEvent(GA4.CREDENTIAL_LINK_SUCCESS, {
        provider: popupBlockedProviderId,
        type: popupProviderType,
      });
    }
    popupBlocked = false;
    popupBlockedProviderId = null;
    popupProviderType = null;
    open.set(false);
    invalidateAll();
  }

  let listenersActive = false;

  function addListeners() {
    if (listenersActive) return;
    listenersActive = true;
    window.addEventListener("message", handleOAuthMessage);
    window.addEventListener("storage", handleStorageEvent);
  }

  function removeListeners() {
    if (!listenersActive) return;
    listenersActive = false;
    window.removeEventListener("message", handleOAuthMessage);
    window.removeEventListener("storage", handleStorageEvent);
  }

  $effect(() => {
    return () => removeListeners();
  });

  function openPopup(url: string) {
    popupBlocked = false;

    const width = 600;
    const height = 700;
    const left = Math.round(window.screenX + (window.outerWidth - width) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - height) / 2);
    const features = `width=${width},height=${height},left=${left},top=${top},popup=yes`;

    const popup = window.open(url, "oauth-popup", features);

    if (!popup || popup.closed) {
      popupBlocked = true;
      return;
    }

    addListeners();
  }

  function startOAuth(providerId: string) {
    trackEvent(GA4.CREDENTIAL_LINK_START, { provider: providerId, type: "oauth" });
    const daemonUrl = getAtlasDaemonUrl();
    const callbackUrl = new URL("/oauth/callback", window.location.origin);
    const url = new URL(`/api/link/v1/oauth/authorize/${providerId}`, daemonUrl);
    url.searchParams.set("redirect_uri", callbackUrl.href);
    openPopup(url.href);
  }

  function startAppInstall(providerId: string) {
    trackEvent(GA4.CREDENTIAL_LINK_START, { provider: providerId, type: "app_install" });
    const daemonUrl = getAtlasDaemonUrl();
    const callbackUrl = new URL("/oauth/callback", window.location.origin);
    const url = new URL(`/api/link/v1/app-install/${providerId}/authorize`, daemonUrl);
    url.searchParams.set("redirect_uri", callbackUrl.href);
    openPopup(url.href);
  }

  function startFallback(providerId: string, providerType: string) {
    const daemonUrl = getAtlasDaemonUrl();
    const isAppInstall = providerType === "app_install";
    const eventName = isAppInstall ? GA4.APP_INSTALL_FALLBACK_CLICK : GA4.OAUTH_FALLBACK_CLICK;
    trackEvent(eventName, { provider: providerId });

    const path = isAppInstall
      ? `/api/link/v1/app-install/${providerId}/authorize`
      : `/api/link/v1/oauth/authorize/${providerId}`;
    const url = new URL(path, daemonUrl);
    url.searchParams.set("redirect_uri", window.location.href);
    window.location.href = url.href;
  }

  async function startApiKey(provider: Provider) {
    const result = await parseResult(
      client.link.v1.providers[":id"].$get({ param: { id: provider.id } }),
    );
    if (!result.ok) return;

    const parsed = SecretSchemaShape.safeParse(result.data.secretSchema);
    const fieldName = parsed.success ? (parsed.data.required?.[0] ?? null) : null;
    if (!fieldName) return;

    apiKeyProvider = {
      id: provider.id,
      displayName: provider.displayName,
      secretFieldName: fieldName,
    };

    // Wait for LinkAuthModal to render, then programmatically click its trigger
    await tick();
    const triggerButton = apiKeyTriggerEl?.querySelector("button");
    triggerButton?.click();
  }

  function handleConnect(provider: Provider) {
    if (provider.type === "apikey") {
      startApiKey(provider);
      return;
    }

    popupBlockedProviderId = provider.id;
    popupProviderType = provider.type;

    if (provider.type === "oauth") {
      startOAuth(provider.id);
    } else if (provider.type === "app_install") {
      startAppInstall(provider.id);
    }
  }

  function handleApiKeySuccess() {
    const providerId = apiKeyProvider?.id ?? "";
    apiKeyProvider = null;
    trackEvent(GA4.CREDENTIAL_LINK_SUCCESS, { provider: providerId, type: "apikey" });
    open.set(false);
    invalidateAll();
  }

  // --- Table ---

  const columnHelper = createColumnHelper<Provider>();

  const dialogTable = createTable({
    get data() {
      return filteredProviders;
    },
    columns: [
      columnHelper.display({
        id: "provider_logo",
        header: "",
        cell: (info) => renderComponent(Logo, { provider: info.row.original.id, size: "small" }),
        meta: { shrink: true },
      }),
      columnHelper.display({
        id: "provider",
        header: "Provider",
        cell: (info) => info.row.original.displayName,
        meta: { bold: true },
      }),
      columnHelper.display({
        id: "actions",
        header: "",
        cell: (info) =>
          renderComponent(ConnectButtonCell, { onclick: () => handleConnect(info.row.original) }),
        meta: { shrink: true },
      }),
    ],
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  });
</script>

<button {...$trigger} use:trigger class="trigger">
  <Button noninteractive size="small">Add Integration</Button>
</button>

{#if $open}
  <div {...$portalled} use:portalled>
    <div {...$overlay} use:overlay class="overlay" transition:fade={{ duration: 200 }}></div>

    <div {...$content} use:content class="fullscreen-dialog" transition:fade={{ duration: 200 }}>
      <button
        {...$close}
        use:close
        class="close-dialog"
        aria-label="Close Provider List"
        transition:fade={{ duration: 200 }}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 11 11"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            opacity="0.5"
            d="M0.353516 0.353516L10.3535 10.3535M10.3535 0.353516L0.353516 10.3535"
            stroke="currentcolor"
          />
        </svg>
      </button>
      <h2 class="title" {...$title}>Add Integration</h2>

      <div class="table-area">
        <Table.Root table={dialogTable} hideHeader rowSize="medium" />
      </div>

      <div class="footer">
        <button {...$close} use:close class="dismiss">Close</button>
      </div>
    </div>
  </div>
{/if}

{#if popupBlocked && popupBlockedProviderId}
  <div class="popup-blocked">
    <p>Popup was blocked.</p>
    <button
      class="fallback-link"
      onclick={() => {
        const provider = providers.find((p) => p.id === popupBlockedProviderId);
        if (provider) startFallback(provider.id, provider.type);
      }}
    >
      Continue in this tab
    </button>
  </div>
{/if}

{#if apiKeyProvider}
  <div bind:this={apiKeyTriggerEl} class="api-key-trigger">
    <LinkAuthModal
      provider={apiKeyProvider.id}
      displayName={apiKeyProvider.displayName}
      secretFieldName={apiKeyProvider.secretFieldName}
      onSuccess={handleApiKeySuccess}
    >
      {#snippet triggerContents()}
        <span></span>
      {/snippet}
    </LinkAuthModal>
  </div>
{/if}

<style>
  .trigger {
    &:focus {
      outline: none;
    }
  }

  .overlay {
    background: radial-gradient(
      circle farthest-side at 50% 50%,
      var(--color-surface-1) 0%,
      color-mix(in srgb, var(--color-surface-1), transparent 10%) 100%
    );
    border-radius: var(--radius-5);
    inset: var(--size-2);
    inset-inline-start: calc(var(--size-56) + var(--size-2));
    position: fixed;
    z-index: var(--layer-4);
  }

  .fullscreen-dialog {
    align-items: center;
    border-radius: var(--radius-5);
    display: flex;
    flex-direction: column;
    inset: var(--size-2);
    inset-inline-start: calc(var(--size-56) + var(--size-2));
    overflow-y: auto;
    padding-block: 0;
    position: fixed;
    scrollbar-width: thin;
    text-align: center;
    z-index: var(--layer-5);
    overscroll-behavior: none;
  }

  .close-dialog {
    align-items: center;
    block-size: var(--size-6);
    border-radius: var(--radius-2);
    display: flex;
    inline-size: var(--size-6);
    inset-block-start: var(--size-9);
    inset-inline-end: var(--size-9);
    justify-content: center;
    position: fixed;

    &:focus {
      background-color: var(--accent-1);
      outline: none;
    }
  }

  .title {
    background: linear-gradient(to bottom, var(--color-surface-1) 30%, transparent);
    color: var(--color-text);
    font-size: var(--font-size-8);
    font-weight: var(--font-weight-6);
    inline-size: 100%;
    line-height: var(--font-lineheight-1);
    max-inline-size: var(--size-112);
    position: sticky;
    inset-block-start: 0;
    padding-block: var(--size-14) var(--size-11);
    z-index: var(--layer-1);
  }

  .table-area {
    inline-size: 100%;
    max-inline-size: var(--size-96);
  }

  .footer {
    background: linear-gradient(to top, var(--color-surface-1) 30%, transparent);
    display: flex;
    justify-content: center;
    padding-block-start: var(--size-4);
    position: sticky;
    inline-size: 100%;
    padding-block: var(--size-14) var(--size-7);
    inset-block-end: 0;
    z-index: var(--layer-1);
  }

  .dismiss {
    block-size: var(--size-7);
    border-radius: var(--radius-3);
    color: var(--color-text);
    cursor: pointer;
    font-size: var(--font-size-5);
    font-weight: var(--font-weight-5);
    opacity: 0.6;
    padding-inline: var(--size-6);
    transition: opacity 150ms ease;

    &:hover {
      opacity: 0.8;
    }

    &:focus {
      outline: none;
    }
  }

  .api-key-trigger {
    block-size: 0;
    overflow: hidden;
    position: absolute;
  }

  .popup-blocked {
    align-items: center;
    display: flex;
    font-size: var(--font-size-2);
    gap: var(--size-2);
    margin-block-start: var(--size-2);
  }

  .popup-blocked p {
    margin: 0;
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
</style>
