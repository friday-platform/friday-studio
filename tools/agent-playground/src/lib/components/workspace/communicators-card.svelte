<!--
  Dashboard card listing chat communicators (slack, telegram, discord, teams,
  whatsapp) with Connect/Disconnect controls.

  All kinds use the generic apikey path: clicking Connect expands an inline
  form driven by `linkProviderQueries.providerDetails(kind)`; on submit the
  credential is created via `useCredentialConnect(kind).submitApiKey` and
  then wired via `useConnectCommunicator()`.

  Source priority:
    1. `config.communicators` — render its declared entries.
    2. Fallback — render all 5 supported kinds.

  @component
  @param {string} workspaceId - Current workspace ID
  @param {WorkspaceConfig | null} config - Workspace config (top-level shape)
-->

<script lang="ts">
  import { Button } from "@atlas/ui";
  import { createQuery } from "@tanstack/svelte-query";
  import InlineBadge from "$lib/components/shared/inline-badge.svelte";
  import CredentialSecretForm from "$lib/components/credential-secret-form.svelte";
  import {
    useConnectCommunicator,
    useDisconnectCommunicator,
    wiringQueries,
  } from "$lib/queries";
  import { linkProviderQueries } from "$lib/queries/link-provider-queries.ts";
  import { useCredentialConnect } from "$lib/use-credential-connect.svelte.ts";

  type CommunicatorKind = "slack" | "telegram" | "discord" | "teams" | "whatsapp";

  const SUPPORTED_KINDS: CommunicatorKind[] = [
    "slack",
    "telegram",
    "discord",
    "teams",
    "whatsapp",
  ];

  type Props = {
    workspaceId: string;
    config: { communicators?: Record<string, { kind: string }> } | null;
  };

  let { workspaceId, config }: Props = $props();

  type Row = { id: string; kind: CommunicatorKind };

  /** Coerce a string to a supported kind, or null. */
  function asKind(s: string): CommunicatorKind | null {
    if (
      s === "slack" ||
      s === "telegram" ||
      s === "discord" ||
      s === "teams" ||
      s === "whatsapp"
    ) {
      return s;
    }
    return null;
  }

  const rows = $derived.by((): Row[] => {
    const entries = config?.communicators;
    if (entries && Object.keys(entries).length > 0) {
      const out: Row[] = [];
      for (const [id, entry] of Object.entries(entries)) {
        const kind = asKind(entry.kind);
        if (kind) out.push({ id, kind });
      }
      if (out.length > 0) return out;
    }
    return SUPPORTED_KINDS.map((kind) => ({ id: kind, kind }));
  });

  /** Which row currently has its inline form expanded, if any. */
  let expandedKind = $state<CommunicatorKind | null>(null);

  /** Per-kind error surfaced from `submitApiKey` or wire mutation. */
  let rowError = $state<Record<string, string | null>>({});

  /** Tracks the kind currently mid-disconnect for per-row pending state. */
  let pendingDisconnectKind = $state<CommunicatorKind | null>(null);

  const connectMut = useConnectCommunicator();
  const disconnectMut = useDisconnectCommunicator();

  /**
   * Per-kind `useCredentialConnect` instances. Cached so the reactive state
   * inside each instance survives re-renders.
   */
  const apikeyConnectByKind = new Map<
    CommunicatorKind,
    ReturnType<typeof useCredentialConnect>
  >();

  function getApikeyConnect(kind: CommunicatorKind) {
    let connect = apikeyConnectByKind.get(kind);
    if (!connect) {
      connect = useCredentialConnect(kind);
      apikeyConnectByKind.set(kind, connect);
    }
    return connect;
  }

  function handleExpand(kind: CommunicatorKind) {
    rowError[kind] = null;
    expandedKind = kind;
  }

  function handleCollapse() {
    expandedKind = null;
  }

  async function handleApikeySubmit(
    kind: CommunicatorKind,
    label: string,
    secret: Record<string, string>,
  ) {
    rowError[kind] = null;
    const connect = getApikeyConnect(kind);
    const credentialId = await connect.submitApiKey(label, secret);
    if (!credentialId) {
      // submitApiKey set its own error on the connect state; surfaced via the form.
      return;
    }

    connectMut.mutate(
      { workspaceId, kind, credentialId },
      {
        onSuccess: () => {
          expandedKind = null;
        },
        onError: (err) => {
          rowError[kind] = err.message;
        },
      },
    );
  }

  function handleApikeyDisconnect(kind: CommunicatorKind) {
    rowError[kind] = null;
    pendingDisconnectKind = kind;
    disconnectMut.mutate(
      { workspaceId, kind },
      {
        onError: (err) => {
          rowError[kind] = err.message;
        },
        onSettled: () => {
          if (pendingDisconnectKind === kind) {
            pendingDisconnectKind = null;
          }
        },
      },
    );
  }
