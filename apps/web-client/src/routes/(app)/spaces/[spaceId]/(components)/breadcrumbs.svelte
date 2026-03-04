<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { client, parseResult, type InferResponseType } from "@atlas/client/v2";
  import type { Color } from "@atlas/utils";
  import { useQueryClient } from "@tanstack/svelte-query";
  import { goto, invalidateAll } from "$app/navigation";
  import { getAppContext } from "$lib/app-context.svelte";
  import { Breadcrumbs } from "$lib/components/breadcrumbs";
  import { Dialog } from "$lib/components/dialog";
  import { DropdownMenu } from "$lib/components/dropdown-menu";
  import { Icons } from "$lib/components/icons";
  import { toast } from "$lib/components/notification/notification.svelte";
  import { SegmentedControl } from "$lib/components/segmented-control";
  import { getActivePage } from "$lib/utils/active-page.svelte";
  import { downloadFile, getUniqueFileName, openInDownloads } from "$lib/utils/files.svelte";
  import { BaseDirectory, writeTextFile } from "$lib/utils/tauri-loader";

  type Workspace = InferResponseType<(typeof client.workspace)[":workspaceId"]["$get"], 200>;

  let { workspace }: { workspace: Workspace } = $props();

  let queryClient = useQueryClient();

  const appCtx = getAppContext();

  const COLORS: Color[] = ["yellow", "green", "blue", "red", "purple", "brown"];

  async function handleUpdateColor(color: Color) {
    const res = await parseResult(
      client.workspace[":workspaceId"].metadata.$patch({
        param: { workspaceId: workspace.id },
        json: { color },
      }),
    );

    if (res.ok) {
      queryClient.invalidateQueries({ queryKey: ["spaces"], refetchType: "all" });
      await invalidateAll();
    } else {
      toast({ title: "Failed to update color", error: true });
    }
  }

  async function handleExportWorkspace() {
    if (!workspace) return;
    trackEvent(GA4.WORKSPACE_EXPORT, { workspace_id: workspace.id });

    try {
      const response = await client.workspace[":workspaceId"].export.$get({
        param: { workspaceId: workspace.id },
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Export failed" }));
        throw new Error((error as { error?: string }).error || "Failed to export workspace");
      }

      const yamlContent = await response.text();

      // Extract filename from Content-Disposition header or fallback to workspace name
      const contentDisposition = response.headers.get("Content-Disposition");
      const filenameMatch = contentDisposition?.match(/filename="([^"]+)"/);
      const filename = filenameMatch?.[1] || `${workspace.name}.yml`;

      if (__TAURI_BUILD__ && writeTextFile && BaseDirectory) {
        try {
          const uniqueName = await getUniqueFileName(filename, BaseDirectory.Download);
          await writeTextFile(uniqueName, yamlContent, { baseDir: BaseDirectory.Download });

          toast({
            title: "Exported",
            description: `${uniqueName} has been downloaded.`,
            viewLabel: "View File",
            viewAction: () => openInDownloads(uniqueName),
          });
          return;
        } catch (e) {
          console.error("Failed to save file:", e);
          // Fall through to browser download
        }
      }

      downloadFile(filename, yamlContent, "text/yaml");
    } catch (error) {
      console.error("Failed to export workspace:", error);
      alert(
        `Failed to export workspace: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function handleDeleteWorkspace() {
    if (!workspace) return;
    trackEvent(GA4.WORKSPACE_DELETE_CONFIRM, { workspace_id: workspace.id });

    try {
      const res = await parseResult(
        client.workspace[":workspaceId"].$delete({ param: { workspaceId: workspace.id } }),
      );

      if (!res.ok) {
        throw new Error(typeof res.error === "string" ? res.error : "Failed to delete workspace");
      }

      // Trigger workspace list refresh
      queryClient.invalidateQueries({ queryKey: ["spaces"], refetchType: "all" });

      // Redirect to main page
      await goto(appCtx.routes.main);
    } catch (error) {
      console.error("Failed to delete workspace:", error);
      alert(
        `Failed to delete workspace: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
</script>

{#if workspace}
  <div>
    <Breadcrumbs.Root>
      <Breadcrumbs.Item>Spaces</Breadcrumbs.Item>

      <Breadcrumbs.Segment />

      <Breadcrumbs.Title hasActions>
        {#snippet prepend()}
          <span style:color="var(--accent-2)">
            <Icons.DotFilled />
          </span>
        {/snippet}

        {workspace.name}

        {#snippet actions(actionsOpen)}
          <Dialog.Root
            onOpenChange={({ next }) => {
              if (!next) {
                setTimeout(() => {
                  actionsOpen.set(false);
                }, 150);
              }
              return next;
            }}
          >
            {#snippet children(open)}
              <DropdownMenu.Item onclick={handleExportWorkspace}>
                <Icons.Share />

                Share
              </DropdownMenu.Item>

              <DropdownMenu.Item
                onclick={() => {
                  trackEvent(GA4.WORKSPACE_DELETE_CLICK, { workspace_id: workspace.id });
                  open.set(true);
                }}
              >
                <Icons.Trash />
                Remove
              </DropdownMenu.Item>

              <DropdownMenu.Separator />
              <DropdownMenu.Label>Color</DropdownMenu.Label>

              {#each COLORS as color (color)}
                <DropdownMenu.Item
                  accent="inherit"
                  checked={workspace.metadata?.color === color}
                  onclick={() => handleUpdateColor(color)}
                >
                  <span style:color="var(--{color}-2)">
                    <Icons.DotFilled />
                  </span>

                  <span class="color-label">{color}</span>
                </DropdownMenu.Item>
              {/each}

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
          active={getActivePage([`(app)/spaces/[spaceId]`])}
          href={appCtx.routes.spaces.item(workspace.id)}
        >
          Details
        </SegmentedControl.Item>
        <SegmentedControl.Item
          active={getActivePage([`spaces/[spaceId]/sessions`])}
          href={appCtx.routes.spaces.item(workspace.id, "sessions")}
        >
          Activity
        </SegmentedControl.Item>
      </SegmentedControl.Root>
    </Breadcrumbs.Root>
  </div>
{/if}

<style>
  div {
    background: linear-gradient(to bottom, var(--color-surface-1) 75%, transparent);
    position: sticky;
    inset-block-start: 0;
    z-index: var(--layer-2);
  }

  .color-label {
    text-transform: capitalize;
  }
</style>
