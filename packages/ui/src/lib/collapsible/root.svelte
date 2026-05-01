<script lang="ts">
  import { type CreateCollapsibleProps } from "@melt-ui/svelte";
  import type { Snippet } from "svelte";
  import { createContext } from "./context";

  type Props = CreateCollapsibleProps & { children: Snippet };

  let { defaultOpen = false, open, onOpenChange, children }: Props = $props();

  const { root } = createContext({ forceVisible: true, defaultOpen, onOpenChange, open });
</script>

<div {...$root} use:root>
  {@render children()}
</div>
