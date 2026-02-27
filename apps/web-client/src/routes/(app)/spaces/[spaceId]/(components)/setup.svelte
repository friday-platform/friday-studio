<script lang="ts">
  import { client, parseResult } from "@atlas/client/v2";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { invalidateAll } from "$app/navigation";
  import Button from "$lib/components/button.svelte";
  import Separator from "$lib/components/separator.svelte";
  import type { Integration } from "$lib/modules/integrations/types";
  import IntegrationTable from "./integration-table.svelte";

  let {
    workspace,
    integrations,
  }: {
    workspace: { id: string; name: string; description?: string | null };
    integrations: Integration[];
  } = $props();

  let queryClient = useQueryClient();

  const allConnected = $derived(integrations.every((i) => i.connected));

  let setupError = $state<string | null>(null);
  let completingSetup = $state(false);

  async function handleCompleteSetup() {
    setupError = null;
    completingSetup = true;

    const res = await parseResult(
      client.workspace[":workspaceId"].setup.complete.$post({
        param: { workspaceId: workspace.id },
      }),
    );

    completingSetup = false;

    if (res.ok) {
      queryClient.invalidateQueries({ queryKey: ["spaces"], refetchType: "all" });
      await invalidateAll();
    } else {
      setupError = "Some integrations are still missing. Please connect all providers.";
      await invalidateAll();
    }
  }
</script>

<div class="setup">
  <header class="header">
    <h1>{workspace.name}</h1>
    {#if workspace.description}
      <p>{workspace.description}</p>
    {/if}
  </header>

  <Separator />

  {#if integrations.length > 0}
    <div class="section">
      <h2>Integrations</h2>

      <IntegrationTable {integrations} workspaceId={workspace.id} />
    </div>
  {/if}

  {#if setupError}
    <div class="error">{setupError}</div>
  {/if}

  <div class="actions">
    <Button disabled={!allConnected || completingSetup} onclick={handleCompleteSetup}>
      {completingSetup ? "Completing..." : "Complete Setup"}
    </Button>
  </div>
</div>

<style>
  .setup {
    block-size: 100%;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: var(--size-6);
    margin-inline: auto;
    max-inline-size: var(--size-128);
    padding-block: var(--size-14);
  }

  .header {
    h1 {
      font-size: var(--font-size-8);
      font-weight: var(--font-weight-6);
    }

    p {
      font-size: var(--font-size-5);
      font-weight: var(--font-weight-5);
      line-height: var(--font-lineheight-3);
      margin-block: var(--size-1-5) 0;
      max-inline-size: 80ch;
      opacity: 0.6;
      text-wrap-style: balance;
    }
  }

  .section {
    h2 {
      font-size: var(--font-size-6);
      font-weight: var(--font-weight-6);
    }
  }

  .error {
    background-color: color-mix(in srgb, var(--color-red) 10%, transparent);
    border-radius: var(--radius-2);
    border: var(--size-px) solid var(--color-red);
    color: var(--color-red);
    font-size: var(--font-size-2);
    padding: var(--size-2) var(--size-3);
  }

  .actions {
    display: flex;
  }
</style>
