<script lang="ts">
  import { GA4, trackEvent } from "@atlas/analytics/ga4";
  import { client, parseResult } from "@atlas/client/v2";
  import { ArtifactDataSchema, type DatabasePreview } from "@atlas/core/artifacts";
  import { getAtlasDaemonUrl } from "@atlas/oapi-client";
  import { Breadcrumbs } from "$lib/components/breadcrumbs";
  import { DropdownMenu } from "$lib/components/dropdown-menu";
  import { toast } from "$lib/components/notification/notification.svelte";
  import BasicTable from "$lib/components/primitives/basic-table.svelte";
  import MarkdownContent from "$lib/components/primitives/markdown-content.svelte";
  import Schedule from "$lib/components/primitives/schedule.svelte";
  import WebSearch from "$lib/components/primitives/web-search.svelte";
  import { parseFileContents, type ParsedContent } from "$lib/modules/artifacts/file-utils";
  import WorkspacePlanDetails from "$lib/modules/artifacts/workspace-plan-details.svelte";
  import {
    downloadFile,
    downloadFromUrl,
    getUniqueFileName,
    openInDownloads,
  } from "$lib/utils/files.svelte";
  import { BaseDirectory, writeTextFile } from "$lib/utils/tauri-loader";
  import { z } from "zod";
  import type { PageData } from "./$types";

  let { data }: { data: PageData } = $props();

  let artifact = $state<z.infer<typeof ArtifactDataSchema>>();
  let fileContents = $state<string>();
  let preview = $state<DatabasePreview>();

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

        // Preview included in same response for database artifacts
        if (result.data.preview) {
          preview = result.data.preview as DatabasePreview;
        }
      } catch (error) {
        console.error(error);
      }
    }

    fetchArtifact();
  });

  // Download handler for file artifacts
  async function handleFileDownload() {
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

  // Download handler for database artifacts (exports as CSV)
  function handleDatabaseDownload() {
    if (artifact?.type !== "database") return;
    const exportUrl = `${getAtlasDaemonUrl()}/api/artifacts/${data.artifactId}/export?format=csv`;
    // Use anchor element to trigger download without navigating away from page
    downloadFromUrl(exportUrl, artifact.data.sourceFileName);
  }
</script>

{#if artifact}
  <Breadcrumbs.Root>
    <Breadcrumbs.Item href="/library">Library</Breadcrumbs.Item>
    <Breadcrumbs.Segment />
    <Breadcrumbs.Title
      hasActions={artifact && (artifact.type === "file" || artifact.type === "database")}
    >
      {data.artifact?.title ?? "Item"}

      {#snippet actions()}
        {#if artifact && artifact.type === "file"}
          <DropdownMenu.Item onclick={handleFileDownload}>Download File</DropdownMenu.Item>
        {:else if artifact && artifact.type === "database"}
          <DropdownMenu.Item onclick={handleDatabaseDownload}>Download as CSV</DropdownMenu.Item>
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
      {#if artifact.version === 1}
        <WorkspacePlanDetails workspacePlan={artifact.data} hideControls={true} />
      {:else}
        <WorkspacePlanDetails
          workspacePlan={{ workspace: artifact.data.workspace, signals: artifact.data.signals }}
          hideControls={true}
        />
      {/if}
    {:else if artifact.type === "table"}
      <BasicTable headers={artifact.data.headers} rows={artifact.data.rows} />
    {:else if artifact.type === "database"}
      {#if preview}
        {#if preview.tooLargeForPreview}
          <div class="large-file-notice">
            <p>
              Dataset too large for preview ({preview.totalRows.toLocaleString()} rows,
              {preview.headers.length} columns)
            </p>
            <button class="download-button" onclick={handleDatabaseDownload}>
              Download as CSV
            </button>
          </div>
        {:else}
          <BasicTable headers={preview.headers} rows={preview.rows} />
          {#if preview.truncated}
            <p class="truncation-notice">
              Showing {preview.rows.length.toLocaleString()} of {preview.totalRows.toLocaleString()} rows.
              <button class="download-link" onclick={handleDatabaseDownload}>
                Download full dataset
              </button>
            </p>
          {/if}
        {/if}
      {:else}
        <p>Loading preview...</p>
      {/if}
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

  .large-file-notice {
    background: var(--color-background-2);
    border: var(--size-px) solid var(--color-border-1);
    border-radius: var(--radius-2);
    padding: var(--size-6);
    text-align: center;

    p {
      margin-block-end: var(--size-4);
    }
  }

  .download-button {
    background: var(--color-accent-1);
    border: none;
    border-radius: var(--radius-2);
    color: var(--color-text-1);
    cursor: pointer;
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    padding-block: var(--size-2);
    padding-inline: var(--size-4);

    &:hover {
      background: var(--color-accent-2);
    }
  }

  .truncation-notice {
    color: var(--color-text-2);
    font-size: var(--font-size-2);
    margin-block-start: var(--size-3);
  }

  .download-link {
    appearance: none;
    background: none;
    border: none;
    color: var(--color-accent-1);
    cursor: pointer;
    font-size: inherit;
    padding: 0;
    text-decoration: underline;

    &:hover {
      color: var(--color-accent-2);
    }
  }
</style>
