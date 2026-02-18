<script lang="ts">
  import Button from "$lib/components/button.svelte";

  let { connected, onclick }: { connected: boolean; onclick: () => void } = $props();
</script>

<Button size="small" variant="secondary" {onclick}>
  {connected ? "Replace" : "Connect"}
</Button>
