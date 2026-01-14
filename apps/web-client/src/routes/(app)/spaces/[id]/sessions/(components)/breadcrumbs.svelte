<script lang="ts">
  import type { SessionDigest } from "@atlas/core/session/build-session-digest";
  import { getAppContext } from "$lib/app-context.svelte";
  import { Breadcrumbs } from "$lib/components/breadcrumbs";
  import { DropdownMenu } from "$lib/components/dropdown-menu";

  let { session, workspaceName }: { session: SessionDigest; workspaceName?: string } = $props();

  const appCtx = getAppContext();
  const workspaceId = $derived(session.workspaceId);
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
      Session Details

      {#snippet actions()}
        <!-- <DropdownMenu.Item disabled>Re-run Session</DropdownMenu.Item>
				<DropdownMenu.Item disabled>Export Details</DropdownMenu.Item>

				<DropdownMenu.Separator /> -->
        <DropdownMenu.Label>Copy</DropdownMenu.Label>
        <DropdownMenu.Item
          onclick={() => {
            if (!session) return;
            navigator.clipboard.writeText(session.id);
          }}
        >
          Session ID
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onclick={() => {
            navigator.clipboard.writeText(workspaceId);
          }}
        >
          Workspace ID
        </DropdownMenu.Item>
      {/snippet}
    </Breadcrumbs.Title>
  </Breadcrumbs.Root>
{/if}
