<script lang="ts">
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

<div class="content">
  {@render children()}
</div>

<style>
  .content {
    min-inline-size: 0;
  }
</style>
