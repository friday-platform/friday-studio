<script lang="ts">
import type { Snippet } from "svelte";

type Props = { children: Snippet };

const { children }: Props = $props();
</script>

<span class="read-only-field">
  {@render children()}
</span>

<style>
  .read-only-field {
    font-weight: var(--font-weight-5);
  }
</style>
