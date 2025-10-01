<script lang="ts">
import { page } from "$app/state";
import { getAppContext } from "$lib/app-context.svelte";
import logo from "$lib/assets/logo.png";
import { CustomIcons } from "$lib/components/icons/custom";
import { IconSmall } from "$lib/components/icons/small";
import ExpandDecal from "./expand-decal.svelte";

const ctx = getAppContext();

function getActivePage(value: string | string[]) {
  if (Array.isArray(value)) {
    return value.some((v) => String(page.route.id).endsWith(v));
  }
  return String(page.route.id).endsWith(value);
}
</script>

<header class:expanded={ctx.sidebarExpanded}>
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
						<span style:color="var(--color-blue)">
							<CustomIcons.Dashboard />
						</span>
						<span class="text">Dashboard</span>
					</a>
				</li>

				<li>
					<a
						href={ctx.routes.library.list}
						class:active={getActivePage(['library', 'library/[id]'])}
					>
						<span style:color="var(--color-purple)">
							<CustomIcons.Folder />
						</span>

						<span class="text">Library</span>
					</a>
				</li>

				<li>
					<a href={ctx.routes.settings} class:active={getActivePage(['settings'])}>
						<span style:color="var(--color-yellow)">
							<CustomIcons.Settings />
						</span>

						<span class="text">Settings</span>
					</a>
				</li>
			</ul>
		</nav>
	{/if}

	<a
		href="https://discord.com/channels/1400973996505436300/1404928095009509489"
		target="_blank"
		class="help"
		aria-label="Get Help"
	>
		?
	</a>
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
	}

	ul {
		display: flex;
		flex-direction: column;
		gap: var(--size-1);

		li {
			inline-size: 100%;
		}

		a {
			align-items: center;
			block-size: var(--size-7);
			border-radius: var(--radius-2);
			color: var(--color-text);
			display: flex;
			font-size: var(--font-size-2);
			font-weight: var(--font-weight-4-5);
			gap: var(--size-2);

			padding-inline: var(--size-2);

			& :global(svg) {
				color: var(--accent-1);
				flex: none;
			}

			.text {
				opacity: 0.8;
			}

			&.active {
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
		font-size: var(--font-size-1);
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
</style>
