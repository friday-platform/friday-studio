<script lang="ts">
  import type { CreateDropdownMenuProps } from "@melt-ui/svelte";
  import { untrack, type Snippet } from "svelte";
  import type { Writable } from "svelte/store";
  import { createContext } from "./context";

  type Props = { children: Snippet<[Writable<boolean>]> };

  let {
    children,
    positioning = { placement: "bottom-start" },
    ...args
  }: Props & CreateDropdownMenuProps = $props();

  const { open } = createContext(
    untrack(() => ({
      ...args,
      positioning,
      forceVisible: true,
      closeOnOutsideClick: true,
    })),
  );
</script>

{@render children(open)}
