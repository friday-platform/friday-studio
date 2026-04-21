<!--
  Skill reference file page — renders a reference file from the skill archive
  as markdown preview or CodeMirror editor.

  Route params: namespace, name, path (rest param for file path within skill).

  @component
-->

<script lang="ts">
  import { browser } from "$app/environment";
  import {
    Button,
    MarkdownRendered,
    highlightCode,
    languageFromPath,
    markdownToHTML,
    toast,
  } from "@atlas/ui";
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

  /** Markdown files get the full prose renderer; everything else is code. */
  const isMarkdown = $derived(path.toLowerCase().endsWith(".md"));
  /** Shiki language id, or null for plain-text fallback. */
  const codeLang = $derived(isMarkdown ? null : languageFromPath(path));
  const highlightedCode = $derived.by(() => {
    if (isMarkdown || fileContent === null) return null;
    return highlightCode(fileContent, codeLang);
  });

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
      {:else if isMarkdown}
        <div class="preview-content">
          <MarkdownRendered>
            {@html browser ? DOMPurify.sanitize(markdownToHTML(fileContent)) : markdownToHTML(fileContent)}
          </MarkdownRendered>
        </div>
      {:else if highlightedCode}
        <!-- Shiki emits a full <pre><code>…</code></pre>; DOMPurify keeps
             the inline-style colors it adds for syntax highlighting. -->
        <div class="code-preview">
          {@html browser ? DOMPurify.sanitize(highlightedCode) : highlightedCode}
        </div>
      {:else}
        <!-- Unknown file type: render as plain text so users can still read
             it rather than seeing a broken markdown render. -->
        <pre class="code-preview plain">{fileContent}</pre>
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

  .code-preview {
    background-color: var(--color-surface-2);
    border-radius: var(--radius-3);
    flex: 1;
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: var(--font-size-1);
    line-height: var(--font-lineheight-1);
    margin: var(--size-3) var(--size-6) var(--size-6);
    overflow: auto;
    padding: var(--size-4);
    scrollbar-width: thin;
    white-space: pre;

    :global(pre) {
      background: transparent;
      margin: 0;
      padding: 0;
    }
    :global(code) {
      background: transparent;
      padding: 0;
    }
  }

  .code-preview.plain {
    color: var(--color-text);
  }

  .status-text {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-3);
    padding: var(--size-6) var(--size-8);
  }
</style>
