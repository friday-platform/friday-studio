<script lang="ts">
import type { CreateDialogProps } from "@melt-ui/svelte";
import type { Snippet } from "svelte";
import type { Writable } from "svelte/store";
import { createContext } from "./context";

type Props = CreateDialogProps & { children: Snippet<[Writable<boolean>]> };

let { children, ...rest }: Props = $props();

const { open } = createContext(rest);
</script>

{@render children(open)}
