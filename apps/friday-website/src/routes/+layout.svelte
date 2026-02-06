<script lang="ts">
import "../app.css";
import { page } from "$app/state";
import favicon from "$lib/assets/favicon.svg";
import logo from "$lib/assets/logo.svg";
import logoGrey from "$lib/assets/logo-grey.svg";
import { DropdownMenu } from "$lib/components/dropdown-menu";
import Bluesky from "$lib/icons/bluesky.svelte";
import Linkedin from "$lib/icons/linkedin.svelte";
import X from "$lib/icons/x.svelte";

let { children } = $props();

const currentYear = new Date().getFullYear();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>Friday</title>
	<meta property="og:site_name" content="Friday" />
	<meta property="og:url" content="https://hellofriday.ai{page.url.pathname}" />
	<meta name="twitter:card" content="summary" />
</svelte:head>

<a href="#main-content" class="skip-to-content">Skip to content</a>

<header>
	<a href="/">
		<img src={logo} alt="Friday logo" />
	</a>

	<div class="mobile-menu">
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				<span class="mobile-menu-trigger">Menu</span>
			</DropdownMenu.Trigger>
			<DropdownMenu.Content>
				<DropdownMenu.Item href="/">Home</DropdownMenu.Item>

				<DropdownMenu.Item href="/announcement">Announcement</DropdownMenu.Item>

				<DropdownMenu.Item href="/#faq">FAQ</DropdownMenu.Item>

				<DropdownMenu.Item href="https://medium.com/friday-ai" target="_blank" rel="noopener noreferrer"
					>Blog</DropdownMenu.Item
				>

				<DropdownMenu.Item href="https://docs.hellofriday.ai" target="_blank" rel="noopener noreferrer">Docs</DropdownMenu.Item
				>

				<DropdownMenu.Separator />

				<DropdownMenu.Item href="https://auth.hellofriday.ai/signup" target="_blank" rel="noopener noreferrer">
					Join the Beta
				</DropdownMenu.Item>

				<DropdownMenu.Item href="https://auth.hellofriday.ai" target="_blank" rel="noopener noreferrer">
					Login
				</DropdownMenu.Item>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</div>

	<nav aria-label="Main navigation">
		<ul>
			<li><a href="/">Home</a></li>
			<li><a href="/announcement">Announcement</a></li>
			<li><a href="/#faq">FAQ</a></li>
			<li><a href="https://medium.com/friday-ai" target="_blank" rel="noopener noreferrer">Blog</a></li>
			<li><a href="https://docs.hellofriday.ai" target="_blank" rel="noopener noreferrer">Docs</a></li>
		</ul>
	</nav>

	<div class="ctas">
		<a href="https://auth.hellofriday.ai/signup" target="_blank" rel="noopener noreferrer">Join the Beta</a>

		<a href="https://auth.hellofriday.ai" target="_blank" rel="noopener noreferrer">Login</a>
	</div>
</header>

<main id="main-content">
	{@render children()}
</main>

<footer>
	<a href="/">
		<img src={logoGrey} alt="Friday logo (alternate)" width="89" height="26" loading="lazy" />
	</a>

	<p>&copy; {currentYear} Tempest Labs, Inc.</p>

	<ul>
		<li><a href="/terms">Terms & Conditions</a></li>
		<li><a href="/privacy">Privacy Policy</a></li>
		<li><a href="https://docs.hellofriday.ai/security" target="_blank" rel="noopener noreferrer">Security</a></li>
		<li><a href="mailto:hello@hellofriday.ai">Contact Us</a></li>
	</ul>

	<ul>
		<li>
			<a href="https://www.linkedin.com/company/hello-friday-ai/" target="_blank" rel="noopener noreferrer" aria-label="LinkedIn">
				<Linkedin />
			</a>
		</li>

		<li>
			<a href="https://bsky.app/profile/fridayai.bsky.social" target="_blank" rel="noopener noreferrer" aria-label="Bluesky">
				<Bluesky />
			</a>
		</li>

		<li>
			<a href="https://x.com/HelloFridayAI" target="_blank" rel="noopener noreferrer" aria-label="X (formerly Twitter)">
				<X />
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

		@media (min-width: 768px) {
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

			@media (min-width: 768px) {
				margin-inline: 0 auto;
			}
		}

		ul {
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
