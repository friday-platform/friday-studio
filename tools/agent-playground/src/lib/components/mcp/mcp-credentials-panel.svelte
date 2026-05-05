<!--
  MCP Credentials Panel — shows, adds, replaces, and removes Link credentials
  for an MCP server's providers.

  Scans the server's configTemplate.env for LinkCredentialRef values,
  groups by provider, and renders interactive subsections.

  @component
  @prop serverId - Server identifier (passed through, not used directly)
  @prop configTemplate - Server config template with env map
-->

<script lang="ts">
  import type { LinkCredentialRef } from "@atlas/agent-sdk";
  import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";
  import { Button, Dialog } from "@atlas/ui";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { browser } from "$app/environment";
  import { writable } from "svelte/store";
  import {
    useDeleteCredential,
    useUpdateCredentialSecret,
  } from "../../queries/link-credentials.ts";
  import { linkProviderQueries } from "../../queries/link-provider-queries.ts";
  import { useCredentialConnect } from "../../use-credential-connect.svelte.ts";
  import CredentialSecretForm from "../credential-secret-form.svelte";
  import McpCredentialsList from "./mcp-credentials-list.svelte";

  // ─── Props ─────────────────────────────────────────────────────────────────

  interface Props {
    serverId: string;
    configTemplate: MCPServerMetadata["configTemplate"];
    hasContent?: boolean;
  }

  let { serverId, configTemplate, hasContent = $bindable(false) }: Props = $props();

  // ─── Server-as-provider check ──────────────────────────────────────────────
  // HTTP OAuth remotes (e.g. Stripe) have no configTemplate.env but DO have
  // a Link OAuth provider registered under the server ID itself.
  const serverProviderQuery = createQuery(() => linkProviderQueries.providerDetails(serverId));

  // ─── Discovery ─────────────────────────────────────────────────────────────

  interface ProviderRef {
    providerId: string;
    key: string;
  }

  interface IdRef {
    credentialId: string;
    key: string;
  }

  const discovery = $derived.by(() => {
    const env = configTemplate.env ?? {};
    const providers: ProviderRef[] = [];
    const idRefs: IdRef[] = [];

    for (const [envKey, value] of Object.entries(env)) {
      if (typeof value !== "object" || value === null || !("from" in value)) continue;
      const ref = value as LinkCredentialRef;
      if (ref.from !== "link") continue;

      if (ref.provider) {
        providers.push({ providerId: ref.provider, key: envKey });
      } else if (ref.id) {
        idRefs.push({ credentialId: ref.id, key: envKey });
      }
    }

    // For HTTP OAuth remotes, the server ID itself is the provider ID
    const serverProvider = serverProviderQuery.data;
    if (serverProvider) {
      providers.push({ providerId: serverId, key: "" });
    }

    // Deduplicate providers by ID
    const uniqueProviders = [...new Map(providers.map((p) => [p.providerId, p])).values()];

    return { providers: uniqueProviders, idRefs };
  });

  const hasCredentialRefs = $derived(discovery.providers.length > 0 || discovery.idRefs.length > 0);

  $effect.pre(() => {
    hasContent = hasCredentialRefs;
  });

  // ─── Query client & mutations ──────────────────────────────────────────────

  const queryClient = useQueryClient();
  const deleteMutation = useDeleteCredential();
  const updateMutation = useUpdateCredentialSecret();

  // ─── Credential connect instances per provider ─────────────────────────────

  const connectMap = new Map<string, ReturnType<typeof useCredentialConnect>>();

  function getConnect(providerId: string) {
    if (!connectMap.has(providerId)) {
      connectMap.set(providerId, useCredentialConnect(providerId));
    }
    return connectMap.get(providerId)!;
  }

  // ─── OAuth / app-install callback listeners ────────────────────────────────

  $effect(() => {
    if (!browser) return;

    const cleanups: (() => void)[] = [];
    for (const { providerId } of discovery.providers) {
      const connect = getConnect(providerId);
      cleanups.push(
        connect.listenForCallback(() => {
          queryClient.invalidateQueries({ queryKey: linkProviderQueries.all() });
        }),
      );
    }

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  });

  // ─── Local UI state ────────────────────────────────────────────────────────

  let replacingId = $state<string | null>(null);
  let removingId = $state<string | null>(null);
  const removeDialogOpen = writable(false);

  $effect(() => {
    removeDialogOpen.set(removingId !== null);
  });

  let addingProvider = $state<string | null>(null);

  // ─── Helpers ─────────────────────────────────────────────────────────────

  function handleRemoveConfirm(id: string) {
    removingId = id;
  }

  function handleRemoveExecute() {
    if (!removingId) return;
    deleteMutation.mutate(removingId, {
      onSettled: () => {
        removingId = null;
      },
    });
  }

  function handleReplace(id: string) {
    replacingId = id;
  }

  function handleReplaceCancel() {
    replacingId = null;
  }

  function handleReplaceSubmit(label: string, secret: Record<string, string>) {
    if (!replacingId) return;
    updateMutation.mutate(
      { id: replacingId, secret: secret as Record<string, unknown> },
      {
        onSettled: () => {
          replacingId = null;
        },
      },
    );
  }

  function handleAddNew(providerId: string) {
    addingProvider = providerId;
  }

  function handleAddNewCancel() {
    addingProvider = null;
  }

  function handleAddNewSubmit(label: string, secret: Record<string, string>) {
    if (!addingProvider) return;
    const connect = getConnect(addingProvider);
    connect.submitApiKey(label, secret).then(() => {
      addingProvider = null;
    });
  }
