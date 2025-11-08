<script lang="ts">
import type { Snippet } from "svelte";
import type { LayoutData } from "./$types";
import { setSpaceLayoutContext } from "./context.svelte";

let { children, data }: { children: Snippet; data: LayoutData } = $props();

const ctx = setSpaceLayoutContext(data.workspace);

$effect(() => {
  if (!ctx.workspace) return;
  if (ctx.workspace.id !== data.workspace.id) {
    ctx.workspace = data.workspace;
  }
});
</script>

{@render children()}
