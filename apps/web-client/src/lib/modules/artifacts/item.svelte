<script lang="ts">
import Item from "./item.svelte";

type Props = { title: string; link?: string };

let { title, link }: Props = $props();
</script>

<div>
	<p>{title}</p>

	{#if link}
		<a href={link}>{link}</a>
	{/if}
</div>

<style>
</style>
