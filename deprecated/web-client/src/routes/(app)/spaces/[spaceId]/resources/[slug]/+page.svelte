<script lang="ts">
  import { client, parseResult, type InferResponseType } from "@atlas/client/v2";
  import { getAtlasDaemonUrl } from "@atlas/oapi-client";
  import { createMutation, useQueryClient } from "@tanstack/svelte-query";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { Breadcrumbs } from "$lib/components/breadcrumbs";
  import { Dialog } from "$lib/components/dialog";
  import { DropdownMenu } from "$lib/components/dropdown-menu";
  import { Icons } from "$lib/components/icons";
  import { toast } from "$lib/components/notification/notification.svelte";
  import { Page } from "$lib/components/page";
  import BasicTable from "$lib/components/primitives/basic-table.svelte";
  import MarkdownContent from "$lib/components/primitives/markdown-content.svelte";
  import { formatChatDate } from "$lib/utils/date";
  import { downloadFromUrl } from "$lib/utils/files.svelte";
  import { replaceResource } from "$lib/utils/resource-upload";
  import { writable } from "svelte/store";
  import type { PageData } from "./$types";

  type ResourceDetail = InferResponseType<
    (typeof client.workspace)[":workspaceId"]["resources"][":slug"]["$get"],
    200
  >;

  let { data }: { data: PageData } = $props();

  let resource = $state<ResourceDetail>();
  let error = $state<string>();
  let loading = $state(true);

  let replaceFileInput: HTMLInputElement | undefined = $state();
  const deleteDialogOpen = writable(false);

  const workspaceName = $derived(data.workspace.name);
  const queryClient = useQueryClient();

  $effect(() => {
    if (resource || !data.slug) return;

    async function fetchResource() {
      try {
        const res = await parseResult(
          client.workspace[":workspaceId"].resources[":slug"].$get({
            param: { workspaceId: data.spaceId, slug: data.slug },
          }),
        );

        if (!res.ok) {
          error = typeof res.error === "string" ? res.error : "Failed to load resource";
          return;
        }

        resource = res.data;
      } catch (e) {
        error = e instanceof Error ? e.message : "Failed to load resource";
      } finally {
        loading = false;
      }
    }

    fetchResource();
  });

  const replaceMutation = createMutation(() => ({
    mutationFn: async (file: File) => {
      const result = await replaceResource(file, data.spaceId, data.slug);
      if (!result.ok) throw new Error(result.error);
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["resources", data.spaceId] });
      // Re-fetch the resource detail
      resource = undefined;
      loading = true;
    },
    onError: (err: unknown) => {
      const msg =
        err instanceof Error && err.message === "Table resources require a CSV file"
          ? "This resource requires a CSV file"
          : "Failed to replace resource";
      toast({ title: msg, error: true, viewAction: () => {} });
    },
  }));

  const deleteMutation = createMutation(() => ({
    mutationFn: async () => {
      const res = await parseResult(
        client.workspace[":workspaceId"].resources[":slug"].$delete({
          param: { workspaceId: data.spaceId, slug: data.slug },
        }),
      );
      if (!res.ok) throw new Error(String(res.error));
      return res.data;
    },
    onSuccess: () => {
      deleteDialogOpen.set(false);
      queryClient.invalidateQueries({ queryKey: ["resources", data.spaceId] });
      goto(resolve("/spaces/[spaceId]", { spaceId: data.spaceId }));
    },
    onError: () => {
      deleteDialogOpen.set(false);
      toast({ title: "Failed to remove resource", error: true, viewAction: () => {} });
    },
  }));

  function handleCsvDownload() {
    const exportUrl = `${getAtlasDaemonUrl()}/api/workspaces/${data.spaceId}/resources/${data.slug}/export`;
    downloadFromUrl(exportUrl, `${data.slug}.csv`);
  }

  function handleReplaceClick() {
    replaceFileInput?.click();
  }

  function handleReplaceFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      replaceMutation.mutate(file);
    }
    input.value = "";
  }

  function handleDeleteClick() {
    deleteDialogOpen.set(true);
  }

  function confirmDelete() {
    deleteMutation.mutate();
  }

  function cancelDelete() {
    deleteDialogOpen.set(false);
  }

  const displayName = $derived(resource?.name ?? data.slug);
  const isTabular = $derived(resource?.format === "tabular");
</script>

<input
  bind:this={replaceFileInput}
  type="file"
  class="hidden-input"
  onchange={handleReplaceFileSelected}
/>