</script>

<div class="card">
  <header class="section-head">
    <h2 class="section-title">Communicators</h2>
    <span class="section-count">{rows.length}</span>
  </header>

  <div class="rows">
    {#each rows as row (row.id)}
      {@const wiringQuery = createQuery(() => wiringQueries.workspace(workspaceId, row.kind))}
      {@const isWired = wiringQuery.data != null}
      {@const isExpanded = expandedKind === row.kind}
      {@const isDisconnectPending = pendingDisconnectKind === row.kind}

      <div class="row-block">
        <div class="row">
          <span class="status-dot" class:connected={isWired}></span>
          <span class="kind-label">{row.id}</span>
          <InlineBadge variant="info">{row.kind}</InlineBadge>
          <span class="status-text" class:connected={isWired}>
            {isWired ? "Connected" : "Not connected"}
          </span>

          {#if isWired}
            <Button
              variant="secondary"
              size="small"
              disabled={isDisconnectPending}
              onclick={() => handleApikeyDisconnect(row.kind)}
            >
              Disconnect
            </Button>
          {:else if !isExpanded}
            <Button
              variant="primary"
              size="small"
              onclick={() => handleExpand(row.kind)}
            >
              Connect
            </Button>
          {/if}
        </div>

        {#if isExpanded}
          {@const detailsQuery = createQuery(() =>
            linkProviderQueries.providerDetails(row.kind),
          )}
          {@const connect = getApikeyConnect(row.kind)}
          <div class="expand">
            {#if detailsQuery.isLoading}
              <p class="loading">Loading {row.kind} provider…</p>
            {:else if detailsQuery.error}
              <p class="form-error">
                Failed to load {row.kind} provider: {detailsQuery.error.message}
              </p>
              <Button variant="secondary" size="small" onclick={handleCollapse}>Cancel</Button>
            {:else if !detailsQuery.data?.secretSchema}
              <p class="form-error">
                Provider {row.kind} is not yet registered in Link.
              </p>
              <Button variant="secondary" size="small" onclick={handleCollapse}>Cancel</Button>
            {:else}
              <CredentialSecretForm
                secretSchema={detailsQuery.data.secretSchema}
                submitting={connect.submitting || connectMut.isPending}
                error={rowError[row.kind] ?? connect.error}
                onSubmit={(label, secret) => handleApikeySubmit(row.kind, label, secret)}
                onCancel={handleCollapse}
              />
            {/if}
          </div>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .card {
    background: var(--color-surface-1);
    border-radius: var(--radius-4);
    display: flex;
    flex-direction: column;
    gap: var(--size-3);
    padding: var(--size-4) var(--size-5);
  }

  .section-head {
    align-items: baseline;
    display: flex;
    gap: var(--size-2-5);
  }

  .section-title {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-6);
    margin: 0;
  }

  .section-count {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
  }

  .rows {
    display: flex;
    flex-direction: column;
  }

  .row-block:not(:last-child) {
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
  }

  .row {
    align-items: center;
    border-radius: var(--radius-2);
    display: flex;
    gap: var(--size-2-5);
    padding: var(--size-2) var(--size-3);
  }

  .expand {
    background: var(--color-surface-2);
    border-radius: var(--radius-2);
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    margin-block: var(--size-1) var(--size-2);
    padding: var(--size-3);
  }

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

  .status-dot {
    background-color: color-mix(in srgb, var(--color-text), transparent 70%);
    block-size: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    inline-size: 6px;
  }

  .status-dot.connected {
    background-color: var(--color-success);
  }

  .kind-label {
    color: var(--color-text);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
  }

  .status-text {
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    font-size: var(--font-size-1);
    margin-inline-start: auto;
    text-align: end;
  }

  .status-text.connected {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
  }
</style>
