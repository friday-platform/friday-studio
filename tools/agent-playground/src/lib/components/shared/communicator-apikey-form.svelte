<!--
  Wrapper around `CredentialSecretForm` for connecting a workspace
  communicator (slack/telegram/discord/teams/whatsapp) via apikey.

  Encapsulates the kind→provider-details fetch, the chained
  `submitApiKey` → `useConnectCommunicator()` mutation, and the
  loading/error/missing-schema states. Field rendering itself stays
  in `CredentialSecretForm`, driven by Link's secretSchema.

  @component
  @prop workspaceId - Current workspace ID (target of the wire mutation)
  @prop kind - Communicator kind; used as the Link provider id
  @prop onConnected - Called after the wire mutation succeeds
  @prop onCancel - Called when the user cancels the form (optional)
-->

<script lang="ts">
  import { Button } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import CredentialSecretForm from "$lib/components/credential-secret-form.svelte";
  import { useConnectCommunicator } from "$lib/queries";
  import { linkProviderQueries } from "$lib/queries/link-provider-queries.ts";
  import { useCredentialConnect } from "$lib/use-credential-connect.svelte.ts";

  type CommunicatorKind = "slack" | "telegram" | "discord" | "teams" | "whatsapp";

  interface Props {
    workspaceId: string;
    kind: CommunicatorKind;
    onConnected?: () => void;
    onCancel?: () => void;
  }

  let { workspaceId, kind, onConnected, onCancel }: Props = $props();

  const detailsQuery = createQuery(() => linkProviderQueries.providerDetails(kind));
  const connect = useCredentialConnect(kind);
  const connectMut = useConnectCommunicator();

  let wireError = $state<string | null>(null);

  async function handleSubmit(label: string, secret: Record<string, string>) {
    wireError = null;
    const credentialId = await connect.submitApiKey(label, secret);
    if (!credentialId) return;

    connectMut.mutate(
      { workspaceId, kind, credentialId },
      {
        onSuccess: () => onConnected?.(),
        onError: (err) => {
          wireError = err.message;
        },
      },
    );
  }
</script>

{#if detailsQuery.isLoading}
  <p class="loading">Loading {kind} provider…</p>
{:else if detailsQuery.error}
  <p class="form-error">
    Failed to load {kind} provider: {detailsQuery.error.message}
  </p>
  {#if onCancel}
    <Button variant="secondary" size="small" onclick={onCancel}>Cancel</Button>
  {/if}
{:else if !detailsQuery.data?.secretSchema}
  <p class="form-error">Provider {kind} is not yet registered in Link.</p>
  {#if onCancel}
    <Button variant="secondary" size="small" onclick={onCancel}>Cancel</Button>
  {/if}
{:else}
  <CredentialSecretForm
    secretSchema={detailsQuery.data.secretSchema}
    submitting={connect.submitting || connectMut.isPending}
    error={wireError ?? connect.error}
    onSubmit={handleSubmit}
    onCancel={onCancel}
  />
{/if}

<style>
  .loading {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    margin: 0;
  }

  .form-error {
    background: color-mix(in srgb, var(--color-error), transparent 90%);
    border: 1px solid var(--color-error);
    border-radius: var(--radius-2);
    color: var(--color-error);
    font-size: var(--font-size-1);
    margin: 0;
    padding: var(--size-2) var(--size-3);
  }
</style>
