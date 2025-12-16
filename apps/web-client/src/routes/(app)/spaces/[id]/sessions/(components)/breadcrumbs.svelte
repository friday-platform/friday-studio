<script lang="ts">
import type { SessionHistoryTimeline } from "@atlas/core/session/history-storage";
import { getAppContext } from "$lib/app-context.svelte";
import { Breadcrumbs } from "$lib/components/breadcrumbs";
import { DropdownMenu } from "$lib/components/dropdown-menu";
import { getSpaceLayoutContext } from "../../context.svelte";

let { session }: { session: SessionHistoryTimeline } = $props();

const appCtx = getAppContext();
const workspaceCtx = getSpaceLayoutContext();
</script>

{#if workspaceCtx.workspace && session}
	<Breadcrumbs.Root>
		<Breadcrumbs.Item>Spaces</Breadcrumbs.Item>

		<Breadcrumbs.Segment />

		<Breadcrumbs.Item href={appCtx.routes.spaces.item(workspaceCtx.workspace.id)}
			>{workspaceCtx.workspace.name}</Breadcrumbs.Item
		>

		<Breadcrumbs.Segment />

		<Breadcrumbs.Item href={appCtx.routes.spaces.item(workspaceCtx.workspace.id, 'sessions')}
			>Sessions</Breadcrumbs.Item
		>

		<Breadcrumbs.Segment />

		<Breadcrumbs.Title>
			Session Details

			{#snippet actions()}
				<!-- <DropdownMenu.Item disabled>Re-run Session</DropdownMenu.Item>
				<DropdownMenu.Item disabled>Export Details</DropdownMenu.Item>

				<DropdownMenu.Separator /> -->
				<DropdownMenu.Label>Copy</DropdownMenu.Label>
				<DropdownMenu.Item
					onclick={() => {
						if (!session) return;
						navigator.clipboard.writeText(session.metadata.sessionId);
					}}>Session ID</DropdownMenu.Item
				>
				<DropdownMenu.Item
					onclick={() => {
						if (!workspaceCtx.workspace) return;

						navigator.clipboard.writeText(workspaceCtx.workspace.id);
					}}>Workspace ID</DropdownMenu.Item
				>
			{/snippet}
		</Breadcrumbs.Title>
	</Breadcrumbs.Root>
{/if}
