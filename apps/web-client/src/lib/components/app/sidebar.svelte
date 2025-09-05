<script lang="ts">
import { page } from "$app/state";
import { getAppContext } from "$lib/app-context.svelte";
import { CustomIcons } from "$lib/components/icons/custom";

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
	{#if !disabled}
		<nav>
			<ul>
				<li>
					<a href={routes.main} class:active={getActivePage('/')}>
						<CustomIcons.Dashboard />
						<span>Dashboard</span>
					</a>
				</li>

				<li>
					<a href={routes.library.list} class:active={getActivePage(['library', 'library/[id]'])}>
						<CustomIcons.Folder />
						<span>Library</span>
					</a>
				</li>
			</ul>
		</nav>
	{/if}
</header>

<style>
	header {
		border-inline-end: var(--size-px) solid var(--border-2);
		justify-content: space-between;
		gap: var(--size-4);
		padding-block: 3.25rem var(--size-5);
		padding-inline: var(--size-3);
	}

	ul {
		display: flex;
		flex-direction: column;
		gap: var(--size-1);

		li {
			font-size: var(--font-size-3);
			font-weight: var(--font-weight-5);
			inline-size: 100%;
		}

		a {
			align-items: center;
			block-size: var(--size-7);
			border-radius: var(--radius-3);
			color: var(--text-1);
			display: flex;
			gap: var(--size-2);
			opacity: 0.9;
			padding-inline: var(--size-2);

			& :global(svg) {
				color: var(--text-3);
				flex: none;
			}

			&.active {
				background-color: var(--highlight-2);
			}
		}
	}
</style>
