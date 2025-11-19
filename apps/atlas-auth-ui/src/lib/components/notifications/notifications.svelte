<script lang="ts" module>
import { createToaster } from "@melt-ui/svelte";

export type ToastData = { title: string; error: boolean };

const {
  elements: { content, title },
  helpers,
  states: { toasts },
  actions: { portal },
} = createToaster<ToastData>({ closeDelay: 4000 });

export const toast = (title: string, error = false) => helpers.addToast({ data: { title, error } });
</script>

<script lang="ts">
  import { fly, scale } from "svelte/transition";
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
        <div {...$content(id)} use:content class="toast" class:error={data.error}>
          <h2 {...$title(id)} use:title>
            {data.title}
          </h2>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .container {
    display: grid;
    gap: var(--size-1);
    grid-auto-flow: row;
    grid-template-rows: repeat(var(--rows), 0.125rem) var(--size-7);
    justify-items: stretch;
    inset-block-end: var(--size-8);
    inset-inline-start: 50%;
    position: fixed;
    transition: all 150ms ease-out;
    transform: translate3d(-50%, 0, 0);
    z-index: var(--layer-5);

    &:hover {
      grid-template-rows: repeat(var(--rows), var(--size-7)) var(--size-7);
    }
  }

  .toast {
    --index: 0;

    --toast-shadow-color: color-mix(in oklch, var(--accent-1), var(--background-1) 80%);

    align-items: center;
    background-color: color-mix(in srgb, var(--background-1), var(--accent-1) 3%);
    block-size: var(--size-7);
    border-radius: var(--radius-3);
    box-shadow:
      var(--shadow-1),
      0px 0px 0px 1px var(--toast-shadow-color);
    display: flex;
    justify-content: center;
    min-inline-size: fit-content;
    line-height: var(--font-lineheight-1);
    opacity: 0;
    padding-inline: var(--size-3);
    position: relative;
    visibility: hidden;
    text-align: center;
    transition: all 150ms ease-out;
    transform-origin: 50% 0%;

    &:nth-last-child(-n + 3) {
      opacity: 0.8;
      visibility: visible;
      --index: 3;
      z-index: var(--layer-2);
    }

    &:nth-last-child(-n + 2) {
      --index: 2;
      z-index: var(--layer-3);
    }

    &:nth-last-child(-n + 1) {
      --index: 1;
      z-index: var(--layer-4);
    }

    &:last-child {
      opacity: 1;
      z-index: var(--layer-5);
    }

    &:not(:last-child) {
      transform: scale(calc(1 - (var(--index, 0) * 0.1)));
    }

    &.error {
      --toast-shadow-color: color-mix(in oklch, var(--color-red-2), var(--background-1) 80%);

      background-color: color-mix(in oklch, var(--color-red-2), var(--background-1) 98%);
      color: var(--color-red-2);
    }
  }

  .container:hover .toast {
    opacity: 1;
    transform: scale(1);
  }

  h2 {
    font-weight: var(--font-weight-5);
  }
</style>
