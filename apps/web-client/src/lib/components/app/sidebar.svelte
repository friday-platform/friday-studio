<script lang="ts">
import { page } from "$app/state";
import { getAppContext } from "$lib/app-context.svelte";
import logo from "$lib/assets/logo.png";
import { SegmentedControl } from "$lib/components/segmented-control";

const { routes } = getAppContext();

let { disabled = true } = $props();

function getActivePage(value: string | string[]) {
  if (Array.isArray(value)) {
    return value.some((v) => String(page.route.id).endsWith(v));
  }
  return String(page.route.id).endsWith(value);
}
</script>

<header>
	<a href={routes.main} class="logo">
		<img src={logo} alt="Atlas" />
		<span>Atlas</span>
	</a>

	{#if !disabled}
		<nav>
			<SegmentedControl.Root>
				<SegmentedControl.Item href={routes.main} active={getActivePage('/')}
					>Chat</SegmentedControl.Item
				>
				<SegmentedControl.Item
					href={routes.library.list}
					active={getActivePage(['library', 'library/[id]'])}>Library</SegmentedControl.Item
				>
			</SegmentedControl.Root>
		</nav>
	{/if}
</header>

<style>
	header {
		display: flex;
		flex: none;
		justify-content: space-between;
		gap: var(--size-4);
		padding-block-start: var(--size-8);
		padding-inline: var(--size-8);
	}

	.logo {
		display: flex;
		gap: var(--size-4);
		align-items: center;

		img {
			aspect-ratio: 1;
			flex: none;
			inline-size: var(--size-8);
		}

		span {
			font-size: var(--font-size-6);
			font-weight: var(--font-weight-6);
		}
	}
</style>
