<script lang="ts">
  import { stripSlackAppId, toSlackBotDisplayName } from "$lib/modules/integrations/utils";
  import { formatFullDate } from "$lib/utils/date";

  type Props = {
    /** Raw slack-app credential label: "TeamName (APP_ID)". */
    label: string;
    createdAt: string;
    /** Friday workspace wired to this bot. Null when unwired. */
    workspaceName: string | null;
  };

  let { label, createdAt, workspaceName }: Props = $props();

  const teamName = $derived(stripSlackAppId(label));
  const mention = $derived(workspaceName ? `@${toSlackBotDisplayName(workspaceName)}` : "@bot");
</script>

<div class="component">
  <div class="header">
    <span class="provider">{mention}</span>
    {#if teamName}
      <span>•</span>
      <span class="team">{teamName}</span>
    {/if}
  </div>
  {#if workspaceName}
    <div class="subline">
      <time datetime={createdAt}>{formatFullDate(createdAt)}</time>
      <span>-</span>
      <span class="workspace">{workspaceName}</span>
    </div>
  {:else}
    <span class="workspace unwired">Not connected to a workspace</span>
  {/if}
</div>

<style>
  .component {
    display: flex;
    flex-direction: column;
  }

  .header {
    align-items: center;
    display: flex;
    gap: var(--size-1);
  }

  .provider {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
  }

  .subline {
    align-items: center;
    display: flex;
    gap: var(--size-1);
  }

  .team,
  time,
  .workspace,
  .subline > span {
    font-size: var(--font-size-2);
    opacity: 0.6;
  }

  .header > span:not(.provider):not(.team) {
    font-size: var(--font-size-2);
    opacity: 0.6;
  }

  .unwired {
    font-style: italic;
  }
</style>
