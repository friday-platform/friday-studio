<script lang="ts">
  import { type FileData } from "@atlas/core/artifacts";
  import { getAtlasDaemonUrl } from "@atlas/oapi-client";
  import { createCollapsible } from "@melt-ui/svelte";
  import { DropdownMenu } from "$lib/components/dropdown-menu";
  import { Icons } from "$lib/components/icons";
  import { IconSmall } from "$lib/components/icons/small";
  import BasicTable from "$lib/components/primitives/basic-table.svelte";
  import MarkdownContent from "$lib/components/primitives/markdown-content.svelte";
  import { parseFileContents, type ParsedContent } from "$lib/modules/artifacts/file-utils";
  import { copyToClipboard, downloadFile, downloadFromUrl } from "$lib/utils/files.svelte";

  type Props = { data: FileData; contents?: string; artifactId?: string };

  let { data, contents, artifactId }: Props = $props();

  const isImage = $derived(data.mimeType?.startsWith("image/") ?? false);
  const imageUrl = $derived(
    isImage && artifactId
      ? `${getAtlasDaemonUrl()}/api/artifacts/${artifactId}/content`
      : undefined,
  );
  let imageError = $state(false);

  const parsedContent = $derived.by((): ParsedContent | undefined => {
    if (!contents || isImage) return undefined;
    return parseFileContents(contents, data.mimeType);
  });

  const {
    elements: { root, trigger, content },
    states: { open },
  } = createCollapsible({ forceVisible: true });

  const fileName = $derived.by(() => {
    const paths = data.path.split("/");
    return paths[paths.length - 1];
  });

  const fileContents = $derived(contents);

  function handleDownload() {
    if (isImage && imageUrl) {
      downloadFromUrl(imageUrl, fileName);
    } else if (fileContents) {
      downloadFile(fileName, fileContents, data.mimeType);
    }
  }
</script>

{#if data}
  <article {...$root} use:root>
    <header>
      <DropdownMenu.Root positioning={{ placement: "bottom-end" }}>
        <DropdownMenu.Trigger>
          <h2>{fileName} <IconSmall.CaretDown /></h2>
        </DropdownMenu.Trigger>

        <DropdownMenu.Content>
          <DropdownMenu.Item onclick={handleDownload}>Download File</DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Label>Copy</DropdownMenu.Label>
          <DropdownMenu.Item
            onclick={() => {
              if (!fileContents) return;
              copyToClipboard(fileContents);
            }}
          >
            Text
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onclick={() => {
              copyToClipboard(fileName);
            }}
          >
            File Name
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </header>

    <div class="contents" use:content {...$content} class:expanded={$open}>
      {#if isImage && imageUrl}
        {#if imageError}
          <p class="image-error">Image could not be loaded</p>
        {:else}
          <img
            src={imageUrl}
            alt={fileName}
            class="image-preview"
            onerror={() => (imageError = true)}
          />
        {/if}
      {:else if parsedContent}
        {#if parsedContent.type === "markdown"}
          <MarkdownContent content={parsedContent.content} />
        {:else if parsedContent.type === "csv"}
          <BasicTable headers={parsedContent.headers} rows={parsedContent.rows} />
        {:else if parsedContent.type === "json" || parsedContent.type === "yaml"}
          <pre><code>{parsedContent.content}</code></pre>
        {:else if parsedContent.type === "plaintext"}
          <p class="plaintext">{parsedContent.content}</p>
        {:else if parsedContent.type === "error"}
          <p class="error">{parsedContent.message}</p>
          <pre><code>{parsedContent.raw}</code></pre>
        {:else}
          <pre><code>{parsedContent.content}</code></pre>
        {/if}
      {/if}
    </div>

    {#if !$open}
      <div class="expand">
        <button type="button" {...$trigger} use:trigger>
          <Icons.DoubleArrow />
          Expand
        </button>
      </div>
    {/if}
  </article>
{/if}

<style>
  article {
    background-color: var(--color-surface-2);
    border-radius: var(--radius-6);
    max-inline-size: 100%;
    inline-size: fit-content;
    overflow: hidden;
    padding: var(--size-0-5);
    position: relative;

    header {
      align-items: center;
      block-size: var(--size-10);
      display: flex;
      padding-inline: var(--size-3);

      h2 {
        align-items: center;
        display: flex;
        gap: var(--size-1);
        font-size: var(--font-size-2);
      }
    }
  }

  .expand {
    align-items: end;
    background: linear-gradient(to bottom, transparent, var(--color-surface-1) 90%);
    border-radius: var(--radius-5);
    display: flex;
    justify-content: center;
    inset-block: var(--size-10) var(--size-0-5);
    inset-inline: var(--size-0-5);
    position: absolute;
    padding-block: var(--size-4);
    z-index: var(--layer-1);

    button {
      align-items: center;
      color: var(--color-blue);
      display: flex;
      gap: var(--size-1);
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-5);
    }
  }

  .contents {
    background-color: var(--color-surface-1);
    border-radius: var(--radius-5);
    max-block-size: var(--size-48);
    max-inline-size: 100%;
    padding: var(--size-4);
    overflow: hidden;

    &.expanded {
      max-block-size: none;
      overflow: auto;
    }

    pre {
      margin: 0;
      max-inline-size: 100%;
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

    .image-error {
      color: var(--color-text-muted);
      font-style: italic;
    }

    .image-preview {
      display: block;
      max-inline-size: min(100%, 400px);
      object-fit: contain;
    }

    .unsupported,
    .loading {
      color: var(--color-text-muted);
      font-style: italic;
    }
  }

  .download-toast {
    align-items: center;
    background-color: var(--color-surface-3);
    border-radius: var(--radius-4);
    bottom: var(--size-2);
    display: flex;
    font-size: var(--font-size-2);
    gap: var(--size-3);
    left: 50%;
    padding: var(--size-2) var(--size-4);
    position: absolute;
    transform: translateX(-50%);
    z-index: var(--layer-2);

    button {
      color: var(--color-blue);
      font-weight: var(--font-weight-5);
    }
  }
</style>
