<script lang="ts">
import "../app.css";
import { onMount } from "svelte";
import { afterNavigate } from "$app/navigation";
import { resolve } from "$app/paths";
import { page } from "$app/state";
import { env } from "$env/dynamic/public";
import favicon from "$lib/assets/favicon.svg?no-inline";
import logo from "$lib/assets/logo.svg?no-inline";
import logoGrey from "$lib/assets/logo-grey.svg?no-inline";
import { DropdownMenu } from "$lib/components/dropdown-menu";
import Bluesky from "$lib/icons/bluesky.svelte";
import Discord from "$lib/icons/discord.svelte";
import Linkedin from "$lib/icons/linkedin.svelte";
import Soc from "$lib/icons/soc.svelte";
import X from "$lib/icons/x.svelte";

let { children } = $props();

const currentYear = new Date().getFullYear();

const jsonLd =
  // biome-ignore lint/style/useTemplate: split prevents HTML parser from seeing closing script tag
  `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": "https://hellofriday.ai/#organization",
        name: "Tempest Labs",
        url: "https://hellofriday.ai",
        logo: "https://hellofriday.ai/og-image.png",
        sameAs: [
          "https://www.linkedin.com/company/hello-friday-ai/",
          "https://x.com/HelloFridayAI",
          "https://bsky.app/profile/fridayai.bsky.social",
          "https://discord.gg/uczJyp5FMH",
        ],
      },
      {
        "@type": "WebSite",
        "@id": "https://hellofriday.ai/#website",
        url: "https://hellofriday.ai",
        name: "Friday",
        publisher: { "@id": "https://hellofriday.ai/#organization" },
      },
    ],
  })}<` + `/script>`;

onMount(() => {
  if (env.PUBLIC_ANALYTICS_ENABLED !== "true") return;

  // Bootstrap GTM client-side — avoids CSP inline script issues with prerendered pages.
  // The GTM external URL is already allowed in script-src CSP directives.
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });
  const script = document.createElement("script");
  script.async = true;
  script.src = "https://www.googletagmanager.com/gtm.js?id=GTM-WKFQFCTM";
  document.head.appendChild(script);
});

afterNavigate(() => {
  if (typeof gtag === "function") {
    gtag("event", "page_view", { page_title: document.title, page_location: window.location.href });
  }
});
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<link rel="preconnect" href="https://cdn-cookieyes.com" crossorigin="anonymous" />
	<link rel="preconnect" href="https://www.googletagmanager.com" crossorigin="anonymous" />
	<link rel="preconnect" href="https://www.clarity.ms" crossorigin="anonymous" />
	<link rel="canonical" href="https://hellofriday.ai{page.url.pathname}" />
	<title>Friday</title>
	<meta property="og:site_name" content="Friday" />
	<meta property="og:url" content="https://hellofriday.ai{page.url.pathname}" />
	<meta property="og:image" content="https://hellofriday.ai/og-image.png" />
	<meta property="og:image:width" content="1200" />
	<meta property="og:image:height" content="630" />
	<meta property="og:image:type" content="image/png" />
	<meta name="twitter:card" content="summary_large_image" />
	<meta name="twitter:image" content="https://hellofriday.ai/og-image.png" />
	<meta property="og:locale" content="en_US" />
	<!-- eslint-disable-next-line svelte/no-at-html-tags -- Static JSON-LD, no user input -->
	{@html jsonLd}
</svelte:head>

