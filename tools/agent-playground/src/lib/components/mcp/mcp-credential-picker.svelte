<!--
  Per-workspace credential picker for one Link-backed MCP env var.

  Lists the credentials registered for the env var's provider (default plus
  any named records) and writes the chosen credential id into the workspace's
  config copy via the credentials route. "Add credential" links out to the
  server's catalog detail page, where the full credential flow lives.

  @component
-->

<script lang="ts">
  import { createQuery } from "@tanstack/svelte-query";
  import { linkProviderQueries, useUpdateMCPCredential } from "$lib/queries";
  import { toast } from "@atlas/ui";

  interface Props {
    workspaceId: string;
    serverId: string;
    /** The env var name in the server's `env:` block. */
    envVar: string;
    /** Provider id from the Link ref. */
    providerId: string;
    /** The ref's pinned credential id, if any — absent means "provider default". */
    currentCredentialId?: string;
  }

  const { workspaceId, serverId, envVar, providerId, currentCredentialId }: Props = $props();

  const credsQuery = createQuery(() => linkProviderQueries.credentialsByProvider(providerId));
  const credentials = $derived(credsQuery.data ?? []);

  // A provider-only ref (no pinned id) resolves to the provider default at
  // spawn — reflect that as the selected option.
  const defaultId = $derived(credentials.find((cr) => cr.isDefault)?.id ?? "");
  const selectedId = $derived(currentCredentialId ?? defaultId);

  const updateCredential = useUpdateMCPCredential();

  async function onPick(credentialId: string): Promise<void> {
    if (!credentialId || credentialId === selectedId) return;
    try {
      await updateCredential.mutateAsync({ workspaceId, serverId, envVar, credentialId });
      toast({ title: `${envVar} credential updated` });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      toast({ title: `Failed to update ${envVar}`, description: err.message, error: true });
    }
  }
</script>

<div class="cred-picker">
  {#if credsQuery.isLoading}
    <span class="muted">Loading credentials…</span>
  {:else if credsQuery.isError}
    <span class="error">Failed to load credentials</span>
  {:else if credentials.length === 0}
    <span class="muted">No <code>{providerId}</code> credentials connected.</span>
    <a class="add-link" href="/mcp/{serverId}/connections">Add credential →</a>
  {:else}
    <select
      class="cred-select"
      value={selectedId}
      disabled={updateCredential.isPending}
      onchange={(e) => onPick(e.currentTarget.value)}
    >
      {#each credentials as cred (cred.id)}
        <option value={cred.id}>
          {cred.displayName || cred.label}{cred.isDefault ? " (default)" : ""}{cred.status ===
          "expired"
            ? " — expired"
            : ""}
        </option>
      {/each}
    </select>
    <a class="add-link" href="/mcp/{serverId}/connections">Manage →</a>
  {/if}
</div>

<style>
  .cred-picker {
    align-items: center;
    display: flex;
    flex: 1;
    gap: var(--size-2);
    min-inline-size: 0;
  }

  .cred-select {
    background-color: var(--surface-dark);
    border: 1px solid var(--border);
    border-radius: var(--radius-1);
    color: var(--text);
    flex: 1;
    font: inherit;
    font-size: var(--font-size-3);
    min-inline-size: 0;
    padding: var(--size-1) var(--size-1-5);
  }

  .muted {
    color: color-mix(in srgb, var(--text), transparent 35%);
    font-size: var(--font-size-3);
  }

  .muted code {
    font-size: var(--font-size-2);
  }

  .error {
    color: var(--red-primary);
    font-size: var(--font-size-3);
  }

  .add-link {
    color: var(--blue-primary);
    flex-shrink: 0;
    font-size: var(--font-size-2);
    text-decoration: none;
    white-space: nowrap;
  }

  .add-link:hover {
    text-decoration: underline;
  }
</style>
