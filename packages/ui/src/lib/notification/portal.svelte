<script lang="ts">
  import { fly, scale } from "svelte/transition";
  import { toaster } from "./toast.svelte";

  const {
    elements: { content, title },
    states: { toasts },
    actions: { portal },
  } = toaster;
</script>

<div use:portal>
  {#if $toasts.length}
    <div
      class="container"
      style:--rows={$toasts.length - 1}
      in:fly={{ y: "10%" }}
      out:scale={{ start: 0.8, opacity: 0 }}
    >
      {#each $toasts as { id, data } (id)}
        <article {...$content(id)} use:content class="toast" class:error={Boolean(data.error)}>
          <h2 {...$title(id)} use:title>
            {data.title}
          </h2>

          {#if data.description}
            <p>{data.description}</p>
          {/if}

          {#if data.viewLabel && data.viewAction}
            <footer>
              <button type="button" onclick={data.viewAction}>
                {data.viewLabel}
              </button>
            </footer>
          {/if}
        </article>
      {/each}
    </div>
  {/if}
</div>

<style>
  .container {
    display: grid;
    gap: var(--size-1);
    grid-auto-flow: row;
    justify-items: stretch;
    inset-block-end: var(--size-6);
    inset-inline-end: var(--size-6);
    position: fixed;
    transition: all 150ms ease-out;
    z-index: var(--layer-5);
  }

  .toast {
    --index: 0;

    align-items: start;
    background-color: var(--color-surface-1);
    border-radius: var(--radius-4);
    block-size: fit-content;
    box-shadow: var(--shadow-1);
    display: flex;
    flex-direction: column;
    min-inline-size: var(--size-56);
    inline-size: fit-content;
    line-height: var(--font-lineheight-1);
    padding: var(--size-3);
    position: relative;
    transition: all 150ms ease-out;
    transform-origin: 50% 0%;

    h2 {
      font-size: var(--font-size-3);
      font-weight: var(--font-weight-5);
    }

    p {
      font-size: var(--font-size-2);
      font-weight: var(--font-weight-5);
      margin-block-start: var(--size-1);
      max-inline-size: var(--size-56);
      opacity: 0.6;
    }

    button {
      border: var(--size-px) solid var(--color-border-1);
      border-radius: var(--radius-2);
      block-size: var(--size-5);
      font-size: var(--font-size-1);
      font-weight: var(--font-weight-5);
      margin-block-start: var(--size-2);
      padding-inline: var(--size-1-5);
    }

    &.error {
      --toast-shadow-color: color-mix(in oklch, var(--color-error), var(--color-surface-1) 80%);

      background-color: color-mix(in oklch, var(--color-error), var(--color-surface-1) 98%);
      color: var(--color-error);
    }
  }

  h2 {
    font-weight: var(--font-weight-5);
  }
</style>
