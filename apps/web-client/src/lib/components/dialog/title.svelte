<script lang="ts">
  import type { Snippet } from "svelte";
  import { getContext } from "./context";

  type Props = { children: Snippet };
  let { children }: Props = $props();

  const { title } = getContext();
</script>

<h2 {...$title} use:title>
  {@render children()}
</h2>

<style>
  h2 {
    font-size: var(--font-size-7);
    font-weight: var(--font-weight-6);
  }
</style>
