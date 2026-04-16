<script lang="ts">
  import { goto } from "$app/navigation";
  import { onMount } from "svelte";

  onMount(() => {
    void goto("/platform/user/chat", { replaceState: true });
  });
</script>
