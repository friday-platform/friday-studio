<!--
  Workspace-scoped Activity page — `/platform/[workspaceId]/activity`.
  Shares the view component with the global `/activity` page; passes
  the route's workspaceId so the list query + SSE feed are both scoped
  to that workspace.

  @component
-->

<script lang="ts">
  import { page } from "$app/state";
  import ActivityView from "../../../activity/(components)/activity-view.svelte";

  const workspaceId = $derived(page.params.workspaceId ?? null);
</script>

{#if workspaceId}
  <ActivityView {workspaceId} title="Activity" />
{:else}
  <p>Workspace not found.</p>
{/if}
