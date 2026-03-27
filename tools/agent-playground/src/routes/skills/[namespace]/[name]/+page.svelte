<!--
  Skill detail page — renders SKILL.md as markdown preview or CodeMirror editor.
  Shown when a skill is expanded in the tree but no specific reference file is selected.

  @component
-->

<script lang="ts">
  import { browser } from "$app/environment";
  import {
    Button,
    Dialog,
    DropdownMenu,
    Icons,
    MarkdownRendered,
    markdownToHTML,
    toast,
  } from "@atlas/ui";
  import DOMPurify from "dompurify";
  import { createQuery } from "@tanstack/svelte-query";
  import { beforeNavigate, goto } from "$app/navigation";
  import { page } from "$app/state";
  import SkillFileEditor from "$lib/components/skills/skill-file-editor.svelte";
  import SkillLoader from "$lib/components/skills/skill-loader.svelte";
  import { skillQueries } from "$lib/queries";
  import { useDeleteSkill, useDisableSkill, usePublishSkill } from "$lib/queries/skills";
  import { markClean, markDirty } from "$lib/stores/skill-editor-state.svelte";
  import { writable } from "svelte/store";

  const namespace = $derived(page.params.namespace ?? "");
  const name = $derived(page.params.name ?? "");

  const skillQuery = createQuery(() => ({
    ...skillQueries.detail(namespace, name),
    enabled: namespace.length > 0 && name.length > 0,
  }));

  const skill = $derived(skillQuery.data?.skill);

  // ---------------------------------------------------------------------------
  // Edit mode (URL-driven via ?edit query param)
  // ---------------------------------------------------------------------------

  const editing = $derived(page.url.searchParams.has("edit"));
  let editorDirty = $state(false);
  let editorContent = $state("");

  function startEditing() {
    goto("?edit");
  }

  const publishMut = usePublishSkill();

  function handleSave(content: string) {
    if (!skill || publishMut.isPending) return;
    publishMut.mutate(
      {
        namespace,
        name,
        instructions: content,
        description: skill.description ?? undefined,
        descriptionManual: true,
      },
      {
        onSuccess: () => {
          markClean("SKILL.md");
          editorDirty = false;
          goto(page.url.pathname);
        },
        onError: (err: Error) => {
          toast({ title: "Failed to save SKILL.md", description: err.message, error: true });
        },
      },
    );
  }

  function handleCancel() {
    markClean("SKILL.md");
    editorDirty = false;
    goto(page.url.pathname);
  }

  function handleDirtyChange(dirty: boolean) {
    editorDirty = dirty;
    if (dirty) {
      markDirty("SKILL.md");
    } else {
      markClean("SKILL.md");
    }
  }

  // Navigation guards
  beforeNavigate(({ cancel }) => {
    if (editorDirty) {
      const confirmed = confirm("You have unsaved changes. Discard them?");
      if (!confirmed) {
        cancel();
        return;
      }
      markClean("SKILL.md");
      editorDirty = false;
    }
  });

  function handleBeforeUnload(e: BeforeUnloadEvent) {
    if (editorDirty) e.preventDefault();
  }

  // ---------------------------------------------------------------------------
  // Enable / Disable toggle
  // ---------------------------------------------------------------------------

  const disableMut = useDisableSkill();

  function toggleDisabled() {
    if (!skill || disableMut.isPending) return;
    disableMut.mutate({ skillId: skill.skillId, disabled: !skill.disabled });
  }

  // ---------------------------------------------------------------------------
  // Delete skill
  // ---------------------------------------------------------------------------

  const deleteMut = useDeleteSkill();
  const deleteDialogOpen = writable(false);
  let deleteChecking = $state(false);

  async function findWorkspacesUsing(ns: string, skillName: string): Promise<string[]> {
    const ref = `@${ns}/${skillName}`;
    const listRes = await fetch("/api/daemon/api/workspaces");
    if (!listRes.ok) return [];
    const workspaces: Array<{ id: string; name: string }> = await listRes.json();

    const using: string[] = [];
    for (const ws of workspaces) {
      const cfgRes = await fetch(`/api/daemon/api/workspaces/${ws.id}/config`);
      if (!cfgRes.ok) continue;
      const { config } = await cfgRes.json();
      const skills: Array<{ name?: string }> = config?.skills ?? [];
      if (skills.some((s) => s.name === ref)) {
        using.push(ws.name ?? ws.id);
      }
    }
    return using;
  }

  async function handleDeleteClick() {
    if (!skill || deleteChecking) return;
    deleteChecking = true;

    const using = await findWorkspacesUsing(namespace, name);
    deleteChecking = false;

    if (using.length > 0) {
      toast({
        title: "Skill is in use",
        description: `Remove it from ${using.join(", ")} first, then try again.`,
        error: true,
      });
      return;
    }

    deleteDialogOpen.set(true);
  }

  function confirmDelete() {
    if (!skill || deleteMut.isPending) return;
    deleteMut.mutate(skill.skillId, {
      onSuccess: () => {
        deleteDialogOpen.set(false);
        toast({ title: "Skill deleted", description: `@${namespace}/${name}` });
        goto("/skills");
      },
      onError: () => {
        toast({ title: "Failed to delete skill", error: true });
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Upload new version
  // ---------------------------------------------------------------------------

  const uploadDialogOpen = writable(false);
</script>

<svelte:window onbeforeunload={handleBeforeUnload} />

<div class="skill-detail">
  {#if skillQuery.isLoading}
    <div class="loading-state">
      <p>Loading skill...</p>
    </div>
  {:else if skillQuery.isError}
    <div class="loading-state">
      <p>Failed to load skill</p>
      <span class="error-hint">Could not fetch @{namespace}/{name}</span>
    </div>
  {:else if skill}
    <div class="page-actions">
      {#if editing}
        <Button size="small" variant="secondary" onclick={handleCancel}>Cancel</Button>
        <Button
          size="small"
          variant={editorDirty ? "primary" : "secondary"}
          onclick={() => handleSave(editorContent)}
          disabled={!editorDirty || publishMut.isPending}
        >
          {publishMut.isPending ? "Saving…" : "Save"}
        </Button>
      {:else}
        <Button size="small" variant="secondary" onclick={startEditing}>Edit</Button>

        <DropdownMenu.Root positioning={{ placement: "bottom-end" }}>
          {#snippet children()}
            <DropdownMenu.Trigger class="more-trigger" aria-label="More options">
              <Icons.TripleDots />
            </DropdownMenu.Trigger>

            <DropdownMenu.Content>
              <DropdownMenu.Item onclick={toggleDisabled}>
                {disableMut.isPending
                  ? skill.disabled
                    ? "Enabling..."
                    : "Disabling..."
                  : skill.disabled
                    ? "Enable"
                    : "Disable"}
              </DropdownMenu.Item>
              <DropdownMenu.Item onclick={() => uploadDialogOpen.set(true)}>
                Replace
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item class="delete-item" onclick={handleDeleteClick}>
                {deleteChecking ? "Checking..." : "Remove skill"}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          {/snippet}
        </DropdownMenu.Root>

        {#if disableMut.isError}
          <span class="action-error">Failed to update</span>
        {/if}
      {/if}
    </div>

    {#if editing}
      <div class="editor-pane">
        <SkillFileEditor
          content={skill.instructions ?? ""}
          bind:editedContent={editorContent}
          onsave={handleSave}
          oncancel={handleCancel}
          ondirtychange={handleDirtyChange}
        />
      </div>
    {:else}
      <div class="preview-content">
        <MarkdownRendered>
          {@html browser ? DOMPurify.sanitize(markdownToHTML(skill.instructions ?? "")) : markdownToHTML(skill.instructions ?? "")}
        </MarkdownRendered>
      </div>
    {/if}
  {/if}
</div>

<Dialog.Root open={deleteDialogOpen}>
  {#snippet children()}
    <Dialog.Content>
      <Dialog.Close />

      {#snippet header()}
        <Dialog.Title>Delete skill</Dialog.Title>
        <Dialog.Description>
          Are you sure you want to delete <strong>@{namespace}/{name}</strong>
          ? This removes all versions and cannot be undone.
        </Dialog.Description>
      {/snippet}

      {#snippet footer()}
        <Dialog.Button onclick={confirmDelete} disabled={deleteMut.isPending} closeOnClick={false}>
          {deleteMut.isPending ? "Deleting..." : "Delete"}
        </Dialog.Button>
        <Dialog.Cancel>Cancel</Dialog.Cancel>
      {/snippet}
    </Dialog.Content>
  {/snippet}
</Dialog.Root>

<Dialog.Root open={uploadDialogOpen}>
  {#snippet children()}
    <Dialog.Content>
      <Dialog.Close />

      {#snippet header()}
        <Dialog.Title>Update skill</Dialog.Title>
        <Dialog.Description>
          Replace <strong>@{namespace}/{name}</strong> with a new version.
        </Dialog.Description>
      {/snippet}

      <SkillLoader
        inline
        forceNamespace={namespace}
        forceName={name}
        onclose={() => uploadDialogOpen.set(false)}
      />

      {#snippet footer()}
        <Dialog.Cancel>Cancel</Dialog.Cancel>
      {/snippet}
    </Dialog.Content>
  {/snippet}
</Dialog.Root>

<style>
  .skill-detail {
    display: flex;
    flex: 1;
    flex-direction: column;
  }

  .loading-state {
    align-items: center;
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-2);
    justify-content: center;
    padding: var(--size-16) 0;

    p {
      font-size: var(--font-size-4);
    }
  }

  .error-hint {
    font-size: var(--font-size-2);
    opacity: 0.6;
  }

  /* --- Page Actions -------------------------------------------------------- */

  .page-actions {
    align-items: center;
    display: flex;
    flex-shrink: 0;
    gap: var(--size-2);
    justify-content: flex-end;
    padding: var(--size-3) var(--size-6);
  }

  :global(.more-trigger) {
    align-items: center;
    background-color: var(--color-surface-2);
    block-size: var(--size-6);
    border: none;
    border-radius: var(--radius-2-5);
    color: var(--text-1);
    cursor: default;
    display: inline-flex;
    inline-size: var(--size-6);
    justify-content: center;
    transition: all 150ms ease;
    user-select: none;
    -webkit-user-select: none;
  }

  :global(.more-trigger:hover) {
    background-color: color-mix(in srgb, var(--color-surface-2), var(--color-text) 5%);
  }

  :global(.delete-item) {
    color: var(--color-error) !important;
  }

  .action-error {
    color: var(--color-error);
    font-size: var(--font-size-1);
  }

  /* --- Editor / Preview ---------------------------------------------------- */

  .editor-pane {
    display: flex;
    flex: 1;
    flex-direction: column;
    overflow: hidden;
    padding: var(--size-4) 0;
  }

  .preview-content {
    flex: 1;
    overflow-y: auto;
    padding: var(--size-2) var(--size-8) var(--size-6);
    scrollbar-width: thin;
  }
</style>
