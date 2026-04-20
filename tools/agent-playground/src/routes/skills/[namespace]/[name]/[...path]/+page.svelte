<!--
  Skill reference file page — renders a reference file from the skill archive
  as markdown preview or CodeMirror editor.

  Route params: namespace, name, path (rest param for file path within skill).

  @component
-->

<script lang="ts">
  import { browser } from "$app/environment";
  import { Button, MarkdownRendered, markdownToHTML, toast } from "@atlas/ui";
  import DOMPurify from "dompurify";
  import { createQuery } from "@tanstack/svelte-query";
  import { beforeNavigate, goto } from "$app/navigation";
  import { page } from "$app/state";
  import SkillFileEditor from "$lib/components/skills/skill-file-editor.svelte";
  import { skillQueries } from "$lib/queries";
  import { useUpdateSkillFile } from "$lib/queries/skills";
  import { markClean, markDirty } from "$lib/stores/skill-editor-state.svelte";

  const namespace = $derived(page.params.namespace ?? "");
  const name = $derived(page.params.name ?? "");
  const path = $derived(page.params.path ?? "");

  const fileContentQuery = createQuery(() => ({
    ...skillQueries.fileContent(namespace, name, path),
    enabled: namespace.length > 0 && name.length > 0 && path.length > 0,
  }));

  const fileContent = $derived(fileContentQuery.data?.content ?? null);

  // ---------------------------------------------------------------------------
  // Edit mode (URL-driven via ?edit query param)
  // ---------------------------------------------------------------------------

  const editing = $derived(page.url.searchParams.has("edit"));
  let editorDirty = $state(false);
  let editorContent = $state("");

  function startEditing() {
    goto("?edit");
  }

  const updateFileMut = useUpdateSkillFile();

  function handleSave(content: string) {
    if (updateFileMut.isPending) return;
    updateFileMut.mutate(
      { namespace, name, path, content },
      {
        onSuccess: () => {
          markClean(path);
          editorDirty = false;
          goto(page.url.pathname);
        },
        onError: () => {
          toast({ title: "Failed to save file", error: true });
        },
      },
    );
  }

  function handleCancel() {
    markClean(path);
    editorDirty = false;
    goto(page.url.pathname);
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
      editorDirty = false;
    }
  });

  function handleBeforeUnload(e: BeforeUnloadEvent) {
    if (editorDirty) e.preventDefault();
  }

  /**
   * Scroll to `#anchor` once the rendered markdown is in the DOM. Required
   * because the route is loaded client-side from the skill archive — by
   * the time the page mounts, the browser has already decided where to
   * scroll (to the top, since the content didn't exist yet). We re-try
   * after every fileContent + hash change.
   */
  const hash = $derived(page.url.hash);
  $effect(() => {
    if (!browser) return;
    if (!fileContent) return;
    if (!hash || hash.length < 2) return;
    // Let the markdown HTML land in the DOM first, then scroll.
    const id = decodeURIComponent(hash.slice(1));
    // Use rAF to wait for layout after @html update.
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  });
</script>

<svelte:window onbeforeunload={handleBeforeUnload} />

<div class="file-detail">
  <div class="page-actions">
    {#if editing}
      <Button size="small" variant="secondary" onclick={handleCancel}>Cancel</Button>
      <Button
        size="small"
        variant={editorDirty ? "primary" : "secondary"}
        onclick={() => handleSave(editorContent)}
        disabled={!editorDirty || updateFileMut.isPending}
      >
        {updateFileMut.isPending ? "Saving…" : "Save"}
      </Button>
    {:else}
      <Button size="small" variant="secondary" onclick={startEditing} disabled={fileContent === null}>Edit</Button>
    {/if}
  </div>

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
          <MarkdownRendered>
            {@html browser ? DOMPurify.sanitize(markdownToHTML(fileContent)) : markdownToHTML(fileContent)}
          </MarkdownRendered>
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

  .page-actions {
    align-items: center;
    display: flex;
    flex-shrink: 0;
    gap: var(--size-2);
    justify-content: flex-end;
    padding: var(--size-3) var(--size-6);
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
    padding: var(--size-4) 0;
  }

  .preview-content {
    flex: 1;
    overflow-y: auto;
    padding: var(--size-2) var(--size-8) var(--size-6);
    scrollbar-width: thin;
  }

  .status-text {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-3);
    padding: var(--size-6) var(--size-8);
  }
</style>
