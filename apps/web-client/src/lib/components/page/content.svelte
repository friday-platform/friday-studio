<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";

  type Props = {
    children: Snippet;
    prepend?: Snippet;
    header?: Snippet;
    description?: Snippet;
    padded?: boolean;
    scrollable?: boolean;
  };

  let {
    children,
    prepend,
    header,
    description,
    padded = true,
    scrollable = true,
    ...props
  }: Props & HTMLAttributes<HTMLDivElement> = $props();
</script>

<div class="page" class:scrollable {...props}>
  {#if prepend}
    {@render prepend()}
  {/if}
  <div class="content" class:padded>
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
  </div>
</div>

<style>
  .page {
    block-size: 100%;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .scrollable {
    overflow: auto;
    scrollbar-width: thin;
  }

  .content {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--size-10);
    overflow: hidden;

    &.padded {
      padding-block: var(--size-12);
      padding-inline: var(--size-14);
    }

    .scrollable & {
      overflow: visible;
    }
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
