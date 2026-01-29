<script lang="ts">
  import { Breadcrumbs } from "$lib/components/breadcrumbs";
  import { Icons } from "$lib/components/icons";

  interface Props {
    title: string | undefined;
  }

  let { title }: Props = $props();
</script>

<div>
  <Breadcrumbs.Root>
    <Breadcrumbs.Item>Chats</Breadcrumbs.Item>

    <Breadcrumbs.Segment />

    <Breadcrumbs.Title hasActions={false}>
      {#snippet prepend()}
        <span style:color="var(--accent-2)">
          <Icons.DotFilled />
        </span>
      {/snippet}

      {title ?? "Untitled"}
    </Breadcrumbs.Title>
  </Breadcrumbs.Root>
</div>

<style>
  div {
    background: linear-gradient(to bottom, var(--color-surface-1) 75%, transparent);
    position: sticky;
    inset-block-start: 0;
    z-index: var(--layer-2);
  }
</style>
