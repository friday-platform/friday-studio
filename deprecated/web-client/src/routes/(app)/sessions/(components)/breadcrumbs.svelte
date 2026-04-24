<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { Breadcrumbs } from "$lib/components/breadcrumbs";
  import { DropdownMenu } from "$lib/components/dropdown-menu";

  interface Props {
    session: { id: string; workspaceId?: string };
  }

  let { session }: Props = $props();
</script>

{#if session}
  <Breadcrumbs.Root>
    <Breadcrumbs.Item href="/sessions">Sessions</Breadcrumbs.Item>

    <Breadcrumbs.Segment />

    <Breadcrumbs.Title hasActions>
      Session Details

      {#snippet actions()}
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
          disabled={!session.workspaceId}
          onclick={() => {
            if (!session?.workspaceId) return;
            trackEvent(GA4.COPY_WORKSPACE_ID, { workspace_id: session.workspaceId });
            navigator.clipboard.writeText(session.workspaceId);
          }}
        >
          Workspace ID
        </DropdownMenu.Item>
      {/snippet}
    </Breadcrumbs.Title>
  </Breadcrumbs.Root>
{/if}
