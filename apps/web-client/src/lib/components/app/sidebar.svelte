<script lang="ts">
	import logo from '$lib/assets/logo.png';
</script>

<aside>
	<header>
		<img src={logo} alt="Atlas" />
		<span>Atlas</span>
	</header>
</aside>

<style>
	aside {
		display: flex;
		flex-direction: column;
		gap: var(--size-4);
		padding-block: var(--size-7);
		padding-inline: var(--size-8);
	}

	header {
		display: flex;
		gap: var(--size-2);
		align-items: center;

		img {
			aspect-ratio: 1;
			flex: none;
			inline-size: var(--size-7);
		}

		span {
			font-size: var(--font-size-5);
			font-weight: var(--font-weight-6);
		}
	}
</style>
