<!--
  Skills empty state — shown when no skill is selected in the tree.
  The skill list is handled by SkillsTree in the layout sidebar.

  @component
-->

<script lang="ts">
  import SkillLoader from "$lib/components/skills/skill-loader.svelte";
</script>

<div class="empty-state">
  <SkillLoader inline />
</div>

<style>
  .empty-state {
    align-items: center;
    display: flex;
    flex: 1;
    justify-content: center;
    padding: var(--size-10);
  }
</style>
