<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { getAppContext } from "$lib/app-context.svelte";
  import { Breadcrumbs } from "$lib/components/breadcrumbs";
  import { DropdownMenu } from "$lib/components/dropdown-menu";

  interface Props {
    session: { id: string; workspaceId: string };
    workspaceName?: string;
    sessionTitle?: string;
    sessionDate?: string;
  }

  let { session, workspaceName, sessionTitle, sessionDate }: Props = $props();

  const appCtx = getAppContext();
  const workspaceId = $derived(session.workspaceId);

  const breadcrumbLabel = $derived(
    sessionTitle && sessionDate
      ? `${sessionTitle} – ${sessionDate}`
      : sessionTitle || "Session Details",
  );
</script>

{#if session}
  <Breadcrumbs.Root>
    <Breadcrumbs.Item>Spaces</Breadcrumbs.Item>

    <Breadcrumbs.Segment />

    <Breadcrumbs.Item href={appCtx.routes.spaces.item(workspaceId)}>
      {workspaceName ?? workspaceId}
    </Breadcrumbs.Item>

    <Breadcrumbs.Segment />

    <Breadcrumbs.Item href={appCtx.routes.spaces.item(workspaceId, "sessions")}>
      Sessions
    </Breadcrumbs.Item>

    <Breadcrumbs.Segment />

    <Breadcrumbs.Title hasActions>
      {breadcrumbLabel}

      {#snippet actions()}
        <DropdownMenu.Item disabled>Re-run Session</DropdownMenu.Item>
        <DropdownMenu.Item disabled>Export</DropdownMenu.Item>

        <DropdownMenu.Separator />

        <DropdownMenu.Label>Copy</DropdownMenu.Label>
        <DropdownMenu.Item
          onclick={() => {
            if (!session) return;
            trackEvent(GA4.COPY_SESSION_ID, { session_id: session.id });
            navigator.clipboard.writeText(session.id);
          }}
        >
          Session ID
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onclick={() => {
            trackEvent(GA4.COPY_WORKSPACE_ID, { workspace_id: workspaceId });
            navigator.clipboard.writeText(workspaceId);
          }}
        >
          Workspace ID
        </DropdownMenu.Item>
      {/snippet}
    </Breadcrumbs.Title>
  </Breadcrumbs.Root>
{/if}
