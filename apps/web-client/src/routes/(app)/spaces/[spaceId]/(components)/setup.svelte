<script lang="ts">
  import { client, parseResult } from "@atlas/client/v2";
  import * as Sentry from "@sentry/sveltekit";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { invalidateAll } from "$app/navigation";
  import Button from "$lib/components/button.svelte";
  import { toast } from "$lib/components/notification/notification.svelte";
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

  // Default selections derived from isDefault credentials
  const defaultSelections = $derived.by(() => {
    const defaults: Record<string, string> = {};
    for (const integration of integrations) {
      if (integration.availableCredentials) {
        const defaultCred = integration.availableCredentials.find((c) => c.isDefault);
        if (defaultCred) {
          defaults[integration.provider] = defaultCred.id;
        }
      }
    }
    return defaults;
  });

  // User overrides (provider → credentialId)
  let overrides = $state<Record<string, string>>({});

  // Merge defaults with user overrides
  const selectedCredentials = $derived({ ...defaultSelections, ...overrides });

  function handleCredentialSelect(provider: string, credentialId: string) {
    overrides = { ...overrides, [provider]: credentialId };
  }

  const ambiguousProviders = $derived(
    integrations.filter((i) => i.availableCredentials && i.availableCredentials.length >= 2),
  );

  const allAmbiguousResolved = $derived(
    ambiguousProviders.every((i) => selectedCredentials[i.provider]),
  );

  const allConnected = $derived(
    integrations.every((i) => i.connected || i.availableCredentials),
  );

  const canComplete = $derived(allConnected && allAmbiguousResolved);

  let setupError = $state<string | null>(null);
  let completingSetup = $state(false);

  async function handleCompleteSetup() {
    setupError = null;
    completingSetup = true;

    // Bind selected credentials for ambiguous providers first
    const configClient = client.workspaceConfig(workspace.id);
    const failures: { path: string; error: unknown }[] = [];

    for (const integration of ambiguousProviders) {
      const credentialId = selectedCredentials[integration.provider];
      if (!credentialId) continue;

      for (const pathEntry of integration.paths) {
        const result = await parseResult(
          configClient.credentials[":path"].$put({
            param: { path: pathEntry.path },
            json: { credentialId },
          }),
        );
        if (!result.ok) {
          failures.push({ path: pathEntry.path, error: result.error });
        }
      }
    }

    if (failures.length > 0) {
      const paths = failures.map((f) => f.path).join(", ");
      Sentry.captureException(new Error(`Failed to bind credential to paths: ${paths}`), {
        extra: { workspaceId: workspace.id, failures },
      });
      toast({
        title: "Some integrations failed to connect",
        description: `Could not bind credential to: ${paths}`,
        error: true,
      });
      completingSetup = false;
      return;
    }

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

      <IntegrationTable
        {integrations}
        workspaceId={workspace.id}
        {selectedCredentials}
        onCredentialSelect={handleCredentialSelect}
      />
    </div>
  {/if}

  {#if setupError}
    <div class="error">{setupError}</div>
  {/if}

  <div class="actions">
    <Button disabled={!canComplete || completingSetup} onclick={handleCompleteSetup}>
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
