<script lang="ts">
import { getAppContext } from "$lib/app-context.svelte";
import { Breadcrumbs } from "$lib/components/breadcrumbs";
import { DropdownMenu } from "$lib/components/dropdown-menu";
import { getSpaceLayoutContext } from "../../context.svelte";
import { getSessionDetailContext } from "../[sessionId]/context.svelte";

const appCtx = getAppContext();
const workspaceCtx = getSpaceLayoutContext();
const sessionCtx = getSessionDetailContext();
</script>

{#if workspaceCtx.workspace && sessionCtx.session}
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
						if (!sessionCtx.session) return;
						// @ts-expect-error: incorrect!
						navigator.clipboard.writeText(sessionCtx.session.metadata.sessionId);
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
