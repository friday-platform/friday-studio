<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { client, parseResult } from "@atlas/client/v2";
  import { createCollapsible } from "@melt-ui/svelte";
  import {
    createColumnHelper,
    createTable,
    getCoreRowModel,
    renderComponent,
  } from "@tanstack/svelte-table";
  import { invalidateAll } from "$app/navigation";
  import { BUILD_INFO } from "$lib/build-info";
  import Button from "$lib/components/button.svelte";
  import { IconSmall } from "$lib/components/icons/small";
  import { Table } from "$lib/components/table";
  import { getClientContext } from "$lib/modules/client/context.svelte";
  import Logo from "$lib/modules/integrations/logo-column.svelte";
  import ProviderDetails from "$lib/modules/integrations/provider-details-column.svelte";
  import { getVersion, invoke } from "$lib/utils/tauri-loader";
  import { onMount } from "svelte";
  import AddIntegrationDialog from "./(components)/add-integration-dialog.svelte";
  import KeyInputCell from "./(components)/key-input-cell.svelte";
  import RemoveButtonCell from "./(components)/remove-button-cell.svelte";
  import RemoveCredentialDialog from "./(components)/remove-credential-dialog.svelte";
  import ValueInputCell from "./(components)/value-input-cell.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const credentials = $derived(data.credentials);
  const providers = $derived(data.providers);

  type CredentialRow = PageData["credentials"][number];

  function getProviderName(providerId: string): string {
    const provider = providers.find((p) => p.id === providerId);
    return provider?.displayName ?? providerId.charAt(0).toUpperCase() + providerId.slice(1);
  }

  async function removeCredential(id: string, provider: string) {
    trackEvent(GA4.CREDENTIAL_REMOVE, { provider });
    const res = await parseResult(client.link.v1.credentials[":id"].$delete({ param: { id } }));

    if (!res.ok) {
      console.error("Failed to delete credential:", res.error);
      alert("Failed to delete credential");
      return;
    }

    await invalidateAll();
  }

  const ctx = getClientContext();

  // Initialize env vars from loaded data
  let nextId = 1;
  let envVars = $derived<{ key: string; value: string; id: number }[]>(
    Object.entries(data.envVars)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => ({ key, value, id: nextId++ })),
  );
  let _isSaving = $state(false);
  let isRestarting = $state(false);
  let message = $state("");
  let version = $state<string>(BUILD_INFO?.version || "1.0.0-beta");
  let commitHash = BUILD_INFO?.commitHash || "unknown";

  // Integrations table (connected credentials only)
  const columnHelper = createColumnHelper<CredentialRow>();

  const integrationsTable = createTable({
    get data() {
      return credentials;
    },
    columns: [
      columnHelper.display({
        id: "provider_logo",
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
            name: getProviderName(row.provider),
            label: row.label,
            displayName: row.displayName,
            date: row.createdAt,
            credentialId: row.id,
          });
        },
      }),
      columnHelper.display({
        id: "actions",
        header: "",
        cell: (info) => {
          const row = info.row.original;
          return renderComponent(RemoveCredentialDialog, {
            credentialId: row.id,
            provider: row.provider,
            displayName: row.displayName ?? row.label,
            onRemove: removeCredential,
          });
        },
        meta: { shrink: true },
      }),
    ],
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => row.id,
  });

  // Env vars table
  type EnvVarRow = { key: string; value: string; id: number };

  const envVarColumnHelper = createColumnHelper<EnvVarRow>();

  function updateEnvVarKey(id: number, key: string) {
    envVars = envVars.map((v) => (v.id === id ? { ...v, key } : v));
  }

  function updateEnvVarValue(id: number, value: string) {
    envVars = envVars.map((v) => (v.id === id ? { ...v, value } : v));
  }

  const envVarsTable = createTable({
    get data() {
      return envVars;
    },
    columns: [
      envVarColumnHelper.display({
        id: "key",
        header: "Key",
        cell: (info) =>
          renderComponent(KeyInputCell, {
            value: info.row.original.key,
            onchange: (v: string) => updateEnvVarKey(info.row.original.id, v),
          }),
        meta: { width: "var(--size-72)" },
      }),
      envVarColumnHelper.display({
        id: "value",
        header: "Value",
        cell: (info) =>
          renderComponent(ValueInputCell, {
            value: info.row.original.value,
            onchange: (v: string) => updateEnvVarValue(info.row.original.id, v),
            onblur: () => saveChanges(),
          }),
      }),
      envVarColumnHelper.display({
        id: "actions",
        header: "",
        cell: (info) =>
          renderComponent(RemoveButtonCell, { onclick: () => removeEntry(info.row.original.id) }),
        meta: { shrink: true, width: "var(--size-10)" },
      }),
    ],
    getCoreRowModel: getCoreRowModel(),
    getRowId: (row) => String(row.id),
  });

  onMount(async () => {
    // Handle OAuth redirect fallback (popup-blocked same-tab redirect)
    const params = new URLSearchParams(window.location.search);
    if (params.has("credential_id")) {
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("credential_id");
      cleanUrl.searchParams.delete("provider");
      cleanUrl.searchParams.delete("error");
      cleanUrl.searchParams.delete("error_description");
      history.replaceState({}, "", cleanUrl.href);
      await invalidateAll();
    }

    // Get version info from Tauri if available
    if (getVersion) {
      try {
        const tauriVersion = await getVersion();
        if (tauriVersion) {
          version = tauriVersion;
        }
      } catch {
        // Failed to get Tauri version, use build info version
      }
    }
  });

  function addEntry() {
    trackEvent(GA4.ENV_VAR_ADD);
    envVars = [...envVars, { key: "", value: "", id: nextId++ }];
  }

  async function removeEntry(id: number) {
    trackEvent(GA4.ENV_VAR_REMOVE);
    envVars = envVars.filter((v) => v.id !== id);
    await saveChanges();
  }

  async function saveChanges() {
    _isSaving = true;

    try {
      // Only save entries that have both key and value
      const validEntries = envVars.filter((v) => v.key.trim() !== "" && v.value.trim() !== "");
      const envObject: Record<string, string> = {};

      for (const entry of validEntries) {
        envObject[entry.key.trim()] = entry.value;
      }

      await ctx.daemonClient.setEnvVars(envObject);
    } catch (err) {
      console.error("Failed to save env vars:", err);
      alert("Failed to save environment variables");
    } finally {
      _isSaving = false;
    }
  }

  async function restartDaemon() {
    if (!invoke) return;

    trackEvent(GA4.DAEMON_RESTART);
    isRestarting = true;
    try {
      const result = (await invoke("restart_atlas_daemon")) as string;
      showMessage(result);
    } catch (err) {
      console.error("Failed to restart daemon:", err);
      alert("Failed to restart Friday daemon");
    } finally {
      isRestarting = false;
    }
  }

  function showMessage(msg: string) {
    message = msg;

    setTimeout(() => {
      message = "";
    }, 5000);
  }

  const {
    elements: { root, trigger, content },
    states: { open },
  } = createCollapsible({ forceVisible: true });
