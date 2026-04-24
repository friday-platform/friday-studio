<script lang="ts">
  import { type FileData } from "@atlas/core/artifacts";
  import { getAtlasDaemonUrl } from "@atlas/oapi-client";
  import { Icons } from "$lib/components/icons";

  type Props = { data: FileData; artifactId: string };

  let { data, artifactId }: Props = $props();

  let imageError = $state(false);
  let fullscreen = $state(false);

  const imageUrl = $derived(`${getAtlasDaemonUrl()}/api/artifacts/${artifactId}/content`);

  /**
   * Downloads the image by fetching the binary and creating a local blob URL.
   * Needed because the server sends Content-Disposition: inline for images,
   * and the daemon may be cross-origin — both prevent anchor download attribute from working.
   */
  async function handleDownload(e: Event) {
    e.stopPropagation();
    try {
      const res = await fetch(imageUrl);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = data.originalName ?? `${artifactId}.jpg`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      // Fallback: open in new tab
      window.open(imageUrl, "_blank");
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      fullscreen = false;
    }
  }

  /** Moves the element to document.body to escape parent stacking contexts */
  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }
</script>

<svelte:window onkeydown={fullscreen ? handleKeydown : undefined} />

{#if imageError}
  <p class="image-error">Image could not be loaded</p>
{:else}
  <div class="image-artifact">
    <button type="button" class="image-trigger" onclick={() => (fullscreen = true)}>
      <img
        src={imageUrl}
        alt={data.originalName ?? artifactId}
        class="image-preview"
        onerror={() => (imageError = true)}
      />
    </button>

    <div class="actions">
      <span class="filename">{artifactId}</span>
      <button type="button" class="download-btn" onclick={handleDownload} title="Download image">
        <Icons.Download />
      </button>
    </div>
  </div>
{/if}

{#if fullscreen}
  <div class="fullscreen-overlay" role="dialog" aria-modal="true" use:portal>
    <button type="button" class="backdrop" onclick={() => (fullscreen = false)}></button>

    <div class="fullscreen-content">
      <img src={imageUrl} alt={data.originalName ?? artifactId} class="fullscreen-image" />
    </div>

    <div class="fullscreen-actions">
      <button type="button" class="fullscreen-btn" onclick={handleDownload} title="Download image">
        <Icons.Download />
      </button>
      <button
        type="button"
        class="fullscreen-btn"
        onclick={() => (fullscreen = false)}
        title="Close"
      >
        <Icons.Close />
      </button>
    </div>
  </div>
{/if}

<style>
  .image-artifact {
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    inline-size: fit-content;
    max-inline-size: 100%;
  }

  .image-trigger {
    appearance: none;
    background: none;
    border: none;
    border-radius: var(--radius-4);
    cursor: pointer;
    display: block;
    padding: 0;
    overflow: hidden;
  }

  .image-preview {
    border-radius: var(--radius-4);
    display: block;
    max-inline-size: min(100%, 512px);
    max-block-size: 512px;
    object-fit: contain;
    transition: opacity 0.15s ease;
  }

  .image-trigger:hover .image-preview {
    opacity: 0.9;
  }

  .actions {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    padding-inline: var(--size-1);
  }

  .filename {
    color: var(--color-text-muted);
    font-size: var(--font-size-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .download-btn {
    align-items: center;
    appearance: none;
    background: none;
    border: none;
    border-radius: var(--radius-2);
    color: var(--color-text-muted);
    cursor: pointer;
    display: flex;
    padding: var(--size-0-5);

    &:hover {
      color: var(--color-blue);
    }
  }

  .image-error {
    color: var(--color-text-muted);
    font-style: italic;
  }

  /* Fullscreen lightbox */
  .fullscreen-overlay {
    align-items: center;
    display: flex;
    inset: 0;
    justify-content: center;
    position: fixed;
    z-index: var(--layer-5);
  }

  .backdrop {
    appearance: none;
    background: rgba(0, 0, 0, 0.85);
    border: none;
    cursor: pointer;
    inset: 0;
    position: absolute;
  }

  .fullscreen-content {
    display: flex;
    align-items: center;
    justify-content: center;
    max-block-size: 90vh;
    max-inline-size: 90vw;
    position: relative;
  }

  .fullscreen-image {
    max-block-size: 90vh;
    max-inline-size: 90vw;
    object-fit: contain;
    border-radius: var(--radius-4);
  }

  .fullscreen-actions {
    display: flex;
    gap: var(--size-2);
    position: absolute;
    inset-block-start: var(--size-4);
    inset-inline-end: var(--size-4);
    z-index: 1;
  }

  .fullscreen-btn {
    align-items: center;
    appearance: none;
    background: rgba(0, 0, 0, 0.5);
    border: none;
    border-radius: var(--radius-3);
    color: white;
    cursor: pointer;
    display: flex;
    padding: var(--size-2);

    &:hover {
      background: rgba(0, 0, 0, 0.7);
    }
  }
</style>
