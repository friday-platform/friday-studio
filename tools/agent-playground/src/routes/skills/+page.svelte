<!--
  Skills empty state — shown when no skill is selected in the tree.
  The skill list is handled by SkillsTree in the layout sidebar.

  @component
-->

<script lang="ts">
  import SkillLoader from "$lib/components/skills/skill-loader.svelte";
  import SkillsShImport from "$lib/components/skills/skills-sh-import.svelte";

  /** Which sub-flow of the empty-state landing page is active. */
  let mode = $state<"upload" | "import">("upload");
</script>

<div class="empty-state">
  <div class="empty-content">
    <h2 class="empty-title">Add a skill</h2>
    <p class="empty-description">
      Package your expertise into skills. Agents load the right one for
      each task and follow it exactly.
      <a
        class="learn-more"
        href="https://docs.hellofriday.ai/tools/skills"
        target="_blank"
        rel="noopener noreferrer"
      >
        Learn more
      </a>
    </p>
  </div>

  <div class="mode-tabs" role="tablist">
    <button
      type="button"
      class="tab"
      class:active={mode === "upload"}
      role="tab"
      aria-selected={mode === "upload"}
      onclick={() => {
        mode = "upload";
      }}
    >
      Upload file / folder
    </button>
    <button
      type="button"
      class="tab"
      class:active={mode === "import"}
      role="tab"
      aria-selected={mode === "import"}
      onclick={() => {
        mode = "import";
      }}
    >
      Import from skills.sh
    </button>
  </div>

  {#if mode === "upload"}
    <SkillLoader inline />
  {:else}
    <SkillsShImport />
  {/if}
</div>

<style>
  .empty-state {
    align-items: center;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-4);
    inline-size: 100%;
    justify-content: center;
    max-inline-size: 560px;
    margin-inline: auto;
    padding: var(--size-10);
  }

  .mode-tabs {
    border-block-end: 1px solid var(--color-border-1);
    display: flex;
    gap: var(--size-1);
    inline-size: 100%;
    justify-content: center;
  }

  .tab {
    background: transparent;
    border: none;
    border-block-end: 2px solid transparent;
    color: color-mix(in srgb, var(--color-text), transparent 40%);
    cursor: pointer;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    margin-block-end: -1px;
    padding-block: var(--size-1-5);
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

  .empty-content {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    max-inline-size: 420px;
    text-align: center;
  }

  .empty-title {
    font-size: var(--font-size-5);
    font-weight: var(--font-weight-6);
  }

  .empty-description {
    color: color-mix(in srgb, var(--color-text), transparent 25%);
    font-size: var(--font-size-2);
    line-height: var(--line-height-3);
  }

  .learn-more {
    color: var(--color-text);
    opacity: 0.7;
    text-decoration: underline;
    text-underline-offset: 2px;
    transition: opacity 100ms ease;

    &:hover {
      opacity: 1;
    }
  }
</style>
