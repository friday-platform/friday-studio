<script lang="ts">
import { markdownToHTML } from "./markdown-utils";
import type { OutputEntry } from "./types";

const { message }: { message: OutputEntry } = $props();

// Convert markdown to HTML
const htmlContent = $derived(message.content ? markdownToHTML(message.content) : "");

function getInitials(fullName: string) {
  if (fullName === "") return "";

  const split = fullName
    .trim()
    .split(" ")
    .filter((str) => str !== "");

  if (split.length === 1) {
    return fullName.substring(0, 2);
  } else {
    return `${split[0].substring(0, 1)}${split[1].substring(0, 1)}`;
  }
}
</script>

<article class="message" class:user={message.type === 'request'}>
	<header>
		{#if message.author === 'Atlas'}
			<svg
				width="32"
				height="32"
				viewBox="0 0 32 32"
				fill="none"
				xmlns="http://www.w3.org/2000/svg"
			>
				<g clip-path="url(#clip0_225_2)">
					<path
						d="M0 16C0 7.16345 7.16345 0 16 0V0C24.8366 0 32 7.16345 32 16V16C32 24.8366 24.8366 32 16 32V32C7.16345 32 0 24.8366 0 16V16Z"
						fill="#F2FB4B"
						style="fill:#F2FB4B;fill:color(display-p3 0.9505 0.9850 0.2950);fill-opacity:1;"
					/>
					<g filter="url(#filter0_ig_225_2)">
						<circle
							cx="16.0402"
							cy="15.9992"
							r="11.4572"
							fill="#F2FB4B"
							fill-opacity="0.01"
							style="fill:#F2FB4B;fill:color(display-p3 0.9490 0.9843 0.2941);fill-opacity:0.01;"
						/>
					</g>
					<path
						d="M16 10.4932C16.4536 10.4933 16.8211 10.8608 16.8213 11.3145V14.3281L19.4316 12.8213C19.8246 12.5946 20.3269 12.7291 20.5537 13.1221C20.7806 13.515 20.6457 14.0172 20.2529 14.2441L17.6406 15.751L20.2529 17.2588C20.6457 17.4858 20.7806 17.9879 20.5537 18.3809C20.3269 18.7738 19.8246 18.9083 19.4316 18.6816L16.8213 17.1738V20.1885C16.8211 20.6421 16.4536 21.0097 16 21.0098C15.5463 21.0098 15.1789 20.6421 15.1787 20.1885V17.1729L12.5674 18.6816C12.1745 18.908 11.6731 18.7735 11.4463 18.3809C11.2195 17.988 11.3535 17.4858 11.7461 17.2588L14.3574 15.751L11.7461 14.2441C11.3535 14.0171 11.2195 13.5149 11.4463 13.1221C11.6731 12.7294 12.1745 12.5949 12.5674 12.8213L15.1787 14.3291V11.3145C15.1789 10.8608 15.5463 10.4932 16 10.4932Z"
						fill="#2E48F1"
						style="fill:#2E48F1;fill:color(display-p3 0.1807 0.2828 0.9468);fill-opacity:1;"
					/>
				</g>
				<defs>
					<filter
						id="filter0_ig_225_2"
						x="-4.32375"
						y="-4.36476"
						width="40.7281"
						height="40.7276"
						filterUnits="userSpaceOnUse"
						color-interpolation-filters="sRGB"
					>
						<feFlood flood-opacity="0" result="BackgroundImageFix" />
						<feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
						<feColorMatrix
							in="SourceAlpha"
							type="matrix"
							values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"
							result="hardAlpha"
						/>
						<feOffset dx="1.78135" dy="-1.78135" />
						<feGaussianBlur stdDeviation="4.63151" />
						<feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1" />
						<feColorMatrix
							type="matrix"
							values="0 0 0 0 0.439517 0 0 0 0 0.513155 0 0 0 0 0.020349 0 0 0 1 0"
						/>
						<feBlend mode="normal" in2="shape" result="effect1_innerShadow_225_2" />
						<feTurbulence
							type="fractalNoise"
							baseFrequency="3.2000000476837158 3.2000000476837158"
							numOctaves="3"
							seed="6068"
							result="displacementX"
						/>
						<feTurbulence
							type="fractalNoise"
							baseFrequency="3.2000000476837158 3.2000000476837158"
							numOctaves="3"
							seed="6069"
							result="displacementY"
						/>
						<feColorMatrix
							in="displacementX"
							type="matrix"
							values="0 0 0 1 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0 1"
							result="displacementXRed"
						/>
						<feColorMatrix
							in="displacementY"
							type="matrix"
							values="0 0 0 0 0  0 0 0 1 0  0 0 0 0 0  0 0 0 0 1"
						/>
						<feComposite in="displacementXRed" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" />
						<feDisplacementMap
							in="effect1_innerShadow_225_2"
							scale="17.813508987426758"
							xChannelSelector="R"
							yChannelSelector="G"
							width="100%"
							height="100%"
						/>
						<feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" />
						<feComponentTransfer result="sourceDisplacedAlpha">
							<feFuncA type="gamma" exponent="0.2" />
						</feComponentTransfer>
						<feColorMatrix
							in="effect1_innerShadow_225_2"
							type="matrix"
							values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0"
						/>
						<feComponentTransfer result="inputSourceAlpha">
							<feFuncA type="gamma" exponent="0.2" />
						</feComponentTransfer>
						<feComposite
							in="sourceDisplacedAlpha"
							operator="arithmetic"
							k1="1"
							k2="0"
							k3="0"
							k4="0"
							result="displacementAlphasMultiplied"
						/>
						<feComposite
							in="displacementAlphasMultiplied"
							operator="arithmetic"
							k1="0"
							k2="0"
							k3="-0.5"
							k4="0.5"
							result="centeringAdjustment"
						/>
						<feComposite
							in="displacementX"
							in2="displacementAlphasMultiplied"
							operator="arithmetic"
							k1="1"
							k2="0"
							k3="0"
							k4="0"
						/>
						<feComposite
							in="centeringAdjustment"
							operator="arithmetic"
							k1="0"
							k2="1"
							k3="1"
							k4="0"
						/>
						<feColorMatrix
							type="matrix"
							values="0 0 0 1 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0 1"
							result="displacementXFinal"
						/>
						<feComposite
							in="displacementY"
							in2="displacementAlphasMultiplied"
							operator="arithmetic"
							k1="1"
							k2="0"
							k3="0"
							k4="0"
						/>
						<feComposite
							in="centeringAdjustment"
							operator="arithmetic"
							k1="0"
							k2="1"
							k3="1"
							k4="0"
						/>
						<feColorMatrix
							type="matrix"
							values="0 0 0 0 0  0 0 0 1 0  0 0 0 0 0  0 0 0 0 1"
							result="displacementYFinal"
						/>
						<feComposite
							in="displacementXFinal"
							in2="displacementYFinal"
							operator="arithmetic"
							k1="0"
							k2="1"
							k3="1"
							k4="0"
						/>
						<feComposite
							in2="displacementAlphasMultiplied"
							operator="in"
							result="displacementMap"
						/>
						<feFlood flood-color="rgb(127, 127, 127)" flood-opacity="1" />
						<feComposite in2="displacementAlphasMultiplied" operator="out" />
						<feComposite in2="displacementMap" operator="over" result="displacementMapWithBg" />
						<feDisplacementMap
							in="effect1_innerShadow_225_2"
							scale="17.813508987426758"
							xChannelSelector="R"
							yChannelSelector="G"
							width="100%"
							height="100%"
							result="displacedImage"
						/>
						<feColorMatrix
							in="effect1_innerShadow_225_2"
							type="matrix"
							values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 127 0"
							result="imageOpaque"
						/>
						<feDisplacementMap
							in="imageOpaque"
							in2="displacementMapWithBg"
							scale="17.813508987426758"
							xChannelSelector="R"
							yChannelSelector="G"
							width="100%"
							height="100%"
							result="displacedImageOpaque"
						/>
						<feColorMatrix
							in="displacedImage"
							type="matrix"
							values="0 0 0 1 0  0 0 0 0 0  0 0 0 0 0  0 0 0 127 0"
							result="displacedImageRed"
						/>
						<feColorMatrix
							in="effect1_innerShadow_225_2"
							type="matrix"
							values="0 0 0 1 0  0 0 0 0 0  0 0 0 0 0  0 0 0 127 0"
						/>
						<feComposite in="displacedImageRed" operator="atop" result="transparencyRedMap" />
						<feColorMatrix
							in="transparencyRedMap"
							type="matrix"
							values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 0 0 0 0"
							result="transparencyAlphaMap"
						/>
						<feComposite in="displacedImageOpaque" in2="imageOpaque" operator="over" />
						<feComposite in2="transparencyAlphaMap" operator="in" result="effect2_texture_225_2" />
					</filter>
					<clipPath id="clip0_225_2">
						<rect width="32" height="32" rx="16" fill="white" style="fill:white;fill-opacity:1;" />
					</clipPath>
				</defs>
			</svg>
		{:else if message.author}
			<span class="author">{getInitials(message.author)}</span>
		{/if}

		<!-- <div>
			{#if message.author}
				<span class="author">{message.author}</span>
				{#if message.timestamp}
					<time class="timestamp" datetime={message.timestamp}>
						{new Date(message.timestamp).toLocaleString('en-US', {
							timeStyle: 'short'
						})}
					</time>
				{/if}
			{/if}
		</div> -->
	</header>

	<div class="content">
		{#if htmlContent}
			{@html htmlContent}
		{:else if message.content}
			{message.content}
		{/if}
	</div>
</article>

<style>
	.message {
		display: flex;
		gap: var(--size-6);
		inline-size: max-content;
		max-inline-size: 100%;
		/* padding-inline-end: var(--size-24); */
		/* margin-inline-start: calc(-1 * var(--size-14)); */

		&.user {
			flex-direction: row-reverse;
			margin-inline-start: auto;
			padding-inline-start: var(--size-24);
			padding-inline-end: 0;
			/* margin-inline-end: calc(-1 * var(--size-14)); */
		}
	}

	header {
		flex: none;

		svg {
			aspect-ratio: 1;
			inline-size: var(--size-8);
			border-radius: var(--radius-round);
		}
	}

	.author {
		aspect-ratio: 1;
		block-size: var(--size-8);
		border-radius: var(--radius-round);
		background: var(--gradient-black-2);
		color: var(--text-3);
		font-size: var(--font-size-1);
		font-weight: var(--font-weight-5);
		line-height: var(--font-lineheight-0);
		text-transform: uppercase;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.content {
		& {
			padding-block-start: var(--size-1-5);
		}

		& :global(p),
		& :global(ul),
		& :global(ol) {
			color: var(--text-1);
			opacity: 0.8;
			font-size: var(--font-size-5);
			line-height: var(--font-lineheight-3);
			/* margin-block-end: var(--size-3); */

			&:global(:has(+ ul, + ol, + p)) {
				margin-block-end: var(--size-3);
				/* margin-block-end: 0; */
			}
		}

		& :global(ul) {
			list-style-type: '⋅ ';
			margin-inline-start: var(--size-4);
		}

		& :global(ol) {
			list-style-type: decimal;
			margin-inline-start: var(--size-5);
		}

		& :global(strong) {
			font-weight: var(--font-weight-6);
		}

		& :global(code) {
			background-color: #f0f0f0;
		}

		& :global(a) {
			color: var(--text-1);
			transition: color 150ms ease;
			text-decoration: underline;

			&:hover {
				color: var(--text-3);
			}
		}
	}
</style>