</script>

<div class="main">
  <div class="main-int">
    <h1>Integrations</h1>
    <p>Manage connections to external services</p>

    {#if credentials.length === 0}
      <p class="empty">No integrations connected</p>
    {:else}
      <div class="credentials-table">
        <Table.Root table={integrationsTable} rowSize="large" hideHeader />
      </div>
    {/if}

    <AddIntegrationDialog {providers} />

    <div class="advanced-settings" {...$root} use:root>
      <h2>
        <button
          {...$trigger}
          use:trigger
          class:expanded={$open}
          onclick={() => {
            if (!$open) trackEvent(GA4.ADVANCED_SETTINGS_EXPAND);
          }}
        >
          Advanced Settings <IconSmall.CaretRight />
        </button>
      </h2>

      <div class="advanced-settings--content" use:content {...$content} class:expanded={$open}>
        <div class="env-vars-table">
          <Table.Root table={envVarsTable} rowSize="small" />
        </div>

        <Button size="small" onclick={addEntry}>Add variable</Button>
      </div>

      {#if __TAURI_BUILD__}
        <div class="daemon-section">
          <h2>Daemon</h2>

          <p>This operation may take a second.</p>

          <Button size="small" onclick={restartDaemon} disabled={isRestarting}>
            {isRestarting ? "Restarting..." : "Restart Daemon"}
          </Button>

          {#if message}
            <p class="daemon-message">
              {message}
            </p>
          {/if}
        </div>

        <div class="version-info">
          <h2>App Details</h2>

          <p>Version {version} ({commitHash})</p>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .main {
    position: relative;
    z-index: var(--layer-1);
  }

  .main-int {
    padding: var(--size-14);
  }

  .version-info {
    margin-block-start: var(--size-8);
  }

  .breadcrumbs {
    position: sticky;
    inset-block-start: var(--size-3-5);
  }

  h1 {
    color: var(--color-text);
    font-size: var(--font-size-7);
    font-weight: var(--font-weight-6);
    line-height: var(--font-lineheight-1);
  }

  h2 {
    color: var(--color-text);
    font-size: var(--font-size-6);
    font-weight: var(--font-weight-6);
    line-height: var(--font-lineheight-1);
  }

  p {
    font-size: var(--font-size-5);
    font-weight: var(--font-weight-5);
    line-height: var(--font-lineheight-1);
    margin-block: var(--size-1) var(--size-4);
    opacity: 0.6;
  }

  .empty {
    color: var(--text-3);
    font-size: var(--font-size-3);
  }

  .credentials-table {
    /* top offset calculates top padding of the table cell */
    margin-block: calc(var(--size-10) - var(--size-3-5)) var(--size-8);
  }

  .env-vars-table {
    margin-block: var(--size-4);
  }

  .daemon-section {
    border-block-start: var(--size-px) solid var(--color-border-1);
    margin-block-start: var(--size-10);
    padding-block-start: var(--size-10);

    .daemon-message {
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-5);
      opacity: 0.5;
    }
  }

  .advanced-settings {
    margin-block-start: var(--size-10);

    h2 button {
      align-items: center;
      display: flex;
      gap: var(--size-1-5);

      :global(svg) {
        transition: all 200ms ease;
      }

      &.expanded :global(svg) {
        transform: rotate(90deg);
      }
    }
  }

  .advanced-settings--content {
    overflow: hidden;
    max-block-size: 0;

    &.expanded {
      overflow: visible;
      max-block-size: none;
    }
  }
</style>
