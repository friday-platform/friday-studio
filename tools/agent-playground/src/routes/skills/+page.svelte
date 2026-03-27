<!--
  Skills empty state — shown when no skill is selected in the tree.
  The skill list is handled by SkillsTree in the layout sidebar.

  @component
-->

<script lang="ts">
  import SkillLoader from "$lib/components/skills/skill-loader.svelte";
</script>

<div class="empty-state">
  <div class="empty-content">
    <h2 class="empty-title">Add a skill</h2>
    <p class="empty-description">
      Package your expertise into skills. Agents load the right one for
      each task and follow it exactly.
      <a
        class="learn-more"
        href="https://platform.hellofriday.ai/docs/tools/skills"
        target="_blank"
        rel="noopener noreferrer"
      >
        Learn more
      </a>
    </p>
  </div>
  <SkillLoader inline />
</div>

<style>
  .empty-state {
    align-items: center;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-6);
    inline-size: 100%;
    justify-content: center;
    max-inline-size: 460px;
    margin-inline: auto;
    padding: var(--size-10);
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
    color: color-mix(in srgb, var(--color-text), transparent 40%);
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
