<script lang="ts">
import type { SessionHistoryTimeline } from "@atlas/core/session/history-storage";
import { Breadcrumbs } from "$lib/components/breadcrumbs";
import { DropdownMenu } from "$lib/components/dropdown-menu";

let { session }: { session: SessionHistoryTimeline } = $props();
</script>

{#if session}
	<Breadcrumbs.Root>
		<Breadcrumbs.Item href="/sessions">Sessions</Breadcrumbs.Item>

		<Breadcrumbs.Segment />

		<Breadcrumbs.Title>
			Session Details

			{#snippet actions()}
				<DropdownMenu.Label>Copy</DropdownMenu.Label>
				<DropdownMenu.Item
					onclick={() => {
						if (!session) return;
						navigator.clipboard.writeText(session.metadata.sessionId);
					}}>Session ID</DropdownMenu.Item
				>
				<DropdownMenu.Item
					onclick={() => {
						if (!session) return;
						navigator.clipboard.writeText(session.metadata.workspaceId);
					}}>Workspace ID</DropdownMenu.Item
				>
			{/snippet}
		</Breadcrumbs.Title>
	</Breadcrumbs.Root>
{/if}
