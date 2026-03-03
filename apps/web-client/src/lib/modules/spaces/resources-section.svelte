<script lang="ts">
  import { client, parseResult } from "@atlas/client/v2";
  import { createMutation, createQuery, useQueryClient } from "@tanstack/svelte-query";
  import Button from "$lib/components/button.svelte";
  import { Dialog } from "$lib/components/dialog";
  import { IconSmall } from "$lib/components/icons/small";
  import { toast } from "$lib/components/notification/notification.svelte";
  import { replaceResource } from "$lib/utils/resource-upload";
  import { writable } from "svelte/store";
  import AddResourceDialog from "./add-resource-dialog.svelte";
  import ResourceRow from "./resource-row.svelte";

  type Props = { workspaceId: string };

  let { workspaceId }: Props = $props();

  let replaceFileInput: HTMLInputElement | undefined = $state();
  let replaceTargetSlug: string | undefined = $state();
  let deleteTarget: { slug: string; name: string } | undefined = $state();

  const deleteDialogOpen = writable(false);

  const queryClient = useQueryClient();
  const queryKey = $derived(["resources", workspaceId]);

  const resources = createQuery(() => ({
    queryKey,
    queryFn: async () => {
      const res = await parseResult(
        client.workspace[":workspaceId"].resources.$get({ param: { workspaceId } }),
      );
      return res.ok ? res.data.resources : [];
    },
  }));

  const replaceMutation = createMutation(() => ({
    mutationFn: async ({ slug, file }: { slug: string; file: File }) => {
      const result = await replaceResource(file, workspaceId, slug);
      if (!result.ok) throw new Error(result.error);
      return result;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
    },
    onError: (error: unknown, { file }: { slug: string; file: File }) => {
      const msg =
        error instanceof Error && error.message === "Table resources require a CSV file"
          ? "This resource requires a CSV file"
          : `Failed to replace ${file.name}`;
      toast({ title: msg, error: true, viewAction: () => {} });
    },
  }));

  const deleteMutation = createMutation(() => ({
    mutationFn: async (slug: string) => {
      const res = await parseResult(
        client.workspace[":workspaceId"].resources[":slug"].$delete({
          param: { workspaceId, slug },
        }),
      );
      if (!res.ok) throw new Error(String(res.error));
      return res.data;
    },
    onSuccess: () => {
      deleteTarget = undefined;
      deleteDialogOpen.set(false);
      queryClient.invalidateQueries({ queryKey });
    },
    onError: () => {
      deleteTarget = undefined;
      deleteDialogOpen.set(false);
      toast({ title: "Failed to remove resource", error: true, viewAction: () => {} });
    },
  }));

  function handleReplaceClick(slug: string) {
    replaceTargetSlug = slug;
    replaceFileInput?.click();
  }

  function handleReplaceFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file && replaceTargetSlug) {
      replaceMutation.mutate({ slug: replaceTargetSlug, file });
    }
    replaceTargetSlug = undefined;
    input.value = "";
  }

  function handleDeleteClick(slug: string) {
    const resource = resources.data?.find((r) => r.slug === slug);
    if (resource) {
      deleteTarget = { slug: resource.slug, name: resource.name };
      deleteDialogOpen.set(true);
    }
  }

  function confirmDelete() {
    if (deleteTarget) {
      deleteMutation.mutate(deleteTarget.slug);
    }
  }

  function cancelDelete() {
    deleteTarget = undefined;
    deleteDialogOpen.set(false);
  }
</script>

<input
  bind:this={replaceFileInput}
  type="file"
  class="hidden-input"
  onchange={handleReplaceFileSelected}
/>

<section class="resources-section">
  <header class="section-header">
    <div class="section-title">
      <h2>Resources</h2>
      <p class="section-subtitle">Shared data your agents read, write, and build on</p>
    </div>
    {#if resources.isPending}
      <span class="loading-spinner"><IconSmall.Progress /></span>
    {/if}
    <AddResourceDialog {workspaceId}>
      {#snippet triggerContents()}
        <Button size="small" variant="secondary">+ Add</Button>
      {/snippet}
    </AddResourceDialog>
  </header>

  {#if resources.data && resources.data.length > 0}
    <div class="resource-list">
      {#each resources.data as resource (resource.slug)}
        <ResourceRow
          {resource}
          {workspaceId}
          onReplace={handleReplaceClick}
          onDelete={handleDeleteClick}
          isReplacing={replaceMutation.isPending && replaceTargetSlug === resource.slug}
          isDeleting={deleteMutation.isPending && deleteTarget?.slug === resource.slug}
        />
      {/each}
    </div>
  {/if}
</section>

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
          Remove {deleteTarget?.name ?? "this resource"}? This resource will no longer be available
          to workspace agents.
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

  .resources-section {
    margin-block: var(--size-4);
  }

  .section-header {
    align-items: center;
    display: flex;
    gap: var(--size-2);
    margin-block-end: var(--size-2);
  }

  .section-title {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-0-5);
  }

  .section-title h2 {
    font-size: var(--font-size-5);
    font-weight: var(--font-weight-6);
  }

  .section-subtitle {
    font-size: var(--font-size-3);
    line-height: var(--font-lineheight-3);
    opacity: 0.8;
  }

  .loading-spinner {
    animation: spin 1.2s linear infinite;
    color: var(--text-3);
    display: flex;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .resource-list {
    border-block-start: 1px solid var(--color-border-1);
  }

  .dialog-buttons {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
    inline-size: 100%;
  }
</style>
