<script lang="ts">
  import { getAppContext } from "$lib/app-context.svelte";

  const ctx = getAppContext();
</script>

{#if ctx.usage.showSidebarWarning}
  <div class="component">
    <div class="header">
      <div class="progress" style:--usage="{ctx.usage.percent}%"></div>
      <span class="usage-heading">{ctx.usage.remaining}% left</span>
    </div>
    <p>
      You've used {ctx.usage.percent}% of your monthly limit.
    </p>

    <a href="mailto:support@hellofriday.ai">Contact us to upgrade.</a>
  </div>
{/if}

<style>
  .component {
    margin-block: 0 var(--size-5);
    padding-inline: var(--size-1);
  }

  .usage-heading {
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-5);
    opacity: 0.6;
  }

  p {
    font-size: var(--font-size-1);
    font-weight: var(--font-weight-4-5);
    line-height: var(--font-lineheight-2);
    margin-block: var(--size-1-5) var(--size-3);
    opacity: 0.6;
    text-wrap-style: balance;
  }

  a {
    color: var(--color-text);
    font-size: var(--font-size-1);
    text-decoration-line: underline;
    text-decoration-color: color-mix(in srgb, var(--color-text), transparent 80%);
    text-underline-offset: 0.25em;
    transition: text-underline-offset 0.2s ease;

    &:hover {
      text-underline-offset: 0.15em;
    }
  }

  .header {
    align-items: center;
    display: flex;
    gap: var(--size-2);
  }

  .progress {
    background-color: var(--color-white);
    block-size: calc(var(--size-scale) * 0.4375rem);
    border-radius: var(--radius-round);
    box-shadow: var(--shadow-1);
    overflow: hidden;
    padding: var(--size-0-5);
    inline-size: var(--size-7);

    &::after {
      background-color: var(--blue-2);
      border-radius: var(--radius-round);
      block-size: 100%;
      content: "";
      display: block;
      inline-size: var(--usage);
    }
  }
</style>
