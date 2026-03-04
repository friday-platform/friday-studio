<script lang="ts">
  import Document from "$lib/components/primitives/document.svelte";
  import MarkdownContent from "$lib/components/primitives/markdown-content.svelte";

  type Props = {
    skillDraft: {
      name: string;
      namespace: string;
      title?: string;
      description: string;
      instructions: string;
    };
  };

  let { skillDraft }: Props = $props();
</script>

<Document name="Skill Draft: {skillDraft.name}">
  <div class="skill-draft">
    <div class="header">
      <span class="badge">Draft - Pending Approval</span>
    </div>
    <p class="description">{skillDraft.description}</p>
    <div class="instructions">
      <h3>Instructions</h3>
      <MarkdownContent content={skillDraft.instructions} />
    </div>
  </div>
</Document>

<style>
  .skill-draft {
    padding: var(--size-4);
  }
  .header {
    margin-bottom: var(--size-4);
  }
  .badge {
    background: var(--color-warning-subtle);
    color: var(--color-warning);
    padding: var(--size-1) var(--size-2);
    border-radius: var(--radius-1);
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-6);
  }
  .description {
    color: var(--color-text-secondary);
    margin-bottom: var(--size-4);
  }
  .instructions {
    border-top: 1px solid var(--color-border);
    padding-top: var(--size-4);
  }
</style>
