// SPA mode — disable SSR for all routes.
// The playground uses adapter-static with fallback, so all rendering happens
// client-side. SSR evaluation fails because transitive deps (ai SDK →
// @opentelemetry/api) aren't available in the SSR module graph.
export const ssr = false;
