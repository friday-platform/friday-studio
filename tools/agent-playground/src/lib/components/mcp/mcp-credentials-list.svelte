<!--
  Renders a provider's credentials as a Table from @atlas/ui.

  @component
-->

<script lang="ts">
  import { Button, IconSmall, Table } from "@atlas/ui";
  import {
    createColumnHelper,
    createTable,
    renderSnippet,
    stockFeatures,
    type StockFeatures,
  } from "@tanstack/svelte-table";

  type Credential = {
    id: string;
    label: string;
    type: "apikey" | "oauth";
    status?: "ready" | "expired" | "unknown";
    createdAt: string;
  };

  type ProviderType = "apikey" | "oauth" | "app_install";

  interface Props {
    credentials: Credential[];
    providerType: ProviderType | undefined;
    onReplace: (id: string) => void;
    onRemove: (id: string) => void;
    onReauthenticate: () => void;
    onReinstall: () => void;
  }

  let {
    credentials,
    providerType,
    onReplace,
    onRemove,
    onReauthenticate,
    onReinstall,
  }: Props = $props();

  const helper = createColumnHelper<StockFeatures, Credential>();

  const columns = [
    helper.display({
      id: "info",
      cell: ({ row }) => renderSnippet(infoCell, { cred: row.original }),
    }),
    helper.display({
      id: "actions",
      meta: { align: "right", shrink: true },
      cell: ({ row }) => renderSnippet(actionsCell, { cred: row.original }),
    }),
  ];

  const table = createTable({
    _features: stockFeatures,
    columns,
    get data() {
      return credentials;
    },
    getRowId: (row) => row.id,
  });

  function statusLabel(status: Credential["status"]): string {
    switch (status) {
      case "ready":
        return "Ready";
      case "expired":
        return "Expired";
      case "unknown":
        return "Unknown";
      default:
        return "";
    }
  }

  function typeLabel(type: Credential["type"]): string {
    return type === "apikey" ? "API Key" : "OAuth";
  }

  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  function formatDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return dateFormatter.format(date);
  }
</script>

{#snippet infoCell({ cred }: { cred: Credential })}
  <div class="cred-info">
    <div class="cred-title-row">
      <span class="cred-label">{cred.label}</span>
      {#if cred.status}
        <span
          class="cred-status"
          class:ready={cred.status === "ready"}
          class:expired={cred.status === "expired"}
          class:unknown={cred.status === "unknown"}
        >
          {#if cred.status === "ready"}
            <IconSmall.Check />
          {/if}
          {statusLabel(cred.status)}
        </span>
      {/if}
    </div>
    <div class="cred-meta">
      {typeLabel(cred.type)} · Created {formatDate(cred.createdAt)}
    </div>
  </div>
{/snippet}

{#snippet actionsCell({ cred }: { cred: Credential })}
  <div class="cred-actions">
    {#if providerType === "apikey"}
      <Button
        variant="secondary"
        size="small"
        onclick={() => onReplace(cred.id)}>Replace</Button
      >
    {:else if providerType === "oauth"}
      <Button variant="secondary" size="small" onclick={onReauthenticate}
        >Replace</Button
      >
    {:else if providerType === "app_install"}
      <Button variant="secondary" size="small" onclick={onReinstall}
        >Re-install</Button
      >
    {/if}
    <Button variant="destructive" size="small" onclick={() => onRemove(cred.id)}
      >Remove</Button
    >
  </div>
{/snippet}

<Table.Root {table} rowSize="auto" hideHeader />

<style>
  .cred-info {
    display: flex;
    flex-direction: column;
    gap: var(--size-px);
    min-inline-size: 0;
    padding-block: var(--size-2);
  }

  .cred-title-row {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    min-inline-size: 0;
  }

  .cred-label {
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-5);
    min-inline-size: 0;
    overflow-wrap: anywhere;
    white-space: normal;
  }

  .cred-status {
    align-items: center;
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    gap: var(--size-0-5);

    &.ready {
      color: var(--green-primary);
    }

    &.expired {
      color: var(--red-primary);
    }

    &.unknown {
      color: var(--text-faded);
    }
  }

  .cred-meta {
    color: var(--text-faded);
    font-size: var(--font-size-3);
  }

  .cred-actions {
    align-items: center;
    display: flex;
    gap: var(--size-3);
  }
</style>
