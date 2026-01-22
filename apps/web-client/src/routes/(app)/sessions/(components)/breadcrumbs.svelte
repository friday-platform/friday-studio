<script lang="ts">
  import type { SessionDigest } from "@atlas/core/session/build-session-digest";
  import { GA4, trackEvent } from "@atlas/ga4";
  import { Breadcrumbs } from "$lib/components/breadcrumbs";
  import { DropdownMenu } from "$lib/components/dropdown-menu";

  let { session }: { session: SessionDigest } = $props();
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
          onclick={() => {
            if (!session) return;
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
