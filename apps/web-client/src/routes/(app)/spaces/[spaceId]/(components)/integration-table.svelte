<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { client, parseResult } from "@atlas/client/v2";
  import { getAtlasDaemonUrl } from "@atlas/oapi-client";
  import * as Sentry from "@sentry/sveltekit";
  import {
    createColumnHelper,
    createTable,
    getCoreRowModel,
    renderComponent,
  } from "@tanstack/svelte-table";
  import { invalidateAll } from "$app/navigation";
  import { toast } from "$lib/components/notification/notification.svelte";
  import { Table } from "$lib/components/table";
  import Logo from "$lib/modules/integrations/logo-column.svelte";
  import ProviderDetails from "$lib/modules/integrations/provider-details-column.svelte";
  import type { Integration } from "$lib/modules/integrations/types";
  import LinkAuthModal from "$lib/modules/messages/link-auth-modal.svelte";
  import {
    schemaToSecretFields,
    SecretSchemaShape,
    type SecretField,
  } from "$lib/modules/messages/secret-fields";
  import { tick } from "svelte";
  import { z } from "zod";
  import ConnectCell from "./connect-cell.svelte";
  import CredentialPickerCell from "./credential-picker-cell.svelte";

  let {
    integrations,
    workspaceId,
    selectedCredentials = {},
    onCredentialSelect,
  }: {
    integrations: Integration[];
    workspaceId: string;
    selectedCredentials?: Record<string, string>;
    onCredentialSelect?: (provider: string, credentialId: string) => void;
  } = $props();

  const OAuthCallbackMessageSchema = z.object({
    type: z.literal("oauth-callback"),
    credentialId: z.string(),
    provider: z.string(),
  });

  let popupBlocked = $state(false);
  let popupBlockedProviderId = $state<string | null>(null);
  let popupProviderType = $state<string | null>(null);
  let activeIntegration = $state<Integration | null>(null);

  let apiKeyProvider = $state<{
    id: string;
    displayName: string;
    secretFields: SecretField[];
  } | null>(null);
  let apiKeyTriggerEl = $state<HTMLElement | null>(null);

  function handleOAuthMessage(event: MessageEvent) {
    if (event.origin !== window.location.origin) return;

    const result = OAuthCallbackMessageSchema.safeParse(event.data);
    if (!result.success) return;

    completeFlow(result.data.credentialId);
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
    completeFlow(result.data.credentialId);
  }

  async function completeFlow(credentialId: string) {
    removeListeners();
    if (popupBlockedProviderId && popupProviderType) {
      trackEvent(GA4.CREDENTIAL_LINK_SUCCESS, {
        provider: popupBlockedProviderId,
        type: popupProviderType,
      });
    }

    if (activeIntegration) {
      await bindCredentialToPaths(activeIntegration, credentialId);
    }

    popupBlocked = false;
    popupBlockedProviderId = null;
    popupProviderType = null;
    activeIntegration = null;
    await invalidateAll();
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

  async function startApiKey(integration: Integration) {
    const result = await parseResult(
      client.link.v1.providers[":id"].$get({ param: { id: integration.provider } }),
    );
    if (!result.ok) return;

    const parsed = SecretSchemaShape.safeParse(result.data.secretSchema);
    if (!parsed.success) return;

    const fields = schemaToSecretFields(parsed.data);
    if (fields.length === 0) return;

    activeIntegration = integration;
    apiKeyProvider = {
      id: integration.provider,
      displayName: integration.providerDetails.displayName,
      secretFields: fields,
    };

    await tick();
    const triggerButton = apiKeyTriggerEl?.querySelector("button");
    triggerButton?.click();
  }

  function handleConnect(integration: Integration) {
    const providerType = integration.providerDetails.type;

    if (providerType === "apikey") {
      startApiKey(integration);
      return;
    }

    activeIntegration = integration;
    popupBlockedProviderId = integration.provider;
    popupProviderType = providerType;

    if (providerType === "oauth") {
      startOAuth(integration.provider);
    } else if (providerType === "app_install") {
      startAppInstall(integration.provider);
    }
  }

  async function handleApiKeySuccess(credentialId: string) {
    const providerId = apiKeyProvider?.id ?? "";
    const integration = activeIntegration;
    apiKeyProvider = null;
    trackEvent(GA4.CREDENTIAL_LINK_SUCCESS, { provider: providerId, type: "apikey" });

    if (integration) {
      await bindCredentialToPaths(integration, credentialId);
    }

    activeIntegration = null;
    await invalidateAll();
  }

  async function bindCredentialToPath(
    configClient: ReturnType<typeof client.workspaceConfig>,
    path: string,
    credentialId: string,
    retries = 2,
  ): Promise<{ path: string; error: unknown } | null> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const result = await parseResult(
        configClient.credentials[":path"].$put({ param: { path }, json: { credentialId } }),
      );
      if (result.ok) return null;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      } else {
        return { path, error: result.error };
      }
    }
    return null;
  }

  async function bindCredentialToPaths(integration: Integration, credentialId: string) {
    const configClient = client.workspaceConfig(workspaceId);
    const failures: { path: string; error: unknown }[] = [];

    for (const pathEntry of integration.paths) {
      const failure = await bindCredentialToPath(configClient, pathEntry.path, credentialId);
      if (failure) failures.push(failure);
    }

    if (failures.length > 0) {
      const paths = failures.map((f) => f.path).join(", ");
      Sentry.captureException(new Error(`Failed to bind credential to paths: ${paths}`), {
        extra: { provider: integration.provider, credentialId, failures },
      });
      toast({
        title: "Some integrations failed to connect",
        description: `Could not bind credential to: ${paths}`,
        error: true,
      });
    }
  }

  // Table definition
  const columnHelper = createColumnHelper<Integration>();

  const table = createTable({
    get data() {
      return integrations;
    },
    columns: [
      columnHelper.display({
        id: "logo",
        header: "",
        cell: (info) => renderComponent(Logo, { provider: info.row.original.provider }),
        meta: { shrink: true },
      }),
      columnHelper.display({
        id: "provider",
        header: "Provider",
        cell: (info) => {
          const row = info.row.original;
          return renderComponent(ProviderDetails, {
            name: row.providerDetails.displayName,
            label: row.credential?.label,
            displayName: row.credential?.displayName,
            date: row.credential?.createdAt ?? "",
            credentialId: row.credential?.id ?? "",
          });
        },
      }),
      columnHelper.display({
        id: "actions",
        header: "",
        cell: (info) => {
          const integration = info.row.original;
          if (integration.availableCredentials) {
            const selectHandler = onCredentialSelect
              ? (credentialId: string) =>
                  onCredentialSelect(integration.provider, credentialId)
              : async (credentialId: string) => {
                  await bindCredentialToPaths(integration, credentialId);
                  toast({ title: "Credential updated" });
                  invalidateAll();
                };
            return renderComponent(CredentialPickerCell, {
              credentials: integration.availableCredentials,
              selectedId: onCredentialSelect
                ? (selectedCredentials[integration.provider] ?? null)
                : (integration.credential?.id ?? null),
              onselect: selectHandler,
              onAddNew: () => handleConnect(integration),
            });
          }
          return renderComponent(ConnectCell, {
            connected: integration.connected,
            onclick: () => handleConnect(integration),
          });
        },
        meta: { shrink: true },
      }),
    ],
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.provider,
  });
</script>

<Table.Root {table} rowSize="large" hideHeader />

{#if popupBlocked && popupBlockedProviderId}
  <div class="popup-blocked">
    <p>Popup was blocked.</p>
    <button
      class="fallback-link"
      onclick={() => {
        if (popupBlockedProviderId && popupProviderType) {
          startFallback(popupBlockedProviderId, popupProviderType);
        }
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
      secretFields={apiKeyProvider.secretFields}
      onSuccess={handleApiKeySuccess}
    >
      {#snippet triggerContents()}
        <span></span>
      {/snippet}
    </LinkAuthModal>
  </div>
{/if}

<style>
  .popup-blocked {
    align-items: center;
    display: flex;
    font-size: var(--font-size-2);
    gap: var(--size-2);
    margin-block-start: var(--size-2);
  }

  .popup-blocked p {
    opacity: 0.8;
  }

  .fallback-link {
    background: none;
    color: var(--color-yellow);
    cursor: pointer;
    font-size: var(--font-size-2);
    text-decoration: underline;
  }

  .fallback-link:hover {
    color: var(--color-text);
  }

  .api-key-trigger {
    block-size: 0;
    overflow: hidden;
    position: absolute;
  }
</style>
