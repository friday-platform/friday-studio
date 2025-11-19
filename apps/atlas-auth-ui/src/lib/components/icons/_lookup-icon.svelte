<script lang="ts">
import Avatar from "./avatar.svelte";
import Component from "./component.svelte";
import FileText from "./file-text.svelte";
import Stack from "./stack.svelte";

let { value }: { value: string } = $props();
</script>

{#if value === "Component"}
  <Component />
{:else if value === "FileText"}
  <FileText />
{:else if value === "Avatar"}
  <Avatar />
{:else if value === "Stack"}
  <Stack />
{/if}
