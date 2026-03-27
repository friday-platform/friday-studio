<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { getContext } from "./context";

  type Props = { id: string; hasChildren?: boolean; children: Snippet };

  let { id, hasChildren = false, children, ...rest }: Props & HTMLAttributes<HTMLLIElement> =
    $props();

  const { item } = getContext();
</script>

<li {...rest} {...$item({ id, hasChildren })} use:item>
  {@render children()}
</li>
