<script lang="ts">
  import { Icons } from "$lib/components/icons";
  import type { Component, Snippet } from "svelte";

  interface Props {
    title: string;
    subtitle?: string;
    icon?: { type: "component"; src: Component } | { type: "image"; src: string };
    fallbackIcon?: Snippet;
  }

  let { title, subtitle, icon, fallbackIcon }: Props = $props();
</script>

<div class="header">
  <span class="icon">
    {#if icon}
      {#if icon.type === "component"}
        <icon.src />
      {:else}
        <img src={icon.src} alt="" class="icon-image" />
      {/if}
    {:else if fallbackIcon}
      {@render fallbackIcon()}
    {:else}
      <Icons.DotOpen />
    {/if}
  </span>

  <div class="title">
    <h2>{title}</h2>
    {#if subtitle}
      <p>{subtitle}</p>
    {/if}
  </div>
</div>

<style>
  .header {
    align-items: start;
    display: flex;
    gap: var(--size-2);
    inline-size: 100%;
  }

  .icon {
    align-items: center;
    background-color: var(--color-surface-1);
    block-size: var(--size-8);
    color: color-mix(in srgb, var(--color-text), transparent 70%);
    display: flex;
    flex: none;
    inline-size: var(--size-4);
    justify-content: center;
    margin-inline-start: calc(-1 * calc(var(--size-2) + 0.5px));
  }

  .icon-image {
    block-size: var(--size-3-5);
    inline-size: var(--size-3-5);
    object-fit: contain;
  }

  .title {
    display: flex;
    flex-direction: column;
    gap: var(--size-0-5);
    margin-block-start: var(--size-2);

    h2 {
      font-size: var(--font-size-3);
      font-weight: var(--font-weight-5);
      line-height: var(--font-lineheight-1);
    }

    p {
      font-size: var(--font-size-2);
      line-height: var(--font-lineheight-1);
      opacity: 0.6;
    }
  }
</style>
