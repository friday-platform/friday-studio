<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { getContext } from "./context";

  type Props = { id: string; children: Snippet };

  let { id, children, ...rest }: Props & HTMLAttributes<HTMLUListElement> = $props();

  const { group } = getContext();
</script>

<ul {...rest} {...$group({ id })} use:group>
  {@render children()}
</ul>
