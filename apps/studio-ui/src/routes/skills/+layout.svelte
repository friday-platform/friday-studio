<!--
  Unified skills layout — two-pane view with skill tree on left, content on right.
  All routes under /skills/ inherit this layout except edit (which opts out via @).

  @component
-->

<script lang="ts">
  import { Button, Dialog, IconSmall, ListDetail } from "@atlas/ui";
  import { page } from "$app/state";
  import SkillLoader from "$lib/components/skills/skill-loader.svelte";
  import SkillsShImport from "$lib/components/skills/skills-sh-import.svelte";
  import SkillsTree from "$lib/components/skills/skills-tree.svelte";
  import { getDirtyFiles } from "$lib/stores/skill-editor-state.svelte";
  import { writable } from "svelte/store";

  const { children } = $props();

  const hasActiveSkill = $derived(
    (page.params.namespace ?? "").length > 0 && (page.params.name ?? "").length > 0,
  );

  const dirtyFiles = $derived(getDirtyFiles());
  const addDialogOpen = writable(false);

  /** Which sub-flow of the Add Skill dialog is active. */
  let addMode = $state<"upload" | "import">("upload");

  // Reset to Upload whenever the dialog opens so we always land on a known tab.
  $effect(() => {
    const unsub = addDialogOpen.subscribe((open) => {
      if (open) addMode = "upload";
    });
    return unsub;
  });
</script>

<ListDetail>
  {#snippet header()}
    <h1>Skills</h1>
    <Button
      variant="secondary"
      size="small"
      aria-label="Add skill"
      onclick={() => addDialogOpen.set(true)}
    >
      {#snippet prepend()}
        <IconSmall.Plus />
      {/snippet}
      Add
    </Button>
  {/snippet}

  {#snippet sidebar()}
    <SkillsTree {dirtyFiles} />
  {/snippet}

  {@render children?.()}
</ListDetail>

<Dialog.Root open={addDialogOpen}>
  {#snippet children()}
    <Dialog.Content size="auto">
      <Dialog.Close />

      {#snippet header()}
        <Dialog.Title>Add skill</Dialog.Title>
        <Dialog.Description>
          Package your expertise into a skill agents can load on demand.
        </Dialog.Description>
      {/snippet}

      <div class="add-tabs" role="tablist">
        <button
          type="button"
          class="tab"
          class:active={addMode === "upload"}
          role="tab"
          aria-selected={addMode === "upload"}
          onclick={() => {
            addMode = "upload";
          }}
        >
          Upload file / folder
        </button>
        <button
          type="button"
          class="tab"
          class:active={addMode === "import"}
          role="tab"
          aria-selected={addMode === "import"}
          onclick={() => {
            addMode = "import";
          }}
        >
          Import from skills.sh
        </button>
      </div>

      {#if addMode === "upload"}
        <SkillLoader inline onclose={() => addDialogOpen.set(false)} />
      {:else}
        <SkillsShImport onclose={() => addDialogOpen.set(false)} />
      {/if}

      {#snippet footer()}
        <Dialog.Cancel>Cancel</Dialog.Cancel>
      {/snippet}
    </Dialog.Content>
  {/snippet}
</Dialog.Root>

<style>
  .add-tabs {
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    gap: var(--size-1);
    /* Dialog.Content uses size="auto" (no max-inline-size) — claim a
       predictable wide box so both tab contents have breathing room. */
    inline-size: min(720px, 92vw);
    justify-content: center;
    margin-block-end: var(--size-4);
    padding-block-end: var(--size-2);
  }

  .tab {
    background: transparent;
    border: none;
    border-block-end: 2px solid transparent;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    margin-block-end: -2px;
    padding-block: var(--size-1);
    padding-inline: var(--size-3);
    transition: color 120ms ease, border-color 120ms ease;
  }

  .tab:hover {
    color: var(--color-text);
  }

  .tab.active {
    border-block-end-color: var(--color-text);
    color: var(--color-text);
  }
</style>
