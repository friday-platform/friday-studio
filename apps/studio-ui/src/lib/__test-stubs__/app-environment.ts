/**
 * Vitest stub for SvelteKit's `$app/environment` virtual module.
 *
 * Component tests mount Svelte files that read `browser` from this module.
 * Vitest doesn't load the SvelteKit Vite plugin (only `vite-plugin-svelte`),
 * so the virtual module never gets registered. This stub is wired in via
 * `resolve.alias` in `vitest.config.ts`.
 */

export const browser = false;
export const dev = true;
export const building = false;
export const version = "test";
