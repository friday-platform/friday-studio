<script lang="ts">
import { getAppContext } from "$lib/app-context.svelte";
import { Breadcrumbs } from "$lib/components/breadcrumbs";
import { DropdownMenu } from "$lib/components/dropdown-menu";
import { Icons } from "$lib/components/icons";
import { SegmentedControl } from "$lib/components/segmented-control";
import Tag from "$lib/modules/spaces/tag.svelte";
import { getActivePage } from "$lib/utils/active-page.svelte";
import { getSpaceLayoutContext } from "../context.svelte";

const appCtx = getAppContext();
const spaceCtx = getSpaceLayoutContext();
</script>

{#if spaceCtx.workspace}
	<Breadcrumbs.Root>
		<Breadcrumbs.Item>Spaces</Breadcrumbs.Item>

		<Breadcrumbs.Segment />

		<Breadcrumbs.Title>
			<!-- {#snippet prepend()}
				<Tag color="#D3BB1E" />
			{/snippet} -->

			{spaceCtx.workspace.name}

			<!-- {#snippet actions()}
				<DropdownMenu.Item>
					<Icons.Pause />
					Pause</DropdownMenu.Item
				>
				<DropdownMenu.Separator />
				<DropdownMenu.Item accent="destructive">
					<Icons.DeleteSpace />
					Delete Space</DropdownMenu.Item
				>
			{/snippet} -->
		</Breadcrumbs.Title>

		<Breadcrumbs.Segment />

		<SegmentedControl.Root>
			<SegmentedControl.Item
				active={getActivePage([`spaces/${spaceCtx.workspace.id}`])}
				href={appCtx.routes.spaces.item(spaceCtx.workspace.id)}>Details</SegmentedControl.Item
			>
			<SegmentedControl.Item
				active={getActivePage([`spaces/${spaceCtx.workspace.id}/sessions`])}
				href={appCtx.routes.spaces.item(spaceCtx.workspace.id, 'sessions')}
				>Sessions</SegmentedControl.Item
			>
		</SegmentedControl.Root>
	</Breadcrumbs.Root>
{/if}
