<script lang="ts">
import "@atlas/ui/tokens.css";
import "@atlas/ui/colors.css";
import "@atlas/ui/markdown.css";
import "$lib/../app.css";
import "./replay.css";

const { children } = $props();
</script>

<svelte:head>
  <title>Friday Chat Replay</title>
</svelte:head>

{@render children?.()}
