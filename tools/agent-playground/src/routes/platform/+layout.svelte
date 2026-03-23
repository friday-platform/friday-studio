<script lang="ts">
  import DaemonGate from "$lib/components/daemon-gate.svelte";

  const { children } = $props();
</script>

<DaemonGate>
  {@render children?.()}
</DaemonGate>
