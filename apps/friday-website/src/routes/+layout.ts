// All routes are static marketing pages — prerender everything.
// Security headers for prerendered HTML are set by the reverse proxy / CDN.
// hooks.server.ts still handles dynamic responses (errors, redirects, /metrics).
export const prerender = true;

// Output prerendered pages as directory/index.html (e.g. announcement/index.html)
// instead of extensionless files (e.g. announcement). Sirv infers content-type
// from the file extension — without .html it serves with no content-type, and
// x-content-type-options: nosniff causes browsers to render raw HTML source.
export const trailingSlash = "always";
