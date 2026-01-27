<script lang="ts">
  import { client, parseResult } from "@atlas/client/v2";
  import { ArtifactDataSchema } from "@atlas/core/artifacts";
  import { GA4, trackEvent } from "@atlas/ga4";
  import { Breadcrumbs } from "$lib/components/breadcrumbs";
  import { DropdownMenu } from "$lib/components/dropdown-menu";
  import { toast } from "$lib/components/notification/notification.svelte";
  import BasicTable from "$lib/components/primitives/basic-table.svelte";
  import MarkdownContent from "$lib/components/primitives/markdown-content.svelte";
  import Schedule from "$lib/components/primitives/schedule.svelte";
  import WebSearch from "$lib/components/primitives/web-search.svelte";
  import { parseFileContents, type ParsedContent } from "$lib/modules/artifacts/file-utils";
  import WorkspacePlanDetails from "$lib/modules/artifacts/workspace-plan-details.svelte";
  import { downloadFile, getUniqueFileName, openInDownloads } from "$lib/utils/files.svelte";
  import { BaseDirectory, writeTextFile } from "$lib/utils/tauri-loader";
  import { z } from "zod";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let artifact = $state<z.infer<typeof ArtifactDataSchema>>();
  let fileContents = $state<string>();

  const fileName = $derived.by(() => {
    if (artifact?.type !== "file") return "";
    const paths = artifact.data.path.split("/");
    return paths[paths.length - 1];
  });

  const parsedContent = $derived.by((): ParsedContent | undefined => {
    if (!fileContents || artifact?.type !== "file") return undefined;
    return parseFileContents(fileContents, artifact.data.mimeType);
  });

  const summaryJson = $derived.by((): string | null => {
    if (artifact?.type !== "summary" && artifact?.type !== "slack-summary") return null;
    try {
      const parsed = JSON.parse(artifact.data) as unknown;
      return JSON.stringify(parsed, null, 2);
    } catch {
      return null;
    }
  });

  // Single fetch for both artifact and contents
  $effect(() => {
    if (artifact || !data.artifactId) return;

    async function fetchArtifact() {
      try {
        const result = await parseResult(
          client.artifactsStorage[":id"].$get({ param: { id: data.artifactId }, query: {} }),
        );

        if (!result.ok) throw new Error("Failed to get artifact");

        artifact = ArtifactDataSchema.parse(result.data.artifact.data);
        trackEvent(GA4.ARTIFACT_VIEW, {
          artifact_id: data.artifactId,
          artifact_type: artifact.type,
        });

        // Contents included in same response for file artifacts
        if (result.data.contents) {
          fileContents = result.data.contents;
        }
      } catch (error) {
        console.error(error);
      }
    }

    fetchArtifact();
  });

  // Download handler (copy from file.svelte handleDownload)
  async function handleDownload() {
    if (!fileContents) return;
    trackEvent(GA4.ARTIFACT_DOWNLOAD, { artifact_id: data.artifactId, file_name: fileName });

    if (__TAURI_BUILD__ && writeTextFile && BaseDirectory) {
      try {
        const uniqueName = await getUniqueFileName(fileName, BaseDirectory.Download);
        await writeTextFile(uniqueName, fileContents, { baseDir: BaseDirectory.Download });

        toast({
          title: "Done",
          description: `${uniqueName} has been downloaded.`,
          viewLabel: "View File",
          viewAction: () => openInDownloads(uniqueName),
        });
      } catch (e) {
        console.error("Failed to save file:", e);
      }
    } else if (artifact?.type === "file") {
      downloadFile(fileName, fileContents, artifact.data.mimeType);
    }
  }
</script>

{#if artifact}
  <Breadcrumbs.Root>
    <Breadcrumbs.Item href="/library">Library</Breadcrumbs.Item>
    <Breadcrumbs.Segment />
    <Breadcrumbs.Title hasActions={artifact && artifact.type === "file"}>
      {data.artifact?.title ?? "Item"}

      {#snippet actions()}
        {#if artifact && artifact.type === "file"}
          <DropdownMenu.List>
            <DropdownMenu.Item onclick={handleDownload}>Download File</DropdownMenu.Item>
          </DropdownMenu.List>
        {/if}
      {/snippet}
    </Breadcrumbs.Title>
  </Breadcrumbs.Root>

  <div class="wrapper">
    {#if artifact.type === "calendar-schedule"}
      <Schedule
        events={artifact.data.events}
        source={artifact.data.source}
        sourceUrl={artifact.data.sourceUrl}
      />
    {:else if artifact.type === "web-search"}
      <WebSearch data={artifact.data} />
    {:else if artifact.type === "summary" || artifact.type === "slack-summary"}
      {#if summaryJson}
        <pre class="code"><code>{summaryJson}</code></pre>
      {:else}
        <div class="summary">
          <MarkdownContent content={artifact.data} />
        </div>
      {/if}
    {:else if artifact.type === "workspace-plan"}
      <WorkspacePlanDetails workspacePlan={artifact.data} hideControls={true} />
    {:else if artifact.type === "table"}
      <BasicTable headers={artifact.data.headers} rows={artifact.data.rows} />
    {:else if artifact.type === "file"}
      {#if parsedContent}
        <div class="file-content">
          {#if parsedContent.type === "markdown"}
            <div class="markdown">
              <MarkdownContent content={parsedContent.content} />
            </div>
          {:else if parsedContent.type === "csv"}
            <BasicTable headers={parsedContent.headers} rows={parsedContent.rows} />
          {:else if parsedContent.type === "json" || parsedContent.type === "yaml"}
            <pre class="code"><code>{parsedContent.content}</code></pre>
          {:else if parsedContent.type === "plaintext"}
            <p class="plaintext">{parsedContent.content}</p>
          {:else if parsedContent.type === "error"}
            <p class="error">{parsedContent.message}</p>
            <pre class="code"><code>{parsedContent.raw}</code></pre>
          {:else}
            <pre class="code"><code>{parsedContent.content}</code></pre>
          {/if}
        </div>
      {/if}
    {/if}
  </div>
{/if}

<style>
  .wrapper {
    padding: var(--size-14);
  }

  .summary {
    max-inline-size: var(--size-prose);
  }

  .markdown {
    max-inline-size: var(--size-prose);
  }

  .code {
    margin: 0;
    white-space: pre;
    word-wrap: normal;

    code {
      font-family: var(--font-mono);
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-5);
    }
  }

  .error {
    color: var(--color-error);
    margin: 0;
    margin-block-end: var(--size-2);
  }

  .plaintext {
    margin: 0;
    white-space: pre-wrap;
    font-size: var(--font-size-2);
  }
</style>
