// Prerendering disabled: prerendered pages are served directly by sirv,
// bypassing hooks.server.ts — so no security headers (CSP, X-Frame-Options,
// X-Content-Type-Options, etc.) are set. SSR ensures hooks run for every
// HTML response.
export const prerender = false;
