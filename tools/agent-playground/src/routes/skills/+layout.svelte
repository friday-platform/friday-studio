<!--
  Unified skills layout — two-pane view with skill tree on left, content on right.
  All routes under /skills/ inherit this layout except edit (which opts out via @).

  @component
-->

<script lang="ts">
  import { page } from "$app/state";
  import SkillLoader from "$lib/components/skill-loader.svelte";
  import SkillsTree from "$lib/components/skills-tree.svelte";
  import { getDirtyFiles } from "$lib/stores/skill-editor-state.svelte";

  const { children } = $props();

  const hasActiveSkill = $derived(
    (page.params.namespace ?? "").length > 0 && (page.params.name ?? "").length > 0,
  );

  const dirtyFiles = $derived(getDirtyFiles());

  let showUploader = $state(false);
</script>

<div class="skills-layout">
  <aside class="skills-sidebar">
    <div class="sidebar-header">
      <h1 class="sidebar-title">Skills</h1>
      <button
        class="add-btn"
        onclick={() => {
          showUploader = !showUploader;
        }}
      >
        {showUploader ? "Cancel" : "+ Add"}
      </button>
    </div>

    {#if showUploader}
      <div class="sidebar-uploader">
        <SkillLoader
          inline
          onclose={() => {
            showUploader = false;
          }}
        />
      </div>
    {/if}

    <SkillsTree {dirtyFiles} />
  </aside>

  <div class="skills-content">
    {@render children?.()}
  </div>
</div>

<style>
  .skills-layout {
    display: flex;
    block-size: 100%;
  }

  .skills-sidebar {
    border-inline-end: 1px solid var(--color-border-1);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    gap: var(--size-4);
    inline-size: 280px;
    overflow-y: auto;
    padding: var(--size-6) var(--size-4);
    scrollbar-width: thin;
  }

  .sidebar-header {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  .sidebar-title {
    font-size: var(--font-size-5);
    font-weight: var(--font-weight-6);
  }

  .add-btn {
    background-color: var(--color-surface-2);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-2);
    color: var(--color-text);
    cursor: pointer;
    font-size: var(--font-size-1);
    padding: var(--size-1) var(--size-3);
    transition: background-color 100ms ease;
  }

  .add-btn:hover {
    background-color: var(--color-highlight-1);
  }

  .sidebar-uploader {
    border-block-end: 1px solid var(--color-border-1);
    padding-block-end: var(--size-4);
  }

  .skills-content {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-inline-size: 0;
    overflow-y: auto;
    scrollbar-width: thin;
  }
</style>
