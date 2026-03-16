/**
 * Shared CSP directives — single source of truth for svelte.config.js and hooks.server.ts.
 * Plain .js because svelte.config.js cannot import .ts files.
 */

export const REPORT_ENDPOINT = "https://dm35suqd.uriports.com/reports";

/**
 * @param {{ dev: boolean }} options
 * @returns {Record<string, string[] | true>}
 */
export function makeDirectives({ dev }) {
  return {
    "default-src": ["self"],
    // CSP Level 3: 'strict-dynamic' propagates trust from SvelteKit's hashed
    // scripts to dynamically-created children (GTM → GA, CookieYes, Clarity).
    // URL hosts and 'unsafe-inline' are ignored by CSP3 browsers — kept as
    // CSP Level 2 fallback only. Cloudflare Web Analytics (edge-injected static
    // <script>) won't execute under strict-dynamic; server-side Cloudflare
    // analytics is unaffected.
    "script-src": [
      "self",
      "report-sample",
      "strict-dynamic",
      "unsafe-inline",
      "https://cdn-cookieyes.com",
      "https://www.googletagmanager.com",
      "https://*.clarity.ms",
      "https://static.cloudflareinsights.com",
    ],
    "style-src": ["self", "report-sample", "unsafe-inline", "https://cdn-cookieyes.com"],
    "img-src": [
      "self",
      "data:",
      "https://cdn-cookieyes.com",
      "https://*.google-analytics.com",
      "https://*.googletagmanager.com",
      "https://*.clarity.ms",
      "https://c.bing.com",
      "https://i.ytimg.com",
    ],
    "frame-src": ["self", "https://www.youtube.com", "https://www.googletagmanager.com"],
    "font-src": ["self"],
    "connect-src": [
      "self",
      "https://cdn-cookieyes.com",
      "https://*.cookieyes.com",
      "https://*.google-analytics.com",
      "https://analytics.google.com",
      "https://*.googletagmanager.com",
      "https://*.clarity.ms",
      "https://c.bing.com",
      "https://cloudflareinsights.com",
    ],
    "worker-src": dev ? ["self", "blob:"] : ["self"],
    "object-src": ["none"],
    "frame-ancestors": ["none"],
    "base-uri": ["self"],
    "form-action": ["self"],
    "report-to": ["default"],
    ...(dev ? {} : { "upgrade-insecure-requests": true }),
  };
}

/**
 * Convert a SvelteKit-style directives object to a CSP header string.
 * Mirrors SvelteKit's internal quoting: bare keywords (self, none, etc.) get single-quoted.
 * @param {Record<string, string[] | true>} directives
 * @returns {string}
 */
export function directivesToHeaderString(directives) {
  const KEYWORDS = new Set([
    "self",
    "none",
    "unsafe-inline",
    "unsafe-eval",
    "unsafe-hashes",
    "strict-dynamic",
    "report-sample",
    "wasm-unsafe-eval",
  ]);

  return Object.entries(directives)
    .map(([key, value]) => {
      if (value === true) return key;
      const tokens = value.map((v) => (KEYWORDS.has(v) ? `'${v}'` : v));
      return `${key} ${tokens.join(" ")}`;
    })
    .join("; ");
}
