<script lang="ts">
  import { client, parseResult } from "@atlas/client/v2";
  import { goto } from "$app/navigation";
  import { getAppContext } from "$lib/app-context.svelte";
  import { Breadcrumbs } from "$lib/components/breadcrumbs";
  import { Dialog } from "$lib/components/dialog";
  import { DropdownMenu } from "$lib/components/dropdown-menu";
  import { Icons } from "$lib/components/icons";
  import { toast } from "$lib/components/notification/notification.svelte";
  import { SegmentedControl } from "$lib/components/segmented-control";
  import { getSpacesContext } from "$lib/modules/spaces/context.svelte";
  import { getActivePage } from "$lib/utils/active-page.svelte";
  import { downloadFile, getUniqueFileName, openInDownloads } from "$lib/utils/files.svelte";
  import { BaseDirectory, writeTextFile } from "$lib/utils/tauri-loader";

  interface Workspace {
    id: string;
    name: string;
  }

  let { workspace }: { workspace: Workspace } = $props();

  const appCtx = getAppContext();
  const spacesCtx = getSpacesContext();

  async function handleExportWorkspace() {
    if (!workspace) return;

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

    try {
      const res = await parseResult(
        client.workspace[":workspaceId"].$delete({ param: { workspaceId: workspace.id } }),
      );

      if (!res.ok) {
        throw new Error(typeof res.error === "string" ? res.error : "Failed to delete workspace");
      }

      // Trigger workspace list refresh
      spacesCtx.fetchWorkspaces();

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
  <Breadcrumbs.Root>
    <Breadcrumbs.Item>Spaces</Breadcrumbs.Item>

    <Breadcrumbs.Segment />

    <Breadcrumbs.Title hasActions>
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
              accent="destructive"
              onclick={() => {
                open.set(true);
              }}
            >
              <Icons.DeleteSpace />
              Remove
            </DropdownMenu.Item>

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
        active={getActivePage([`spaces/${workspace.id}`])}
        href={appCtx.routes.spaces.item(workspace.id)}
      >
        Details
      </SegmentedControl.Item>
      <SegmentedControl.Item
        active={getActivePage([`spaces/${workspace.id}/sessions`])}
        href={appCtx.routes.spaces.item(workspace.id, "sessions")}
      >
        Sessions
      </SegmentedControl.Item>
    </SegmentedControl.Root>
  </Breadcrumbs.Root>
{/if}
