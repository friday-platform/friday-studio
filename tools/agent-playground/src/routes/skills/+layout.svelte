<!--
  Unified skills layout — two-pane view with skill tree on left, content on right.
  All routes under /skills/ inherit this layout except edit (which opts out via @).

  @component
-->

<script lang="ts">
  import { Button, Dialog, IconSmall, Tooltip } from "@atlas/ui";
  import { page } from "$app/state";
  import SkillLoader from "$lib/components/skills/skill-loader.svelte";
  import SkillsTree from "$lib/components/skills/skills-tree.svelte";
  import { getDirtyFiles } from "$lib/stores/skill-editor-state.svelte";
  import { writable } from "svelte/store";

  const { children } = $props();

  const hasActiveSkill = $derived(
    (page.params.namespace ?? "").length > 0 && (page.params.name ?? "").length > 0,
  );

  const dirtyFiles = $derived(getDirtyFiles());
  const addDialogOpen = writable(false);
</script>

<div class="skills-layout">
  <aside class="skills-sidebar">
    <div class="sidebar-header">
      <h1 class="sidebar-title">Skills</h1>
      <div class="header-actions">
        <Tooltip label="Add Skill" openDelay={150}>
          <Button variant="secondary" size="icon" aria-label="Add skill" onclick={() => addDialogOpen.set(true)}>
            <IconSmall.Plus />
          </Button>
        </Tooltip>
      </div>
    </div>

    <SkillsTree {dirtyFiles} />
  </aside>

  <div class="skills-content">
    {@render children?.()}
  </div>
</div>

<Dialog.Root open={addDialogOpen}>
  {#snippet children()}
    <Dialog.Content>
      <Dialog.Close />

      {#snippet header()}
        <Dialog.Title>Add skill</Dialog.Title>
        <Dialog.Description>
          Package your expertise into a skill agents can load on demand.
        </Dialog.Description>
      {/snippet}

      <SkillLoader inline onclose={() => addDialogOpen.set(false)} />

      {#snippet footer()}
        <Dialog.Cancel>Cancel</Dialog.Cancel>
      {/snippet}
    </Dialog.Content>
  {/snippet}
</Dialog.Root>

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

  .header-actions {
    display: flex;
    gap: var(--size-1);
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
