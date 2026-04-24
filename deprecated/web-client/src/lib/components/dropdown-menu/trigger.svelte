<script lang="ts">
  import { type Snippet } from "svelte";
  import type { HTMLAttributes } from "svelte/elements";
  import { getContext } from "./context";

  type Props = { children: Snippet };

  let { children, ...rest }: Props & HTMLAttributes<HTMLButtonElement> = $props();

  const { trigger } = getContext();
</script>

<button
  type="button"
  {...rest}
  {...$trigger}
  use:trigger
  onclick={(e: MouseEvent) => {
    if (!e.target) return;

    const target = e.currentTarget as HTMLButtonElement;
    const controls = target.getAttribute("aria-controls");

    e.currentTarget?.dispatchEvent(
      new CustomEvent("closemenu", { bubbles: true, detail: { controls } }),
    );
  }}
>
  {@render children()}
</button>

<style>
  button {
    max-inline-size: 100%;
    transition: opacity 100ms ease;

    &:focus {
      outline: none;
    }
  }
</style>
