<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = { children: Snippet; prepend?: Snippet; header?: Snippet; description?: Snippet };

  let { children, prepend, header, description }: Props = $props();
</script>

<div class="page">
  {#if prepend}
    {@render prepend()}
  {/if}
  <article class="content">
    {#if header || description}
      <header>
        {#if header}
          <div class="title">
            {@render header()}
          </div>
        {/if}
        {#if description}
          {@render description()}
        {/if}
      </header>
    {/if}

    {@render children()}
  </article>
</div>

<style>
  .content {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-10);
    padding-block: var(--size-12);
    padding-inline: var(--size-14);
  }

  .page {
    overflow: auto;
    padding-inline: 0 var(--size-14);
    scrollbar-width: thin;
  }

  .title {
    align-items: center;
    display: flex;
    gap: var(--size-3);

    :global(h1) {
      font-size: var(--font-size-8);
      font-weight: var(--font-weight-6);
    }
  }

  header :global(p) {
    font-size: var(--font-size-5);
    font-weight: var(--font-weight-5);
    line-height: var(--font-lineheight-3);
    margin-block: var(--size-1-5) 0;
    max-inline-size: 80ch;
    opacity: 0.6;
    text-wrap-style: balance;
  }
</style>
