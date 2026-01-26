<script lang="ts">
  import type { Snippet } from "svelte";
  import { quadInOut } from "svelte/easing";
  import { fade, scale } from "svelte/transition";
  import { getContext } from "./context";

  type Props = {
    children: Snippet;
    icon?: Snippet;
    size?: "regular" | "large";
    header: Snippet;
    footer: Snippet;
  };

  let { children, icon, size = "regular", header, footer }: Props = $props();

  const { content, portalled, overlay, open } = getContext();
</script>

{#if $open}
  <div class="component" {...$portalled} use:portalled>
    <div
      {...$overlay}
      use:overlay
      class="overlay"
      transition:fade={{ duration: 150, easing: quadInOut }}
    ></div>

    <div
      class="dialog {size}"
      {...$content}
      use:content
      transition:scale={{ duration: 150, start: 0.98, easing: quadInOut, opacity: 0 }}
    >
      {@render children()}

      <header>
        {#if icon}
          <div class="icon">
            {@render icon()}
          </div>
        {/if}

        {@render header()}
      </header>

      <footer>
        {@render footer()}
      </footer>
    </div>
  </div>
{/if}

<style>
  .component {
    align-items: center;
    display: flex;
    justify-content: center;
    inset: 0;
    padding-inline-start: var(--size-56);
    position: fixed;
    z-index: var(--layer-3);
  }

  .overlay {
    background: radial-gradient(
      circle farthest-side at 50% 50%,
      var(--color-surface-2) 0%,
      transparent 100%
    );
    inset: 0;
    inset-inline-start: var(--size-56);
    position: absolute;
    z-index: -1;
  }

  .dialog {
    -webkit-user-select: auto;
    -moz-user-select: auto;
    user-select: auto;

    background: var(--color-surface-1);
    border-radius: var(--radius-6);
    box-shadow: var(--shadow-1);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--size-6);
    inline-size: fit-content;
    max-inline-size: var(--size-72);
    padding-block: var(--size-12) var(--size-8);
    padding-inline: var(--size-6);
    position: relative;
    text-align: center;

    &.large {
      max-inline-size: var(--size-96);
    }
  }

  header {
    align-items: center;
    display: flex;
    flex-direction: column;
    justify-content: center;

    & :global(p) {
      text-wrap-style: balance;
    }
  }

  .icon {
    margin-block-end: var(--size-4);

    & :global(svg) {
      margin-block-end: var(--size-4);
      transform: scale(2);
    }
  }

  footer {
    align-items: center;
    display: flex;
    flex-direction: column;
    gap: var(--size-1-5);
    max-inline-size: var(--size-56);
    inline-size: 100%;
  }
</style>
