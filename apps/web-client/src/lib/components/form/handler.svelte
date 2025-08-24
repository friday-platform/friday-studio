<script lang="ts">
import type { Snippet } from "svelte";

type Props = { children: Snippet; onSubmit: (data: FormData) => void | Promise<void> };

const { children, onSubmit }: Props = $props();
</script>

<form
  method="POST"
  onsubmit={(e) => {
    e.preventDefault();
    const target = e.target as HTMLFormElement;
    onSubmit(new FormData(target));
  }}
>
  {@render children()}
</form>
