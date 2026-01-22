<script lang="ts">
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
  import { Breadcrumbs } from "$lib/components/breadcrumbs";
  import Button from "$lib/components/button.svelte";
  import { IconSmall } from "$lib/components/icons/small";
  import { Table } from "$lib/components/table";
  import { getClientContext } from "$lib/modules/client/context.svelte";
  import { GA4, trackEvent } from "@atlas/ga4";
  import { getVersion, invoke } from "$lib/utils/tauri-loader";
  import { onMount } from "svelte";
  import KeyInputCell from "./(components)/key-input-cell.svelte";
  import Logo from "./(components)/logo-column.svelte";
  import ProviderDetails from "./(components)/provider-details-column.svelte";
  import RemoveButtonCell from "./(components)/remove-button-cell.svelte";
  import RemoveCredential from "./(components)/remove-credential-column.svelte";
  import RenameCredentialModal from "./(components)/rename-credential-modal.svelte";
  import ValueInputCell from "./(components)/value-input-cell.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();
  const credentials = $derived(data.credentials);
  const providers = $derived(data.providers);

  // Credentials row type
  type CredentialRow = PageData["credentials"][number];

  // Lookup provider displayName by ID
  function getProviderName(providerId: string): string {
    const provider = providers.find((p) => p.id === providerId);
    return provider?.displayName ?? providerId.charAt(0).toUpperCase() + providerId.slice(1);
  }

  // Remove credential by ID
  async function removeCredential(id: string, provider: string) {
    trackEvent(GA4.CREDENTIAL_REMOVE, { provider });
    const res = await parseResult(client.link.v1.credentials[":id"].$delete({ param: { id } }));

    if (!res.ok) {
      console.error("Failed to delete credential:", res.error);
      alert("Failed to delete credential");
      return;
    }

    // Refresh the page data
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

  // Credentials table
  const columnHelper = createColumnHelper<CredentialRow>();

  const credentialsTable = createTable({
    get data() {
      return credentials;
    },
    columns: [
      columnHelper.accessor("provider", {
        id: "provider_logo",
        header: "",
        cell: (info) => {
          return renderComponent(Logo, { provider: info.getValue() });
        },
        meta: { shrink: true },
      }),
      columnHelper.display({
        id: "provider",
        header: "Provider",
        cell: (info) =>
          renderComponent(ProviderDetails, {
            name: getProviderName(info.row.original.provider),
            label: info.row.original.label,
            displayName: info.row.original.displayName,
            date: info.row.original.createdAt,
          }),
      }),

      columnHelper.display({
        id: "edit",
        header: "",
        cell: (info) =>
          renderComponent(RenameCredentialModal, {
            credentialId: info.row.original.id,
            currentName: info.row.original.displayName ?? info.row.original.label,
          }),
        meta: { shrink: true },
      }),

      columnHelper.display({
        id: "actions",
        header: "",
        cell: (info) =>
          renderComponent(RemoveCredential, {
            onclick: () => removeCredential(info.row.original.id, info.row.original.provider),
          }),
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
  <div class="breadcrumbs">
    <Breadcrumbs.Root>
      <Breadcrumbs.Item>Settings</Breadcrumbs.Item>
    </Breadcrumbs.Root>
  </div>

  <div class="main-int">
    <h2>Integrations</h2>

    {#if credentials.length === 0}
      <p class="empty">No integrations have been configured</p>
    {:else}
      <div class="credentials-table">
        <Table.Root table={credentialsTable} rowSize="large" hideHeader />
      </div>
    {/if}

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

        <Button size="small" onclick={addEntry}>Add Variable</Button>
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
    transition: all 150ms ease;
    z-index: var(--layer-1);
  }

  .main-int {
    padding-block: var(--size-9) var(--size-10);
    padding-inline: var(--size-14);
  }

  .version-info {
    margin-block-start: var(--size-8);
  }

  .breadcrumbs {
    position: sticky;
    inset-block-start: var(--size-3-5);
  }

  h2 {
    color: var(--color-text);
    font-size: var(--font-size-5);
    font-weight: var(--font-weight-6);
    line-height: var(--font-lineheight-1);
  }

  p {
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-4);
    line-height: var(--font-lineheight-1);
    margin-block: var(--size-1-5) var(--size-4);
    opacity: 0.8;
  }

  .empty {
    color: var(--text-3);
    font-size: var(--font-size-3);
  }

  .credentials-table {
    margin-block: var(--size-4) var(--size-8);
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
