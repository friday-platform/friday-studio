<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { client, type InferResponseType } from "@atlas/client/v2";
  import { DropdownMenu } from "$lib/components/dropdown-menu";
  import { Icons } from "$lib/components/icons";
  import { toast } from "$lib/components/notification/notification.svelte";
  import { downloadFile, getUniqueFileName, openInDownloads } from "$lib/utils/files.svelte";
  import { BaseDirectory, writeTextFile } from "$lib/utils/tauri-loader";

  type Workspace = InferResponseType<(typeof client.workspace)[":workspaceId"]["$get"], 200>;

  let { workspace }: { workspace: Workspace } = $props();

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
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger aria-label="Share Actions">
    <Icons.Share />
  </DropdownMenu.Trigger>
  <DropdownMenu.Content>
    <DropdownMenu.Item onclick={handleExportWorkspace}>Share Space</DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
