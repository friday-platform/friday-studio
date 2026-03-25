<!--
  Sidebar idle state: integrations, run controls, recent sessions, and
  workspace metadata stacked vertically. Shown when no pipeline node is selected.

  @component
  @param {string} workspaceId - Active workspace ID
  @param {import("@atlas/config").WorkspaceConfig | null} config - Workspace config from daemon
-->

<script lang="ts">
  import type { WorkspaceConfig } from "@atlas/config";
  import IntegrationsSidebar from "$lib/components/integrations-sidebar.svelte";
  import RecentSessions from "$lib/components/recent-sessions.svelte";

  type Props = { workspaceId: string; config: WorkspaceConfig | null };

  let { workspaceId, config }: Props = $props();
</script>

<div class="sidebar-idle">
  <IntegrationsSidebar {workspaceId} />

  <RecentSessions {workspaceId} />
</div>

<style>
  .sidebar-idle {
    display: flex;
    flex-direction: column;
    gap: var(--size-8);
  }
</style>
