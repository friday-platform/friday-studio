<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { client, parseResult } from "@atlas/client/v2";
  import { stringifyError } from "@atlas/utils";
  import type { Color } from "@atlas/utils";
  import { createQuery, useQueryClient } from "@tanstack/svelte-query";
  import { goto, invalidateAll } from "$app/navigation";
  import { resolve } from "$app/paths";
  import Button from "$lib/components/button.svelte";
  import { Dialog } from "$lib/components/dialog";
  import { DropdownMenu } from "$lib/components/dropdown-menu";
  import { Icons } from "$lib/components/icons";
  import { IconSmall } from "$lib/components/icons/small";
  import { toast } from "$lib/components/notification/notification.svelte";
  import Logo from "$lib/modules/integrations/logo-column.svelte";
  import { stripSlackAppId, toSlackBotDisplayName } from "$lib/modules/integrations/utils";
  import { onMount } from "svelte";
  import ConnectSlack from "../(components)/connect-slack.svelte";
  import DisconnectSlack from "../(components)/disconnect-slack.svelte";
  import IntegrationTable from "../(components)/integration-table.svelte";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let queryClient = useQueryClient();

  const COLORS: Color[] = ["yellow", "green", "blue", "red", "purple", "brown"];

  const workspace = $derived(data.workspace);
  const integrations = $derived(data.integrations);

  // slack-app is shown in the Communicators section below, not the Integrations table.
  const regularIntegrations = $derived(integrations.filter((i) => i.provider !== "slack-app"));

  const slackAppId = $derived.by(() => {
    const signals = workspace.config?.signals;
    if (!signals) return undefined;
    for (const signal of Object.values(signals)) {
      if (signal.provider === "slack" && signal.config?.app_id) {
        return String(signal.config.app_id);
      }
    }
    return undefined;
  });

  const slackCredQuery = createQuery(() => ({
    queryKey: ["slack-app-credential", slackAppId],
    queryFn: async () => {
      const res = await parseResult(client.link.v1.summary.$get({ query: {} }));
      if (!res.ok) return null;
      return (
        res.data.credentials.find(
          (c) => c.provider === "slack-app" && c.label.includes(`(${slackAppId})`),
        ) ?? null
      );
    },
    enabled: !!slackAppId,
  }));
  const slackAppName = $derived.by(() => {
    const cred = slackCredQuery.data;
    if (!cred) return undefined;
    return stripSlackAppId(cred.displayName ?? cred.label);
  });

  onMount(() => {
    trackEvent(GA4.SPACE_VIEW, { space_id: workspace.id, space_name: workspace.name });
  });

  let nameValue = $state(workspace.name);

  async function handleUpdateName() {
    const trimmed = nameValue.trim();
    if (!trimmed || trimmed === workspace.name) {
      nameValue = workspace.name;
      return;
    }

    const res = await parseResult(
      client.workspace[":workspaceId"].metadata.$patch({
        param: { workspaceId: workspace.id },
        json: { name: trimmed },
      }),
    );

    if (res.ok) {
      queryClient.invalidateQueries({ queryKey: ["spaces"], refetchType: "all" });
      await invalidateAll();
    }
  }

  async function handleUpdateColor(color: Color) {
    const res = await parseResult(
      client.workspace[":workspaceId"].metadata.$patch({
        param: { workspaceId: workspace.id },
        json: { color },
      }),
    );

    if (res.ok) {
      queryClient.invalidateQueries({ queryKey: ["spaces"], refetchType: "all" });
      await invalidateAll();
    }
  }

  async function handleDeleteWorkspace() {
    if (!workspace) return;
    trackEvent(GA4.WORKSPACE_DELETE_CONFIRM, { workspace_id: workspace.id });

    const res = await parseResult(
      client.workspace[":workspaceId"].$delete({ param: { workspaceId: workspace.id } }),
    );

    if (!res.ok) {
      toast({
        title: "Failed to delete space",
        description: stringifyError(res.error),
        error: true,
      });
      return;
    }

    queryClient.invalidateQueries({ queryKey: ["spaces"], refetchType: "all" });
    toast({ title: "Space deleted", description: workspace.name });
    await goto("/chat");
  }
</script>

