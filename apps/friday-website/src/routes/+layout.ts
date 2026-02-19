// All routes are static marketing pages — prerender everything.
// Security headers for prerendered HTML are set by the reverse proxy / CDN.
// hooks.server.ts still handles dynamic responses (errors, redirects, /metrics).
export const prerender = true;
