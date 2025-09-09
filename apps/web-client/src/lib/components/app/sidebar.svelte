<script lang="ts">
import { getClientContext } from "src/lib/modules/client/context.svelte";
import { onMount } from "svelte";
import { page } from "$app/state";
import { getAppContext } from "$lib/app-context.svelte";
import { CustomIcons } from "$lib/components/icons/custom";

const { routes } = getAppContext();
const ctx = getClientContext();

function getActivePage(value: string | string[]) {
  if (Array.isArray(value)) {
    return value.some((v) => String(page.route.id).endsWith(v));
  }
  return String(page.route.id).endsWith(value);
}

onMount(() => {
  ctx.listConversations();
});
</script>

<header>
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

			<!-- <li class="section-header">Chats</li>

			{#each ctx.pastConversations as conversation}
				<li>
					<a href={routes.chat.item(conversation)} class:active={getActivePage('chat/[id]')}>
						<span>{conversation}</span>
					</a>
				</li>
			{/each} -->
		</ul>
	</nav>
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

		li {
			inline-size: 100%;

			&.section-header {
				block-size: var(--size-6);
				color: var(--text-3);
				opacity: 0.7;
				font-size: var(--font-size-2);
				font-weight: var(--font-weight-5);
				line-height: var(--font-lineheight-2);
				margin-block-start: var(--size-2);
				padding-block-start: var(--size-1);
				padding-inline: var(--size-2);
			}
		}

		a {
			align-items: center;
			block-size: var(--size-7);
			border-radius: var(--radius-3);
			color: var(--text-1);
			display: flex;
			font-size: var(--font-size-3);
			font-weight: var(--font-weight-5);
			gap: var(--size-2);
			opacity: 0.9;
			padding-inline: var(--size-2);

			& :global(svg) {
				color: var(--accent-1);
				flex: none;
			}

			&.active {
				background-color: var(--highlight-2);
			}
		}
	}
</style>