<div class="page">
  <div>
    <a class="back-to-space" href={resolve("/spaces/[spaceId]", { spaceId: workspace.id })}>
      <Icons.ArrowLeft />
      {workspace.name}
    </a>

    <h1>Editing Space</h1>
  </div>

  <div>
    <h2>General</h2>

    <div class="name-field">
      <label>
        <span class="form-field">Name</span>
        <input type="text" bind:value={nameValue} onblur={handleUpdateName} />
      </label>
    </div>

    <DropdownMenu.Root positioning={{ placement: "bottom-start" }}>
      <DropdownMenu.Trigger>
        <span class="change-color">
          <span
            style:color={workspace.metadata?.color
              ? `var(--${workspace.metadata?.color}-2)`
              : "var(--color-text)"}
          >
            <Icons.DotFilled />
          </span>
          {workspace.metadata?.color ?? "None"}

          <IconSmall.CaretDown />
        </span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content>
        {#each COLORS as color (color)}
          <DropdownMenu.Item
            accent="inherit"
            checked={workspace.metadata?.color === color}
            onclick={() => handleUpdateColor(color)}
          >
            <span style:color="var(--{color}-2)">
              <Icons.DotFilled />
            </span>

            <span class="color-label">{color}</span>
          </DropdownMenu.Item>
        {/each}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>

  {#if regularIntegrations.length > 0}
    <div>
      <h2>Integrations</h2>

      <IntegrationTable integrations={regularIntegrations} workspaceId={workspace.id} />
    </div>
  {/if}

  <div>
    <h2>Communicators</h2>

    {#if slackAppId}
      <div class="slack-app-info">
        <Logo provider="slack-app" />
        <div class="slack-app-details">
          <div class="slack-app-header">
            <span class="provider-name">@{toSlackBotDisplayName(workspace.name)}</span>
            {#if slackAppName}
              <span class="slack-separator">•</span>
              <span class="slack-team">{slackAppName}</span>
            {/if}
          </div>
          <span class="slack-label">Slack Bot</span>
        </div>
        <a
          class="slack-settings-link"
          href="https://api.slack.com/apps/{slackAppId}"
          target="_blank"
          rel="noopener noreferrer"
        >
          <IconSmall.ExternalLink />
          App Settings
        </a>
        <DisconnectSlack workspaceId={workspace.id} />
      </div>
    {:else}
      <ConnectSlack workspaceId={workspace.id} />
    {/if}
  </div>

  <div>
    <h2>Actions</h2>

    <div class="delete-space">
      <Dialog.Root>
        <Dialog.Trigger>
          <Button noninteractive>
            {#snippet prepend()}
              <span style:color="var(--color-error)">
                <Icons.Trash />
              </span>
            {/snippet}
            Delete space
          </Button>
        </Dialog.Trigger>

        <Dialog.Content>
          <Dialog.Close />

          {#snippet icon()}
            <span style:color="var(--color-red)">
              <Icons.DeleteSpace />
            </span>
          {/snippet}

          {#snippet header()}
            <Dialog.Title>Delete space</Dialog.Title>
            <Dialog.Description>
              <p>Are you sure you want to delete this space?</p>
            </Dialog.Description>
          {/snippet}

          {#snippet footer()}
            <Dialog.Button onclick={handleDeleteWorkspace}>Delete</Dialog.Button>

            <Dialog.Cancel>Cancel</Dialog.Cancel>
          {/snippet}
        </Dialog.Content>
      </Dialog.Root>

      <p>This action cannot be reversed</p>
    </div>
  </div>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: var(--size-12);
    margin-inline: auto;
    max-inline-size: var(--size-160);
    padding-block: var(--size-14);

    h1 {
      font-size: var(--font-size-8);
      font-weight: var(--font-weight-6);
      line-height: var(--font-lineheight-1);
      margin-block: var(--size-3) 0;
    }

    h2 {
      font-size: var(--font-size-6);
      font-weight: var(--font-weight-6);
    }
  }

  .back-to-space {
    align-items: center;
    display: flex;
    font-weight: var(--font-weight-5);
    gap: var(--size-2);
    opacity: 0.5;
  }

  .name-field {
    margin-block: var(--size-2) 0;

    label {
      display: flex;
      flex-direction: column;
      gap: var(--size-2);
    }

    .form-field {
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-5);
    }

    input {
      background: var(--color-surface-1);
      border: 1px solid var(--color-border-1);
      border-radius: var(--radius-3);
      block-size: var(--size-9);
      color: var(--color-text);
      font-size: var(--font-size-3);
      inline-size: 100%;
      max-inline-size: var(--size-80);
      padding-inline: var(--size-3);
    }
  }

  .change-color {
    align-items: center;
    background-color: var(--accent-1);
    block-size: var(--size-7);
    border-radius: var(--radius-3);
    display: flex;
    font-size: var(--font-size-2);
    gap: var(--size-1);
    font-weight: var(--font-weight-5);
    margin-block: var(--size-2) 0;
    padding-inline: var(--size-2);
    text-transform: capitalize;

    & > :global(svg) {
      opacity: 0.5;
    }
  }

  .slack-app-info {
    align-items: center;
    background-color: var(--accent-1);
    border-radius: var(--radius-3);
    display: flex;
    gap: var(--size-3);
    margin-block: var(--size-2) 0;
    padding: var(--size-3);
  }

  .slack-app-details {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-inline-size: 0;
  }

  .slack-app-header {
    align-items: center;
    display: flex;
    gap: var(--size-1);
  }

  .provider-name {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
  }

  .slack-separator {
    font-size: var(--font-size-2);
    opacity: 0.6;
  }

  .slack-team {
    font-size: var(--font-size-2);
    opacity: 0.6;
  }

  .slack-label {
    font-size: var(--font-size-2);
    opacity: 0.6;
  }

  .slack-settings-link {
    align-items: center;
    background-color: var(--color-surface-1);
    border-radius: var(--radius-3);
    border: 1px solid var(--color-border-1);
    color: var(--color-text);
    display: flex;
    flex-shrink: 0;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    gap: var(--size-1);
    padding-block: var(--size-1-5);
    padding-inline: var(--size-2-5);
    text-decoration: none;
    transition: background-color 150ms ease;

    &:hover {
      background-color: var(--color-surface-2);
    }
  }

  .delete-space {
    align-items: center;
    background-color: var(--accent-1);
    border-radius: var(--size-3);
    display: flex;
    gap: var(--size-2);
    inline-size: max-content;
    margin-block: var(--size-2) 0;
    padding: var(--size-1-5);
    padding-inline-end: var(--size-3);

    p {
      font-size: var(--font-size-2);
      opacity: 0.7;
    }
  }
</style>
