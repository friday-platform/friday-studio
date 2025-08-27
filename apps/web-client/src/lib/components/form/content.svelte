<script lang="ts">
import type { Snippet } from "svelte";
import { createContext } from "./context";
import type { Layout } from "./types";

type Props = { children: Snippet; spacing?: "small" | "regular" | "large" | "xl"; layout?: Layout };

let { children, spacing = "regular", layout = "inline" }: Props = $props();

createContext({ layout });
</script>

<div class="spacing--{spacing}">
	{@render children()}
</div>

<style>
	div {
		--form-content-spacing: var(--size-4);
		display: grid;
		grid-template-columns: 6fr 7fr;
		gap: var(--form-content-spacing);

		&.spacing--small {
			--form-content-spacing: var(--size-2);
		}

		&.spacing--large {
			--form-content-spacing: var(--size-6);
		}

		&.spacing--xl {
			--form-content-spacing: var(--size-10);
		}

		& :global(.tempest--component__separator) {
			grid-column: 1 / -1;
		}
	}
</style>
