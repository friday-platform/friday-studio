<!--
  One credential picker row inside `workspace-setup-card.svelte`. Scoped to a
  single provider: queries Link for the available credentials, lets the user
  pick one (or `Connect another` which opens the OAuth popup), and bubbles the
  chosen credential id up via `onChange`.

  Refetch on OAuth completion: the row sets up its own `useCredentialConnect`
  listener and invalidates `linkProviderQueries.all()` so the credential
  options update without the user reloading. Matches the pattern in
  `mcp-credentials-panel.svelte`.

  Auto-select: when the query first lands and the parent has no choice yet,
  the row picks the default credential (or the first one) and emits it. This
  keeps Submit reachable when the user has exactly one credential and no
  explicit click is needed.

  @component
-->
<script lang="ts">
  import { Button } from "@atlas/ui";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { browser } from "$app/environment";
  import { linkProviderQueries } from "$lib/queries";
  import { useCredentialConnect } from "$lib/use-credential-connect.svelte.ts";

  interface Props {
    provider: string;
    selectedCredentialId: string | undefined;
    disabled?: boolean;
    onChange: (credentialId: string) => void;
  }

  const { provider, selectedCredentialId, disabled = false, onChange }: Props = $props();

  const credsQuery = createQuery(() => linkProviderQueries.credentialsByProvider(provider));
  const credentials = $derived(credsQuery.data ?? []);

  const defaultId = $derived(
    credentials.find((cr) => cr.isDefault)?.id ?? credentials[0]?.id ?? "",
  );

  const queryClient = useQueryClient();
  const connect = useCredentialConnect(() => provider);

  $effect(() => {
    if (!browser) return;
    const cleanup = connect.listenForCallback(() => {
      queryClient.invalidateQueries({ queryKey: linkProviderQueries.all() });
    });
    return () => cleanup();
  });

  $effect(() => {
    if (selectedCredentialId !== undefined && selectedCredentialId.length > 0) return;
    if (defaultId.length === 0) return;
    onChange(defaultId);
  });
</script>

<div class="cred-row">
  {#if credsQuery.isLoading}
    <span class="muted">Loading credentials…</span>
  {:else if credsQuery.isError}
    <span class="error">Failed to load credentials</span>
  {:else if credentials.length === 0}
    <span class="muted">
      No <code>{provider}</code>
       credentials connected yet.
    </span>
    <Button size="small" variant="primary" {disabled} onclick={connect.startOAuth}>
      Connect {provider}
    </Button>
  {:else}
    <select
      class="cred-select"
      value={selectedCredentialId ?? defaultId}
      {disabled}
      data-testid="setup-credential-select"
      onchange={(e) => onChange(e.currentTarget.value)}
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
    <Button size="small" variant="secondary" {disabled} onclick={connect.startOAuth}>
      Connect another
    </Button>
  {/if}

  {#if connect.popupBlocked && connect.blockedUrl}
    <div class="popup-blocked">
      Popup blocked —
      <a class="fallback-link" href={connect.blockedUrl} target="_blank" rel="noopener">
        continue in a new tab
      </a>
    </div>
  {/if}
</div>

<style>
  .cred-row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--size-2);
    min-inline-size: 0;
  }

  .cred-select {
    background-color: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-2);
    color: var(--text);
    flex: 1;
    font: inherit;
    font-size: var(--font-size-2);
    min-inline-size: 0;
    padding: var(--size-1-5) var(--size-2);
  }

  .cred-select:focus {
    border-color: var(--blue-primary);
    outline: none;
  }

  .cred-select:disabled {
    cursor: not-allowed;
    opacity: 0.6;
  }

  .muted {
    color: color-mix(in srgb, var(--text), transparent 35%);
    font-size: var(--font-size-1);
  }

  .muted code {
    font-family: var(--font-family-mono, ui-monospace, monospace);
    font-size: var(--font-size-1);
  }

  .error {
    color: var(--red-primary);
    font-size: var(--font-size-1);
  }

  .popup-blocked {
    color: color-mix(in srgb, var(--text), transparent 25%);
    font-size: var(--font-size-1);
    inline-size: 100%;
  }

  .fallback-link {
    color: var(--blue-primary);
    text-decoration: underline;
  }
</style>
