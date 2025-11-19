<script lang="ts">
import type { Snippet } from "svelte";

type Props = { children: Snippet; spacing?: "regular" | "large" };

let { children, spacing = "regular" }: Props = $props();
</script>

<div class="spacing-{spacing}">
  {@render children()}
</div>

<style>
  div {
    display: flex;
    flex-direction: column;
    gap: var(--form-group-spacing);
    &.spacing-regular {
      --form-group-spacing: var(--size-4);
    }
    &.spacing-large {
      --form-group-spacing: var(--size-6);
    }
  }
</style>
