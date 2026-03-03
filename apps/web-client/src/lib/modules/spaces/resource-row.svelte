<script lang="ts">
  import type { ResourceEntry } from "@atlas/resources/types";
  import { resolve } from "$app/paths";
  import { DropdownMenu } from "$lib/components/dropdown-menu";
  import { Icons } from "$lib/components/icons";
  import ExternalLinkIcon from "$lib/components/icons/small/external-link.svelte";
  import FileIcon from "$lib/components/icons/small/file.svelte";
  import { toast } from "$lib/components/notification/notification.svelte";
  import Tooltip from "$lib/components/tooltip.svelte";
  import { formatChatDate } from "$lib/utils/date";
  import { getProviderIcon } from "$lib/utils/provider-detection";

  type Props = {
    resource: ResourceEntry;
    workspaceId: string;
    onReplace: (slug: string) => void;
    onDelete: (slug: string) => void;
    isReplacing: boolean;
    isDeleting: boolean;
  };

  let { resource, workspaceId, onReplace, onDelete, isReplacing, isDeleting }: Props = $props();

  const rowCount = $derived(resource.type === "artifact_ref" ? resource.rowCount : undefined);

  const isUnavailable = $derived(
    resource.type === "artifact_ref" && resource.artifactType === "unavailable",
  );

  const isUnlinked = $derived(resource.type === "external_ref" && !resource.ref);

  const href = $derived.by(() => {
    if (resource.type === "document") {
      return resolve("/spaces/[spaceId]/resources/[slug]", {
        spaceId: workspaceId,
        slug: resource.slug,
      });
    }
    if (resource.type === "artifact_ref" && !isUnavailable) {
      return resolve("/library/[libraryId]", { libraryId: resource.artifactId });
    }
    if (resource.type === "external_ref" && resource.ref) {
      return resource.ref;
    }
    return undefined;
  });

  const isExternal = $derived(resource.type === "external_ref" && !!resource.ref);
  const canReplace = $derived(resource.type !== "external_ref");

  async function copyLink() {
    if (!href) return;
    const url = isExternal ? href : `${window.location.origin}${href}`;
    await navigator.clipboard.writeText(url);
    toast({ title: "Link copied" });
  }
</script>

