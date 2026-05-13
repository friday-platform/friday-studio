<script lang="ts">
  import DaemonGate from "$lib/components/shared/daemon-gate.svelte";

  const { children } = $props();
</script>

<DaemonGate>
  {@render children?.()}
</DaemonGate>