{#if env.PUBLIC_ANALYTICS_ENABLED === "true"}
<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-WKFQFCTM" title="GTM" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>
{/if}

<a href="#main-content" class="skip-to-content">Skip to content</a>

<header>
	<a href={resolve('/')}>
		<img src={logo} alt="Friday logo" />
	</a>

	<div class="mobile-menu">
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				<span class="mobile-menu-trigger">Menu</span>
			</DropdownMenu.Trigger>
			<DropdownMenu.Content>
				<DropdownMenu.Item href={resolve('/')}>Home</DropdownMenu.Item>

				<DropdownMenu.Item href={resolve('/announcement')}>Announcement</DropdownMenu.Item>

				<DropdownMenu.Item href="/#faq">FAQ</DropdownMenu.Item>

				<DropdownMenu.Item
					href="https://medium.com/friday-ai"
					target="_blank"
					rel="noopener noreferrer">Blog</DropdownMenu.Item
				>

				<DropdownMenu.Item
					href="https://docs.hellofriday.ai"
					target="_blank"
					rel="noopener noreferrer">Docs</DropdownMenu.Item
				>

				<DropdownMenu.Item href="mailto:hello@hellofriday.ai" rel="noopener noreferrer"
					>Contact Us</DropdownMenu.Item
				>

				<DropdownMenu.Separator />

				<DropdownMenu.Item
					href="https://auth.hellofriday.ai/signup"
					target="_blank"
					rel="noopener noreferrer"
				>
					Join the beta
				</DropdownMenu.Item>

				<DropdownMenu.Item
					href="https://auth.hellofriday.ai"
					target="_blank"
					rel="noopener noreferrer"
				>
					Login
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>

	<nav aria-label="Main navigation">
		<ul>
			<li><a href={resolve('/')}>Home</a></li>
			<!-- <li><a href={resolve('/announcement')}>Announcement</a></li> -->
			<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -->
			<li><a href="/#faq">FAQ</a></li>
			<li>
				<a href="https://medium.com/friday-ai" target="_blank" rel="noopener noreferrer">Blog</a>
			</li>
			<li>
				<a href="https://docs.hellofriday.ai" target="_blank" rel="noopener noreferrer">Docs</a>
			</li>

			<li><a href="mailto:hello@hellofriday.ai">Contact Us</a></li>
		</ul>
	</nav>

	<div class="ctas">
		<a href="https://auth.hellofriday.ai/signup" target="_blank" rel="noopener noreferrer"
			>Join the beta</a
		>

		<a href="https://auth.hellofriday.ai" target="_blank" rel="noopener noreferrer">Login</a>
	</div>
</header>

<main id="main-content">
	{@render children()}
</main>

<footer>
	<a href={resolve('/')}>
		<img src={logoGrey} alt="Friday logo (alternate)" width="89" height="26" loading="lazy" />
	</a>

	<p>&copy; {currentYear} Tempest Labs, Inc.</p>

	<div class="soc">
		<Soc />

		<p>SOC 2 Type II Compliant</p>
	</div>

	<ul class="nav">
		<li><a href={resolve('/terms')}>Terms & Conditions</a></li>
		<li><a href={resolve('/privacy')}>Privacy Policy</a></li>
		<li>
			<a href="https://docs.hellofriday.ai/security" target="_blank" rel="noopener noreferrer"
				>Security</a
			>
		</li>
	</ul>

	<ul class="social">
		<li>
			<a
				href="https://www.linkedin.com/company/hello-friday-ai/"
				target="_blank"
				rel="noopener noreferrer"
				aria-label="LinkedIn"
			>
				<Linkedin />
			</a>
		</li>

		<li>
			<a
				href="https://bsky.app/profile/fridayai.bsky.social"
				target="_blank"
				rel="noopener noreferrer"
				aria-label="Bluesky"
			>
				<Bluesky />
			</a>
		</li>

		<li>
			<a
				href="https://x.com/HelloFridayAI"
				target="_blank"
				rel="noopener noreferrer"
				aria-label="X (formerly Twitter)"
			>
				<X />
			</a>
		</li>

		<li>
			<a
				href="https://discord.gg/uczJyp5FMH"
				target="_blank"
				rel="noopener noreferrer"
				aria-label="Discord"
			>
				<Discord />
			</a>
		</li>
	</ul>
</footer>

<style>
	header {
		align-items: center;
		background: linear-gradient(to bottom, var(--color-canvas) 50%, var(--color-canvas-a) 100%);
		block-size: var(--size-14);
		display: flex;
		padding-inline: var(--size-6);
		position: sticky;
		inset-block-start: 0;
		z-index: var(--layer-5);

		@media (min-width: 768px) {
			block-size: var(--size-18);
			padding-inline: var(--size-8);
		}
	}

	a {
		font-size: var(--font-size-4);
		font-weight: var(--font-weight-5);
		flex: none;
		inline-size: max-content;
		transition: all 200ms ease;
	}

	.mobile-menu {
		margin-inline: auto 0;
		.mobile-menu-trigger {
			font-size: var(--font-size-5);
			font-weight: var(--font-weight-5);
		}

		@media (min-width: 768px) {
			display: none;
		}
	}

	nav {
		display: none;
		padding-inline: var(--size-12) 0;

		@media (min-width: 768px) {
			display: block;
		}

		ul {
			align-items: center;
			display: flex;
			gap: var(--size-6);
		}

		a {
			opacity: 0.8;
			position: relative;

			&:before {
				background-color: hsl(0 0 0 / 0.08);
				border-radius: var(--radius-2);
				content: '';
				inset-block: calc(-1 * var(--size-0-75));
				inset-inline: calc(-1 * var(--size-1-5));
				opacity: 0;
				position: absolute;
				transition: all 200ms ease;
			}

			&:hover {
				opacity: 1;

				&:before {
					opacity: 1;
				}
			}
		}
	}

	.ctas {
		align-items: center;
		display: none;
		gap: var(--size-6);
		margin-inline: auto 0;

		@media (min-width: 768px) {
			display: flex;
		}

		a {
			color: var(--color-blue-2);
			font-weight: var(--font-weight-5);

			&:nth-child(1) {
				align-items: center;
				background: var(--color-canvas-light);
				block-size: var(--size-7);
				border-radius: var(--radius-3);
				box-shadow: var(--shadow-1);
				display: flex;
				justify-content: center;
				padding-inline: var(--size-3);
				text-align: center;

				&:hover {
					background-color: var(--color-canvas);
				}
			}

			&:nth-child(2) {
				position: relative;
				&:before {
					background-color: hsl(0 0 0 / 0.08);
					border-radius: var(--radius-2);
					content: '';
					inset-block: calc(-1 * var(--size-0-5));
					inset-inline: calc(-1 * var(--size-1-5));
					opacity: 0;
					position: absolute;
					transition: all 200ms ease;
				}

				&:hover {
					opacity: 1;

					&:before {
						opacity: 1;
					}
				}
			}
		}
	}

	footer {
		align-items: center;
		display: flex;
		flex-direction: column;
		gap: var(--size-4);
		justify-content: center;
		padding-block: 0 var(--size-8);
		padding-inline: var(--size-6);
		text-align: center;

		@media (min-width: 1060px) {
			block-size: var(--size-18);
			flex-direction: row;
			gap: var(--size-8);
			padding-inline: var(--size-8);
			justify-content: initial;
			text-align: center;
		}

		p {
			font-size: var(--font-size-2);
			font-weight: var(--font-weight-5);
			opacity: 0.6;
		}

		.soc {
			align-items: center;
			display: flex;
			gap: var(--size-2);

			@media (min-width: 1060px) {
				margin-inline: 0 auto;
			}
		}

		.nav {
			align-items: center;
			display: flex;
			gap: var(--size-3);

			li {
				flex: none;
			}

			@media (min-width: 768px) {
				gap: var(--size-4);
			}

			a {
				font-size: var(--font-size-3);
				inline-size: max-content;
				opacity: 0.8;
				position: relative;

				&:before {
					background-color: hsl(0 0 0 / 0.08);
					border-radius: var(--radius-2);
					content: '';
					inset-block: calc(-1 * var(--size-0-5));
					inset-inline: calc(-1 * var(--size-1));
					opacity: 0;
					position: absolute;
					transition: all 200ms ease;
				}

				&:hover {
					opacity: 1;

					&:before {
						opacity: 1;
					}
				}
			}
		}

		.social {
			align-items: center;
			display: flex;
			gap: var(--size-3);

			li {
				flex: none;
			}

			@media (min-width: 768px) {
				gap: var(--size-4);
			}

			a {
				block-size: var(--size-4);
				display: block;
				inline-size: var(--size-4);
				position: relative;

				& :global(svg) {
					transform: translate3d(0, 0, 0);
				}

				&:before {
					background-color: hsl(0 0 0 / 0.08);
					border-radius: var(--radius-2);
					content: '';
					inset-block: calc(-1 * var(--size-1));
					inset-inline: calc(-1 * var(--size-1));
					opacity: 0;
					position: absolute;
					transition: all 200ms ease;
				}

				&:hover {
					opacity: 1;

					&:before {
						opacity: 1;
					}
				}
			}
		}
	}

	.skip-to-content {
		position: absolute;
		inset-inline-start: -9999px;
		inset-block-start: auto;
		z-index: 100;
		padding: var(--size-2) var(--size-4);
		background: var(--color-canvas-light);
		color: var(--color-text);
		font-weight: var(--font-weight-5);
		border-radius: var(--radius-2);
		box-shadow: var(--shadow-1);

		&:focus-visible {
			inset-inline-start: var(--size-2);
			inset-block-start: var(--size-2);
		}
	}
</style>
