<!--
  Global Activity page — `/activity`. Lists pending + recent
  elicitations across every workspace.

  Workspace-scoped variant lives at `/platform/[workspaceId]/activity`
  and shares the same view component with a fixed `workspaceId` prop.

  @component
-->

<script lang="ts">
  import ActivityView from "./(components)/activity-view.svelte";
</script>

<ActivityView workspaceId={null} title="Activity" />