{#snippet linkContent()}
  <div class="resource-icon">
    {#if resource.type === "external_ref"}
      {@const IconComponent = getProviderIcon(resource.provider)}
      <IconComponent />
    {:else}
      <FileIcon />
    {/if}
  </div>

  <div class="resource-info">
    <div class="resource-header">
      <span class="resource-name">{resource.name}</span>
      {#if rowCount !== undefined}
        <span class="row-count">&middot; {rowCount.toLocaleString()} items</span>
      {/if}
      {#if isExternal}
        <span class="external-indicator">
          <ExternalLinkIcon />
        </span>
      {/if}
      {#if isUnavailable}
        <span class="badge-warning">Unavailable</span>
      {/if}
      {#if isUnlinked}
        <Tooltip as="span" label="An agent will create this when the job first runs">
          <span class="status-badge">Pending</span>
        </Tooltip>
      {/if}
    </div>
    {#if resource.description}
      <span class="resource-description">{resource.description}</span>
    {/if}
  </div>

  <time class="updated">{formatChatDate(resource.updatedAt)}</time>
{/snippet}

<div class="resource-row">
  {#if href}
    <a
      class="resource-link"
      {href}
      target={isExternal ? "_blank" : undefined}
      rel={isExternal ? "noopener noreferrer" : undefined}
    >
      {@render linkContent()}
    </a>
  {:else}
    <div class="resource-link is-disabled">
      {@render linkContent()}
    </div>
  {/if}

  <div class="menu">
    <DropdownMenu.Root>
      <DropdownMenu.Trigger aria-label="Resource options">
        <div class="menu-trigger">
          <Icons.TripleDots />
        </div>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content>
        {#if href}
          <DropdownMenu.Item onclick={copyLink}>
            {#snippet prepend()}
              <Icons.Share />
            {/snippet}
            Copy Link
          </DropdownMenu.Item>
        {/if}

        {#if canReplace}
          <DropdownMenu.Item disabled={isReplacing} onclick={() => onReplace(resource.slug)}>
            {#snippet prepend()}
              <Icons.Paperclip />
            {/snippet}
            {isReplacing ? "Replacing..." : "Replace"}
          </DropdownMenu.Item>
        {/if}

        <DropdownMenu.Item
          accent="destructive"
          disabled={isDeleting}
          onclick={() => onDelete(resource.slug)}
        >
          {#snippet prepend()}
            <Icons.Trash />
          {/snippet}
          {isDeleting ? "Removing..." : "Remove"}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  </div>
</div>

<style>
  .resource-row {
    align-items: center;
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    gap: var(--size-1);
    position: relative;
    z-index: 1;

    &:last-child {
      border-block-end: none;
    }

    &:before {
      background-color: var(--accent-1);
      border-radius: var(--radius-2);
      content: "";
      inset-block: 0;
      inset-inline: calc(-1 * var(--size-3));
      opacity: 0;
      position: absolute;
      transition: opacity 150ms ease;
      z-index: -1;
    }

    &:hover:before {
      opacity: 1;
    }

    &:has(.is-disabled):before {
      display: none;
    }
  }

  .resource-link {
    align-items: flex-start;
    color: inherit;
    cursor: pointer;
    display: flex;
    flex: 1;
    gap: var(--size-3);
    min-inline-size: 0;
    padding-block: var(--size-3);
    text-decoration: none;

    &.is-disabled {
      cursor: default;
    }
  }

  .resource-icon {
    align-items: center;
    color: var(--text-3);
    display: flex;
    flex: none;
    margin-block-start: var(--size-0-5);

    :global(svg) {
      block-size: var(--size-4);
      inline-size: var(--size-4);
    }
  }

  .resource-info {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-0-5);
    min-inline-size: 0;
  }

  .resource-header {
    align-items: center;
    display: flex;
    gap: var(--size-1-5);
  }

  .resource-name {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row-count {
    color: var(--text-3);
    flex-shrink: 0;
    font-size: var(--font-size-2);
  }

  .external-indicator {
    align-items: center;
    color: var(--text-3);
    display: flex;
    flex: none;
    opacity: 0.5;

    :global(svg) {
      block-size: var(--size-3);
      inline-size: var(--size-3);
    }
  }

  .badge-warning {
    background: color-mix(in srgb, var(--color-orange-1), transparent 85%);
    border-radius: var(--radius-2);
    color: var(--color-orange-1);
    flex-shrink: 0;
    font-size: var(--font-size-1);
    padding: var(--size-0-5) var(--size-1-5);
  }

  .status-badge {
    border: var(--size-px) solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--text-3);
    flex: none;
    font-size: var(--font-size-1);
    opacity: 0.6;
    padding: 0 var(--size-1);
    white-space: nowrap;
  }

  .resource-description {
    color: var(--text-3);
    font-size: var(--font-size-2);
    line-height: var(--font-lineheight-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .updated {
    color: var(--text-3);
    flex-shrink: 0;
    font-size: var(--font-size-2);
    margin-block-start: var(--size-0-5);
    margin-inline-end: var(--size-3);
    opacity: 0.5;
  }

  .menu {
    inset-block-start: 50%;
    inset-inline-end: calc(-1 * var(--size-10));
    position: absolute;
    transform: translateY(-50%);
    z-index: 2;
  }

  .menu-trigger {
    align-items: center;
    border-radius: var(--radius-2);
    color: var(--text-3);
    cursor: pointer;
    display: flex;
    justify-content: center;
    opacity: 0;
    padding: var(--size-1);
    transition:
      opacity 150ms ease,
      background 150ms ease;
    visibility: hidden;

    :global(svg) {
      block-size: var(--size-4);
      inline-size: var(--size-4);
    }

    &:hover {
      background: var(--highlight-1);
    }
  }

  .resource-row:hover .menu-trigger,
  :global([data-melt-dropdown-menu-trigger][data-state="open"]) .menu-trigger {
    opacity: 1;
    visibility: visible;
  }
</style>
