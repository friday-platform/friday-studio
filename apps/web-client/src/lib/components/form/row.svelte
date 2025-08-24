<script lang="ts">
import type { Snippet } from "svelte";

type Props = { children: Snippet; align?: "start" | "center" | "end" | "full" };

const { children, align = "full" }: Props = $props();
</script>

<div class="align--{align}">
  {@render children()}
</div>

<style>
  div {
    grid-column: 1 / -1;
    inline-size: 100%;
  }
</style>
