<script lang="ts">
  import { Icons } from "$lib/components/icons";
  import { getServiceIcon } from "$lib/modules/integrations/icons.svelte";

  type Props = { provider: string; size?: "small" | "large" };

  let { provider, size = "large" }: Props = $props();

  const icon = $derived(getServiceIcon(provider));
</script>

{#if icon}
  <div
    class="icon {size}"
    style:--background={icon.background}
    style:--background-dark={icon.backgroundDark}
  >
    {#if icon.type === "component"}
      {@const Component = icon.src}
      <Component />
    {:else}
      <img src={icon.src} alt={`${provider} logo`} />
    {/if}
  </div>
{:else}
  <div
    class="icon {size}"
    style:--background="var(--color-highlight-1)"
    style:--background-dark="var(--color-highlight-1)"
  >
    <Icons.Key />
  </div>
{/if}

<style>
  .icon {
    align-items: center;
    background-color: var(--background);
    border-radius: var(--radius-3);
    block-size: var(--size-9);
    display: flex;
    justify-content: center;
    inline-size: var(--size-9);
    color: var(--color-text);

    & :global(svg),
    img {
      aspect-ratio: 1 / 1;
      object-fit: contain;
      inline-size: var(--size-4);
    }

    @media (prefers-color-scheme: dark) {
      background-color: var(--background-dark);
    }

    &.small {
      background-color: unset;
      block-size: var(--size-6);
      inline-size: var(--size-6);
    }
  }
</style>