<Page.Root>
  <Page.Content>
    {#snippet prepend()}
      <Breadcrumbs.Root>
        <Breadcrumbs.Item>Spaces</Breadcrumbs.Item>
        <Breadcrumbs.Segment />
        <Breadcrumbs.Item href={resolve("/spaces/[spaceId]", { spaceId: data.spaceId })}>
          {workspaceName}
        </Breadcrumbs.Item>
        <Breadcrumbs.Segment />
        <Breadcrumbs.Title hasActions>
          {displayName}

          {#snippet actions()}
            {#if isTabular}
              <DropdownMenu.Item onclick={handleCsvDownload}>
                {#snippet prepend()}
                  <Icons.Share />
                {/snippet}
                Download as CSV
              </DropdownMenu.Item>
            {/if}
            <DropdownMenu.Item disabled={replaceMutation.isPending} onclick={handleReplaceClick}>
              {#snippet prepend()}
                <Icons.Paperclip />
              {/snippet}
              {replaceMutation.isPending ? "Replacing..." : "Replace"}
            </DropdownMenu.Item>
            <DropdownMenu.Item
              accent="destructive"
              disabled={deleteMutation.isPending}
              onclick={handleDeleteClick}
            >
              {#snippet prepend()}
                <Icons.Trash />
              {/snippet}
              {deleteMutation.isPending ? "Removing..." : "Remove"}
            </DropdownMenu.Item>
          {/snippet}
        </Breadcrumbs.Title>
      </Breadcrumbs.Root>
    {/snippet}

    {#snippet header()}
      {#if resource}
        <h1>{resource.name}</h1>
      {/if}
    {/snippet}

    {#snippet description()}
      {#if resource?.description}
        <p>{resource.description}</p>
      {/if}
    {/snippet}

    {#if loading}
      <p class="loading">Loading resource...</p>
    {:else if error}
      <p class="error">{error}</p>
    {:else if resource}
      <div class="stats-bar">
        {#if resource.format === "tabular"}
          <span class="stat">{resource.totalRows.toLocaleString()} rows</span>
        {/if}
        {#if resource.readonly}
          <span class="stat-separator">&middot;</span>
          <span class="readonly-badge">Read-only</span>
        {/if}
        {#if resource.updatedAt}
          {#if resource.format === "tabular"}
            <span class="stat-separator">&middot;</span>
          {/if}
          <span class="stat updated">Updated {formatChatDate(resource.updatedAt)}</span>
        {/if}
      </div>

      {#if resource.format === "prose"}
        <div class="prose-wrapper">
          <MarkdownContent content={resource.content} />
        </div>
      {:else}
        <div class="table-wrapper">
          <BasicTable headers={resource.columns} rows={resource.rows} />
        </div>

        {#if resource.truncated}
          <p class="truncation-notice">
            Showing {resource.rowCount.toLocaleString()} of {resource.totalRows.toLocaleString()} rows.
            <button class="download-link" onclick={handleCsvDownload}>Download full dataset</button>
          </p>
        {/if}
      {/if}
    {/if}
  </Page.Content>
</Page.Root>

<Dialog.Root
  open={deleteDialogOpen}
  role="alertdialog"
  onOpenChange={({ next }) => {
    if (!next) cancelDelete();
    return next;
  }}
>
  {#snippet children(_open)}
    <Dialog.Content>
      <Dialog.Close />

      {#snippet header()}
        <Dialog.Title>Remove Resource</Dialog.Title>
        <Dialog.Description>
          Remove {displayName}? This resource will no longer be available to workspace agents.
        </Dialog.Description>
      {/snippet}

      {#snippet footer()}
        <div class="dialog-buttons">
          <Dialog.Button
            onclick={confirmDelete}
            disabled={deleteMutation.isPending}
            closeOnClick={false}
          >
            {deleteMutation.isPending ? "Removing..." : "Remove"}
          </Dialog.Button>
          <Dialog.Cancel onclick={cancelDelete}>Cancel</Dialog.Cancel>
        </div>
      {/snippet}
    </Dialog.Content>
  {/snippet}
</Dialog.Root>

<style>
  .hidden-input {
    display: none;
  }

  .loading {
    color: var(--text-3);
    font-size: var(--font-size-4);
  }

  .error {
    color: var(--color-red);
    font-size: var(--font-size-4);
  }

  .stats-bar {
    align-items: center;
    border-block-start: var(--size-px) solid var(--accent-1);
    display: flex;
    gap: var(--size-2);
    margin-block-start: calc(-1 * var(--size-6));
    padding-block-start: var(--size-4);
  }

  .readonly-badge {
    background: color-mix(in srgb, var(--color-blue) 10%, transparent);
    border-radius: var(--radius-round);
    color: var(--color-blue);
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    padding-block: var(--size-0-5);
    padding-inline: var(--size-2) var(--size-2-5);
  }

  .stat {
    color: var(--text-3);
    font-size: var(--font-size-2);
  }

  .stat.updated {
    opacity: 0.6;
  }

  .stat-separator {
    color: var(--text-3);
    font-size: var(--font-size-2);
    opacity: 0.3;
  }

  .prose-wrapper {
    max-inline-size: 80ch;
  }

  .table-wrapper {
    overflow-x: auto;
  }

  .truncation-notice {
    color: var(--text-3);
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

  .dialog-buttons {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
    inline-size: 100%;
  }
</style>