</script>

{#if hasCredentialRefs}
  <section class="credentials-panel">
    <!-- ID-based refs — read-only notice -->
    {#if discovery.idRefs.length > 0}
      <div class="id-ref-notice">
        <p>
          This server references a credential by ID. Manage it in
          <strong>Settings &gt; Connections</strong>
          .
        </p>
      </div>
    {/if}

    <!-- Per-provider subsections -->
    {#each discovery.providers as { providerId } (providerId)}
      {@const providerQuery = createQuery(() => linkProviderQueries.providerDetails(providerId))}
      {@const credentialsQuery = createQuery(() =>
        linkProviderQueries.credentialsByProvider(providerId),
      )}
      {@const connect = getConnect(providerId)}
      {@const details = providerQuery.data}
      {@const credentials = credentialsQuery.data ?? []}
      {@const providerName = details?.displayName ?? providerId}
      {@const isSingleProvider = discovery.providers.length === 1}

      <div class="provider-section">
        {#if !isSingleProvider}
          <h4 class="provider-name">{providerName}</h4>
        {/if}

        {#if credentialsQuery.isLoading}
          <div class="loading-state">Loading credentials…</div>
        {:else if credentials.length === 0}
          <div class="empty-state">
            No credentials connected for {providerName}.
          </div>
        {:else}
          {@const replacingCred = credentials.find((c) => c.id === replacingId)}
          <McpCredentialsList
            {credentials}
            providerType={details?.type}
            onReplace={handleReplace}
            onRemove={handleRemoveConfirm}
            onReauthenticate={connect.startOAuth}
            onReinstall={connect.startAppInstall}
          />
          {#if replacingCred && details?.secretSchema}
            <div class="replace-form">
              <CredentialSecretForm
                secretSchema={details.secretSchema}
                initialLabel={replacingCred.label}
                submitting={updateMutation.isPending}
                error={updateMutation.error?.message ?? null}
                onSubmit={handleReplaceSubmit}
              />
              <Button
                variant="secondary"
                size="small"
                onclick={handleReplaceCancel}
                disabled={updateMutation.isPending}
              >
                Cancel
              </Button>
            </div>
          {/if}
        {/if}

        <!-- Add new — always available regardless of credential count -->
        {#if !credentialsQuery.isLoading}
          {#if addingProvider === providerId}
            <div class="add-new-form">
              {#if details?.type === "apikey" && details?.secretSchema}
                <CredentialSecretForm
                  secretSchema={details.secretSchema}
                  submitting={connect.submitting}
                  error={connect.error}
                  onSubmit={handleAddNewSubmit}
                />
                <Button
                  variant="secondary"
                  size="small"
                  onclick={handleAddNewCancel}
                  disabled={connect.submitting}
                >
                  Cancel
                </Button>
              {:else if details?.type === "oauth"}
                <Button variant="primary" size="small" onclick={connect.startOAuth}>Connect</Button>
                {#if connect.popupBlocked && connect.blockedUrl}
                  <div class="popup-blocked">
                    <p>Popup was blocked.</p>
                    <a href={connect.blockedUrl} class="fallback-link">Continue in this tab</a>
                  </div>
                {/if}
                <Button variant="secondary" size="small" onclick={handleAddNewCancel}>
                  Cancel
                </Button>
              {:else if details?.type === "app_install"}
                <Button variant="primary" size="small" onclick={connect.startAppInstall}>
                  Install
                </Button>
                {#if connect.popupBlocked && connect.blockedUrl}
                  <div class="popup-blocked">
                    <p>Popup was blocked.</p>
                    <a href={connect.blockedUrl} class="fallback-link">Continue in this tab</a>
                  </div>
                {/if}
                <Button variant="secondary" size="small" onclick={handleAddNewCancel}>
                  Cancel
                </Button>
              {/if}
            </div>
          {:else}
            <Button variant="secondary" size="small" onclick={() => handleAddNew(providerId)}>
              {#if credentials.length === 0}
                Add one
              {:else if details?.type === "apikey"}
                Add API key
              {:else if details?.type === "oauth"}
                Connect
              {:else if details?.type === "app_install"}
                Install
              {:else}
                Add credential
              {/if}
            </Button>
          {/if}
        {/if}
      </div>
    {/each}
  </section>

  <!-- Remove confirmation dialog -->
  <Dialog.Root open={removeDialogOpen}>
    <Dialog.Content>
      <Dialog.Close />
      {#snippet header()}
        <Dialog.Title>Remove credential</Dialog.Title>
        <Dialog.Description>
          This credential will be permanently removed and will no longer be available to workspaces.
        </Dialog.Description>
      {/snippet}
      {#snippet footer()}
        <Dialog.Button
          onclick={handleRemoveExecute}
          disabled={deleteMutation.isPending}
          closeOnClick={false}
        >
          {deleteMutation.isPending ? "Removing…" : "Remove"}
        </Dialog.Button>
        <Dialog.Cancel onclick={() => (removingId = null)}>Cancel</Dialog.Cancel>
      {/snippet}
    </Dialog.Content>
  </Dialog.Root>
{/if}

<style>
  .credentials-panel {
    display: flex;
    flex-direction: column;
    gap: var(--size-4);
  }

  .id-ref-notice {
    background: var(--color-surface-3);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-size: var(--font-size-1);
    padding: var(--size-2) var(--size-3);
  }

  .id-ref-notice p {
    margin: 0;
  }

  .provider-section {
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
  }

  .provider-name {
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    margin: 0;
  }

  .loading-state {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
  }

  .empty-state {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    display: flex;
    font-size: var(--font-size-1);
    gap: var(--size-2);
  }

  .replace-form,
  .add-new-form {
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding: var(--size-3);
  }

  .popup-blocked {
    background: color-mix(in srgb, var(--color-surface-2), var(--color-text) 5%);
    border-radius: var(--radius-2);
    font-size: var(--font-size-1);
    padding: var(--size-2) var(--size-3);
  }

  .popup-blocked p {
    margin: 0 0 var(--size-2) 0;
    opacity: 0.8;
  }

  .fallback-link {
    color: var(--color-accent);
    text-decoration: underline;
  }
</style>
