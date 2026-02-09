<script lang="ts">
type Props = { text: string; href: string };

let { text, href }: Props = $props();
</script>

<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
<a {href}>
	<svg class="border" aria-hidden="true">
		<defs>
			<linearGradient id="border-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
				<stop offset="0%" stop-color="#FFB200" />
				<stop offset="25.96%" stop-color="#FF5900" />
				<stop offset="59.62%" stop-color="#973CD9" />
				<stop offset="85.58%" stop-color="#0078FF" />
				<stop offset="100%" stop-color="#00C500" />
			</linearGradient>
		</defs>
		<rect pathLength="1" stroke="url(#border-gradient)" />
	</svg>
	{text}

	<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
		<path
			d="M6.74976 5.75L9.24976 8.25L6.74976 10.75"
			stroke="currentColor"
			stroke-width="1.25"
			stroke-linecap="round"
		/>
	</svg>
</a>

<style>
	a {
		align-items: center;
		color: color-mix(in srgb, var(--color-text), transparent 20%);
		display: flex;
		font-size: var(--font-size-4);
		font-weight: var(--font-weight-5);
		gap: var(--size-1);
		inline-size: max-content;
		margin-inline: auto;
		margin-block: var(--size-16) calc(-1 * var(--size-8));
		padding: var(--size-1-5) var(--size-3);
		position: relative;
		transition: all 200ms ease;
		transform: translate3d(0, 0, 0);

		&:hover {
			gap: var(--size-1-5);
			transform: scale(1.05) translate3d(0, 0, 0);
		}
	}

	.border {
		position: absolute;
		inset: 0;
		block-size: 100%;
		inline-size: 100%;
		overflow: visible;
		pointer-events: none;
		transform: scaleX(-1);
	}

	.border rect {
		x: 0.5px;
		y: 0.5px;
		width: calc(100% - 1px);
		height: calc(100% - 1px);
		rx: var(--radius-3);
		ry: var(--radius-3);
		fill: none;
		stroke-width: 1.5;
		stroke-opacity: 0.3;
		stroke-dasharray: 0.5;
		stroke-linecap: round;
		animation-name: revolve;
		animation-duration: 4s;
		animation-timing-function: linear;
		animation-iteration-count: infinite;
	}

	@keyframes revolve {
		0% {
			stroke-dashoffset: 0;
		}
		100% {
			stroke-dashoffset: 1;
		}
	}
</style>
