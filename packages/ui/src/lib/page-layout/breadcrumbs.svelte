<script lang="ts">
  type Crumb = { label: string; href?: string };
  type Props = { crumbs: Crumb[] };

  let { crumbs }: Props = $props();
</script>

<nav class="component" data-friday-pagelayout-title aria-label="Breadcrumb">
  <ol>
    {#each crumbs as crumb, i (i)}
      {@const isLast = i === crumbs.length - 1}
      <li class:current={isLast}>
        {#if crumb.href && !isLast}
          <a href={crumb.href}>{crumb.label}</a>
        {:else}
          <span>{crumb.label}</span>
        {/if}
      </li>
      {#if !isLast}
        <li class="sep" aria-hidden="true">/</li>
      {/if}
    {/each}
  </ol>
</nav>

<style>
  .component {
    padding-block: var(--size-4);
    padding-inline: var(--size-6);
    background: color-mix(in srgb, var(--surface), transparent 8%);
    backdrop-filter: blur(var(--size-2));
    -webkit-mask-image: linear-gradient(to bottom, rgba(0, 0, 0, 1) 70%, rgba(0, 0, 0, 0));
    mask-image: linear-gradient(to bottom, rgba(0, 0, 0, 1) 70%, rgba(0, 0, 0, 0));
    inset-block-start: 0;
    inset-inline: 0;
    inline-size: calc(100% - var(--size-8));
    position: absolute;
    z-index: var(--layer-2);
  }

  ol {
    align-items: center;
    display: flex;
    font-size: var(--font-size-4);
    font-weight: var(--font-weight-5);
    gap: 8px;
    line-height: 1.2;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  li {
    color: var(--text-faded);
  }

  li.current {
    color: var(--text-bright);
  }

  li a {
    color: inherit;
    text-decoration: none;
  }

  li a:hover {
    color: var(--text-bright);
  }

  li.sep {
    user-select: none;
  }
</style>
