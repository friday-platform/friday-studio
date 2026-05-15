/**
 * Vitest stub for SvelteKit's `$app/paths` virtual module.
 *
 * Component tests mount Svelte files that call `resolve()` to build route
 * URLs. Vitest doesn't load the SvelteKit Vite plugin (only
 * `vite-plugin-svelte`), so the virtual module never gets registered. This
 * stub is wired in via `resolve.alias` in `vitest.config.ts`.
 *
 * `resolve` just echoes the route id back — tests render components, they
 * don't assert on resolved URLs.
 */

export const base = "";
export const assets = "";

export function resolve(id: string, _params?: Record<string, string>): string {
  return id;
}
