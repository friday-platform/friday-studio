<!--
  Compact skill index for the right sidebar on the skills page.
  Shows what skills are, an "Add skill" button, and a count badge.

  @component
  @param {() => void} onadd - Callback when the add skill button is clicked
  @param {number} skillCount - Total number of skills bound to the workspace
-->

<script lang="ts">
  import { Button } from "@atlas/ui";

  type Props = {
    onadd: () => void;
    skillCount: number;
  };

  let { onadd, skillCount }: Props = $props();
</script>

<div class="skill-index">
  <section class="explainer">
    <h3 class="section-title">Skills</h3>
    <p class="explainer-body">
      Skills give agents specialized knowledge on demand. They load only when a task matches — keeping agents fast while extending what they can do.
    </p>
    <a class="learn-more" href="https://agentskills.io/what-are-skills">Learn more →</a>
  </section>

  <div class="section-header">
    <h3 class="section-title">Skills</h3>
    <span class="section-badge">{skillCount}</span>
  </div>

  <Button variant="primary" size="small" onclick={onadd}>Add skill</Button>
</div>

<style>
  .skill-index {
    display: flex;
    flex-direction: column;
    gap: var(--size-2);
    padding-block-start: var(--size-10);
  }

  .section-header {
    align-items: baseline;
    display: flex;
    gap: var(--size-2);
  }

  .section-title {
    font-size: var(--font-size-3);
    font-weight: var(--font-weight-5);
    margin: 0;
  }

  .section-badge {
    color: color-mix(in srgb, var(--color-text), transparent 60%);
    font-size: var(--font-size-0);
    font-variant-numeric: tabular-nums;
    margin-inline-start: auto;
  }

  .explainer {
    border-block-end: 1px solid color-mix(in srgb, var(--color-border-1), transparent 50%);
    display: flex;
    flex-direction: column;
    gap: var(--size-1);
    padding-block-end: var(--size-3);
  }

  .explainer-body {
    color: color-mix(in srgb, var(--color-text), transparent 30%);
    font-size: var(--font-size-1);
    line-height: 1.5;
    margin: 0;
  }

  .learn-more {
    color: var(--color-info);
    font-size: var(--font-size-1);
    text-decoration: none;
  }

  .learn-more:hover {
    text-decoration: underline;
  }

</style>
