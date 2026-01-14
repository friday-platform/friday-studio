<script lang="ts">
import type { SessionDigest } from "@atlas/core/session/build-session-digest";
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
					navigator.clipboard.writeText(session.id);
				}}>Session ID</DropdownMenu.Item
			>
			<DropdownMenu.Item
				onclick={() => {
					if (!session) return;
					navigator.clipboard.writeText(session.workspaceId);
				}}>Workspace ID</DropdownMenu.Item
			>
			{/snippet}
		</Breadcrumbs.Title>
	</Breadcrumbs.Root>
{/if}
