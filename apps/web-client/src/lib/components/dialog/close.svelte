<script>
  import { Icons } from "$lib/components/icons";
  import { getContext } from "./context";

  const { close } = getContext();
</script>

<button {...$close} use:close>
  <Icons.Close />
</button>

<style>
  button {
    display: inline-block;
    inset-block-start: var(--size-4);
    inset-inline-end: var(--size-4);
    opacity: 0.5;
    outline: none;
    position: absolute;

    &:focus-visible {
      border-radius: var(--radius-3);
      outline: 1px solid var(--accent-1);
      z-index: var(--layer-1);
    }
  }
</style>
