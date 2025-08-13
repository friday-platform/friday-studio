<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';
	import AppContainer from '$lib/components/app/container.svelte';
	import AppSidebar from '$lib/components/app/sidebar.svelte';
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

<AppContainer>
	<AppSidebar />

	<main>
		{@render children?.()}
	</main>
</AppContainer>
