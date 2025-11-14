<script lang="ts">
import { client, parseResult } from "@atlas/client/v2";
import { toStore } from "svelte/store";
import { goto } from "$app/navigation";
import { getAppContext } from "$lib/app-context.svelte";
import { Breadcrumbs } from "$lib/components/breadcrumbs";
import { Dialog } from "$lib/components/dialog";
import { DropdownMenu } from "$lib/components/dropdown-menu";
import { Icons } from "$lib/components/icons";
import { SegmentedControl } from "$lib/components/segmented-control";
import Tag from "$lib/modules/spaces/tag.svelte";
import { getActivePage } from "$lib/utils/active-page.svelte";
import { getSpaceLayoutContext } from "../context.svelte";

const appCtx = getAppContext();
const spaceCtx = getSpaceLayoutContext();
let menuVisible = $state(true);

async function handleDeleteWorkspace() {
  if (!spaceCtx.workspace) return;

  try {
    const res = await parseResult(
      client.workspace[":workspaceId"].$delete({ param: { workspaceId: spaceCtx.workspace.id } }),
    );

    if (!res.ok) {
      throw new Error(typeof res.error === "string" ? res.error : "Failed to delete workspace");
    }

    // Trigger workspace list refresh
    appCtx.refreshWorkspaces();

    // Redirect to main page
    await goto(appCtx.routes.main);
  } catch (error) {
    console.error("Failed to delete workspace:", error);
    alert(`Failed to delete workspace: ${error instanceof Error ? error.message : String(error)}`);
  }
}
</script>

{#if spaceCtx.workspace}
	<Breadcrumbs.Root>
		<Breadcrumbs.Item>Spaces</Breadcrumbs.Item>

		<Breadcrumbs.Segment />

		<Breadcrumbs.Title {menuVisible}>
			{spaceCtx.workspace.name}

			{#snippet actions(actionsOpen)}
				<Dialog.Root
					onOpenChange={({ next }) => {
						if (!next) {
							setTimeout(() => {
								actionsOpen.set(false);
								menuVisible = true;
							}, 150);
						}
						return next;
					}}
				>
					{#snippet children(open)}
						<DropdownMenu.Item
							accent="destructive"
							onclick={() => {
								open.set(true);
								menuVisible = false;
							}}
						>
							<Icons.DeleteSpace />
							Remove Space</DropdownMenu.Item
						>

						<Dialog.Content>
							<Dialog.Close />

							{#snippet icon()}
								<span style:color="var(--color-red)">
									<Icons.DeleteSpace />
								</span>
							{/snippet}

							{#snippet header()}
								<Dialog.Title>Remove Space</Dialog.Title>
								<Dialog.Description>
									<p>Are you sure you want to remove this space?</p>
								</Dialog.Description>
							{/snippet}

							{#snippet footer()}
								<Dialog.Button onclick={handleDeleteWorkspace}>Confirm</Dialog.Button>

								<Dialog.Cancel>Cancel</Dialog.Cancel>
							{/snippet}
						</Dialog.Content>
					{/snippet}
				</Dialog.Root>
			{/snippet}
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
