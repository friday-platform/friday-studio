<script lang="ts">
  import { type CreateTreeViewProps } from "@melt-ui/svelte";
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { createContext } from "./context";

  type Props = CreateTreeViewProps & { children: Snippet };

  let {
    forceVisible = true,
    defaultExpanded,
    expanded,
    onExpandedChange,
    children,
    ...rest
  }: Props & HTMLAttributes<HTMLDivElement> = $props();

  const { tree } = createContext({ forceVisible, defaultExpanded, expanded, onExpandedChange });
</script>

<div {...rest} {...$tree} use:tree>
  {@render children()}
</div>
