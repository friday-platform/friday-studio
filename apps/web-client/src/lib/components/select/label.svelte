<script lang="ts">
import type { Snippet } from "svelte";
import { getContext } from "./context";

type Props = { children: Snippet };

let { children }: Props = $props();

const { label } = getContext();
</script>

<label {...$label} use:label>
  {@render children()}
</label>
