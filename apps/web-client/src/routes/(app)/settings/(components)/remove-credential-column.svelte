<script lang="ts">
import Button from "$lib/components/button.svelte";

type Props = { onclick: () => void };

let { onclick }: Props = $props();
</script>

<Button size="small" {onclick}>Remove</Button>
