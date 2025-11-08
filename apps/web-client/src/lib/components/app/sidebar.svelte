<script lang="ts">
import { client, type InferResponseType, parseResult } from "@atlas/client/v2";
import { onMount } from "svelte";
import { getAppContext } from "$lib/app-context.svelte";
import logo from "$lib/assets/logo.png";
import { Icons } from "$lib/components/icons";
import { IconSmall } from "$lib/components/icons/small";
import { getActivePage } from "$lib/utils/active-page.svelte";
import ExpandDecal from "./expand-decal.svelte";
import NavigationControls from "./navigation-controls.svelte";

type WorkspacesListResponse = InferResponseType<typeof client.workspace.index.$get, 200>;

const ctx = getAppContext();
let spaces = $state<WorkspacesListResponse>([]);

let mounted = $state(false);

async function loadSpaces() {
  try {
    const res = await parseResult(client.workspace.index.$get());
    if (!res.ok) {
      console.error("Failed to load spaces:", res.error);
      spaces = [];
      return;
    }
    const allSpaces = res.data;
    spaces = allSpaces.filter(
      // (w) => w.name !== 'atlas-conversation' && !w.path.includes('/examples/')
      (w) => !w.path.includes("/examples/"),
    );
  } catch (error) {
    console.error("Failed to load spaces:", error);
    spaces = [];
  }
}

onMount(() => {
  mounted = true;
  loadSpaces();
  ctx.setWorkspacesRefreshCallback(loadSpaces);
});
</script>

{#if __TAURI_BUILD__ && ctx.sidebarExpanded}
	<NavigationControls />
{/if}

<header class:expanded={ctx.sidebarExpanded} class:mounted>
	{#if !ctx.sidebarExpanded}
		<a href={ctx.routes.main} class="logo" aria-label="Altas">
			<img src={logo} alt="Altas" />
		</a>
		<button
			class="expand-sidebar"
			onclick={() => {
				ctx.sidebarExpanded = true;
			}}
		>
			<span class="arrow"><IconSmall.CaretRight /></span>
			<span class="label"><ExpandDecal /></span>
		</button>
	{/if}

	{#if ctx.sidebarExpanded}
		<nav>
			<ul>
				<li>
					<a href={ctx.routes.main} class:active={getActivePage('/(app)')}>
						<Icons.Dashboard />

						<span class="text">Dashboard</span>
					</a>
				</li>

				<li>
					<a
						href={ctx.routes.library.list}
						class:active={getActivePage(['library', 'library/[id]'])}
					>
						<Icons.Folder />

						<span class="text">Library</span>
					</a>
				</li>

				<li>
					<a href={ctx.routes.settings} class:active={getActivePage(['settings'])}>
						<Icons.Settings />

						<span class="text">Settings</span>
					</a>
				</li>
			</ul>

			{#if spaces.length > 0}
				<div class="spaces-section">
					<span class="spaces-header">Spaces</span>
					<ul class="spaces-list">
						{#each spaces as space}
							<li>
								<a
									href={ctx.routes.spaces.item(space.id)}
									class:active={getActivePage([
										`spaces/${space.id}`,
										`spaces/${space.id}/sessions`
									])}
								>
									<span class="text">{space.name}</span>
								</a>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</nav>
	{/if}

	<a href="https://discord.gg/Mx5YFWmDuJ" target="_blank" class="help" aria-label="Get Help"> ? </a>
</header>

<style>
	header {
		background-color: var(--color-surface-2);
		border-inline-end: var(--size-px) solid var(--color-border-1);
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		gap: var(--size-4);
		padding-block: var(--size-13) var(--size-6);
		padding-inline: var(--size-3);
		position: relative;
		z-index: var(--layer-1);

		-webkit-user-select: none;
		-moz-user-select: none;
		user-select: none;
	}

	ul {
		display: flex;
		flex-direction: column;

		li {
			inline-size: 100%;
		}

		a {
			align-items: center;
			block-size: var(--size-7);
			border-radius: var(--radius-2);
			color: var(--color-text);
			display: flex;
			font-size: var(--font-size-3);
			font-weight: var(--font-weight-4-5);
			gap: var(--size-2);
			padding-inline: var(--size-2);
			outline: none;

			& :global(svg) {
				color: var(--accent-1);
				flex: none;
				opacity: 0.5;
			}

			.text {
				opacity: 0.8;
			}

			&.active,
			&:focus-visible {
				background-color: color-mix(in srgb, var(--color-border-1) 80%, transparent);
			}
		}
	}

	.logo {
		align-items: center;
		background-color: #181c2f;
		block-size: var(--size-8);
		border-radius: var(--radius-3);
		color: #fff;
		display: flex;
		inline-size: var(--size-8);
		justify-content: center;
		margin-inline: auto;
		mix-blend-mode: exclusion;
		transition: all 150ms ease;

		img {
			block-size: var(--size-4-5);
		}
	}

	.help {
		align-items: center;
		background-color: var(--color-surface-1);
		block-size: var(--size-7);
		border-radius: var(--radius-round);
		box-shadow: var(--shadow-1);
		color: var(--text-1);
		display: flex;
		font-size: var(--font-size-2);
		font-weight: var(--font-weight-7);
		justify-content: center;
		inline-size: var(--size-7);
		margin-block-start: auto;
		margin-inline: auto;
	}

	.expanded .help {
		margin-inline: var(--size-5) auto;
	}

	.expand-sidebar {
		background-color: var(--color-surface-1);
		border: 1px solid var(--color-border-1);
		border-inline-end: none;
		border-radius: var(--radius-round);
		border-start-end-radius: 0;
		border-end-end-radius: 0;
		block-size: var(--size-6);
		color: var(--color-yellow);
		display: flex;
		justify-content: center;
		align-items: center;
		inline-size: var(--size-5-5);
		padding-inline-start: var(--size-1-5);
		position: absolute;
		inset-inline-end: -1px;
		inset-block-start: 50%;
		transform: translateY(-50%);
		transition: all 0.2s ease-in-out;

		.arrow {
			flex: none;
		}

		.label {
			clip-path: circle(0px at 0 20px);
			position: absolute;
			inset-inline-start: calc(-1 * var(--size-3));
			inset-block-start: 50%;
			transform: scale(0.9) translateY(-50%);
			transform-origin: left top;
			transition: all 0.2s ease-in-out;
		}

		&:hover {
			& {
				inline-size: var(--size-6);
			}

			.label {
				clip-path: circle(40px at 0 20px);
				transform: scale(1) translateY(-50%);
			}
		}
	}

	.spaces-header {
		display: block;
		font-size: var(--font-size-2);
		font-weight: var(--font-weight-4-5);
		opacity: 0.6;
		padding-block: var(--size-3) var(--size-1-5);
		padding-inline: var(--size-2-5) var(--size-2);
	}

	.spaces-list {
		a {
			padding-inline: var(--size-2-5) var(--size-2);

			span {
				white-space: nowrap;
				overflow: hidden;
				text-overflow: ellipsis;
			}
		}
	}
</style>
