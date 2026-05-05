<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";

  type Variant = "warning" | "error" | "info" | "success" | "status";

  interface Props extends HTMLAttributes<HTMLSpanElement> {
    variant?: Variant;
    children: Snippet;
  }

  let { variant = "info", children, ...rest }: Props = $props();
</script>

<span class="badge" data-variant={variant} {...rest}>
  {@render children()}
</span>

<style>
  .badge {
    --badge-color: var(--blue-primary);
    --badge-bg-light: color-mix(in srgb, var(--badge-color), transparent 94%);
    --badge-bg-dark: color-mix(in srgb, var(--badge-color), transparent 90%);
    align-items: center;
    background-color: light-dark(var(--badge-bg-light), var(--badge-bg-dark));
    block-size: var(--size-5-5);
    border-radius: var(--radius-2-5);
    color: var(--badge-color);
    display: inline-flex;
    font-size: var(--font-size-2);
    font-weight: var(--font-weight-5);
    justify-content: center;
    padding-inline: var(--size-2-5);
  }

  .badge[data-variant="warning"] {
    --badge-color: var(--yellow-primary);
  }

  .badge[data-variant="error"] {
    --badge-color: var(--red-primary);
  }

  .badge[data-variant="info"] {
    --badge-color: var(--blue-primary);
  }

  .badge[data-variant="success"] {
    --badge-color: var(--green-primary);
  }

  .badge[data-variant="status"] {
    --badge-color: var(--purple-primary);
  }
</style>
