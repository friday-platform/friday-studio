<!--
  Skill detail page — renders SKILL.md as markdown preview or CodeMirror editor.
  Shown when a skill is expanded in the tree but no specific reference file is selected.

  @component
-->

<script lang="ts">
  import { Dialog, DropdownMenu, toast } from "@atlas/ui";
  import { beforeNavigate, goto } from "$app/navigation";
  import { page } from "$app/state";
  import { writable } from "svelte/store";
  import SkillLoader from "$lib/components/skill-loader.svelte";
  import MarkdownContent from "$lib/components/markdown-content.svelte";
  import SkillFileEditor from "$lib/components/skill-file-editor.svelte";
  import { useDeleteSkill, useDisableSkill, usePublishSkill, useSkill } from "$lib/queries/skills";
  import { markClean, markDirty } from "$lib/stores/skill-editor-state.svelte";

  const namespace = $derived(page.params.namespace ?? "");
  const name = $derived(page.params.name ?? "");

  const skillQuery = useSkill(
    () => namespace,
    () => name,
  );

  const skill = $derived(skillQuery.data?.skill);

  // ---------------------------------------------------------------------------
  // Edit mode
  // ---------------------------------------------------------------------------

  let editing = $state(false);
  let editorDirty = $state(false);
  let editorContent = $state("");

  function startEditing() {
    editing = true;
  }

  const publishMut = usePublishSkill();

  function handleSave(content: string) {
    if (!skill || publishMut.isPending) return;
    publishMut.mutate(
      {
        namespace,
        name,
        instructions: content,
        title: skill.title ?? undefined,
        description: skill.description ?? undefined,
      },
      {
        onSuccess: () => {
          markClean("SKILL.md");
          editing = false;
          editorDirty = false;
        },
        onError: () => {
          toast({ title: "Failed to save SKILL.md", error: true });
        },
      },
    );
  }

  function handleCancel() {
    markClean("SKILL.md");
    editing = false;
    editorDirty = false;
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
      editing = false;
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
    disableMut.mutate({
      skillId: skill.skillId,
      disabled: !skill.disabled,
    });
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
        title: "Cannot delete skill",
        description: `Referenced by: ${using.join(", ")}`,
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
    <header class="detail-header">
      <div class="header-left">
        <h2 class="file-name">SKILL.md</h2>
        {#if skill.disabled}
          <span class="disabled-badge">DISABLED</span>
        {/if}
      </div>
      <div class="header-actions">
        {#if editing}
          <div class="edit-actions">
            <button
              class="save-btn"
              class:has-changes={editorDirty}
              onclick={() => handleSave(editorContent)}
              disabled={!editorDirty || publishMut.isPending}
            >
              {#if publishMut.isPending}
                Saving...
              {:else if editorDirty}
                Save
              {:else}
                Saved
              {/if}
            </button>
            <button class="cancel-btn" onclick={handleCancel}>Cancel</button>
            <span class="edit-hint">Cmd+S / Esc</span>
          </div>
        {:else}
          <button class="edit-btn" onclick={startEditing}>Edit</button>
        {/if}
        <DropdownMenu.Root positioning={{ placement: "bottom-end" }}>
          {#snippet children()}
            <DropdownMenu.Trigger class="action-trigger">
              Actions
              <svg class="caret" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M4 6l4 4 4-4" />
              </svg>
            </DropdownMenu.Trigger>

            <DropdownMenu.Content>
              <DropdownMenu.Item onclick={toggleDisabled}>
                {disableMut.isPending
                  ? (skill.disabled ? "Enabling..." : "Disabling...")
                  : (skill.disabled ? "Enable" : "Disable")}
              </DropdownMenu.Item>
              <DropdownMenu.Item onclick={() => goto(`/skills/${namespace}/${name}/edit`)}>
                Edit YAML
              </DropdownMenu.Item>
              <DropdownMenu.Item onclick={() => uploadDialogOpen.set(true)}>
                Upload new version
              </DropdownMenu.Item>
              <DropdownMenu.Item class="delete-item" onclick={handleDeleteClick}>
                {deleteChecking ? "Checking..." : "Delete"}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          {/snippet}
        </DropdownMenu.Root>
        {#if disableMut.isError}
          <span class="action-error">Failed to update</span>
        {/if}
      </div>
    </header>

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
        <MarkdownContent content={skill.instructions ?? ""} />
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
          Are you sure you want to delete <strong>@{namespace}/{name}</strong>? This removes all versions and cannot be undone.
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
        <Dialog.Title>Upload new version</Dialog.Title>
        <Dialog.Description>
          Upload a SKILL.md file or folder to publish a new version of <strong>@{namespace}/{name}</strong>.
        </Dialog.Description>
      {/snippet}

      <SkillLoader inline forceNamespace={namespace} forceName={name} onclose={() => uploadDialogOpen.set(false)} />

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

  /* --- Header -------------------------------------------------------------- */

  .detail-header {
    align-items: center;
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    flex-shrink: 0;
    justify-content: space-between;
    padding: var(--size-4) var(--size-6);
  }

  .header-left {
    align-items: center;
    display: flex;
    gap: var(--size-3);
  }

  .file-name {
    color: color-mix(in srgb, var(--color-text), transparent 20%);
    font-family: var(--font-family-monospace);
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
  }

  .disabled-badge {
    background-color: color-mix(in srgb, var(--color-warning), transparent 85%);
    border-radius: var(--radius-1);
    color: var(--color-warning);
    font-size: var(--font-size-0);
    font-weight: var(--font-weight-6);
    letter-spacing: 0.05em;
    padding: var(--size-0-5) var(--size-2);
  }

  .header-actions {
    align-items: center;
    display: flex;
    gap: var(--size-3);
  }

  .edit-btn {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    font-size: var(--font-size-1);
    padding: var(--size-1) var(--size-3);
    transition: background-color 100ms ease;
  }

  .edit-btn:hover {
    background-color: var(--color-highlight-1);
  }

  .edit-hint {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-1);
  }

  .edit-actions {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .save-btn {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: default;
    font-size: var(--font-size-1);
    padding: var(--size-1) var(--size-3);
    transition: background-color 100ms ease, border-color 100ms ease, color 100ms ease;
  }

  .save-btn.has-changes {
    background-color: var(--color-accent);
    border-color: var(--color-accent);
    color: var(--color-on-accent, #fff);
    cursor: pointer;
  }

  .save-btn.has-changes:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  .save-btn:disabled {
    opacity: 0.5;
  }

  .cancel-btn {
    background: none;
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    font-size: var(--font-size-1);
    padding: var(--size-1) var(--size-3);
    transition: background-color 100ms ease;
  }

  .cancel-btn:hover {
    background-color: var(--color-surface-2);
  }

  :global(.action-trigger) {
    align-items: center;
    background: none;
    border: none;
    color: var(--color-text);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    gap: var(--size-1);
    opacity: 0.6;
    padding: 0;
  }

  :global(.action-trigger:hover) {
    opacity: 0.9;
  }

  :global(.delete-item) {
    color: var(--color-error) !important;
  }

  .caret {
    block-size: 14px;
    inline-size: 14px;
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
    padding: var(--size-4) var(--size-6);
  }

  .preview-content {
    flex: 1;
    overflow-y: auto;
    padding: var(--size-6) var(--size-8);
    scrollbar-width: thin;
  }
</style>
