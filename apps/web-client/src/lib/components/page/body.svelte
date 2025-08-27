<script lang="ts">
let { children } = $props();
</script>

<div>
	{@render children?.()}
</div>

<style>
	div {
		padding: var(--size-8);
	}
</style>
