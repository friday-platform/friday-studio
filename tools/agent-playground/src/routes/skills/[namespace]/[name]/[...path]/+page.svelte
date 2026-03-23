<!--
  Skill reference file page — renders a reference file from the skill archive
  as markdown preview or CodeMirror editor.

  Route params: namespace, name, path (rest param for file path within skill).

  @component
-->

<script lang="ts">
  import { toast } from "@atlas/ui";
  import { beforeNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import MarkdownContent from "$lib/components/markdown-content.svelte";
  import SkillFileEditor from "$lib/components/skill-file-editor.svelte";
  import { useSkillFileContent, useUpdateSkillFile } from "$lib/queries/skills";
  import { markClean, markDirty } from "$lib/stores/skill-editor-state.svelte";

  const namespace = $derived(page.params.namespace ?? "");
  const name = $derived(page.params.name ?? "");
  const path = $derived(page.params.path ?? "");

  const fileContentQuery = useSkillFileContent(
    () => namespace,
    () => name,
    () => path || null,
  );

  const fileContent = $derived(fileContentQuery.data?.content ?? null);

  // ---------------------------------------------------------------------------
  // Edit mode
  // ---------------------------------------------------------------------------

  let editing = $state(false);
  let editorDirty = $state(false);
  let editorContent = $state("");

  function startEditing() {
    editing = true;
  }

  const updateFileMut = useUpdateSkillFile();

  function handleSave(content: string) {
    if (updateFileMut.isPending) return;
    updateFileMut.mutate(
      { namespace, name, path, content },
      {
        onSuccess: () => {
          markClean(path);
          editing = false;
          editorDirty = false;
        },
        onError: () => {
          toast({ title: "Failed to save file", error: true });
        },
      },
    );
  }

  function handleCancel() {
    markClean(path);
    editing = false;
    editorDirty = false;
  }

  function handleDirtyChange(dirty: boolean) {
    editorDirty = dirty;
    if (dirty) {
      markDirty(path);
    } else {
      markClean(path);
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
      markClean(path);
      editing = false;
      editorDirty = false;
    }
  });

  function handleBeforeUnload(e: BeforeUnloadEvent) {
    if (editorDirty) e.preventDefault();
  }
</script>

<svelte:window onbeforeunload={handleBeforeUnload} />

<div class="file-detail">
  <header class="detail-header">
    <div class="header-left">
      <h2 class="file-name">{path}</h2>
    </div>
    {#if editing}
      <div class="edit-actions">
        <button
          class="save-btn"
          class:has-changes={editorDirty}
          onclick={() => handleSave(editorContent)}
          disabled={!editorDirty || updateFileMut.isPending}
        >
          {#if updateFileMut.isPending}
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
      <button class="edit-btn" onclick={startEditing} disabled={fileContent === null}>Edit</button>
    {/if}
  </header>

  <div class="content-pane">
    {#if fileContentQuery.isLoading}
      <p class="status-text">Loading file...</p>
    {:else if fileContentQuery.isError}
      <p class="status-text">Failed to load file</p>
    {:else if fileContent !== null}
      {#if editing}
        <div class="editor-pane">
          <SkillFileEditor
            content={fileContent}
            bind:editedContent={editorContent}
            onsave={handleSave}
            oncancel={handleCancel}
            ondirtychange={handleDirtyChange}
          />
        </div>
      {:else}
        <div class="preview-content">
          <MarkdownContent content={fileContent} />
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .file-detail {
    display: flex;
    flex: 1;
    flex-direction: column;
  }

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

  .edit-btn:hover:not(:disabled) {
    background-color: var(--color-highlight-1);
  }

  .edit-btn:disabled {
    cursor: not-allowed;
    opacity: 0.4;
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

  .content-pane {
    display: flex;
    flex: 1;
    flex-direction: column;
    overflow: hidden;
  }

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

  .status-text {
    color: color-mix(in srgb, var(--color-text), transparent 50%);
    font-size: var(--font-size-3);
    padding: var(--size-6) var(--size-8);
  }
</style>
