import { preprocessMeltUI } from "@melt-ui/pp";
import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  // Order matters: vitePreprocess first (lang transforms — TS/SCSS),
  // then meltUI (rewrites `use:melt={$store}` directives).
  preprocess: [vitePreprocess(), preprocessMeltUI()],
  kit: {
    adapter: adapter({ fallback: "index.html" }),
    // Inline ALL CSS into every SSR response: the chat-export route ships a
    // zip of static HTML that must render standalone in any browser with no
    // <link rel="stylesheet"> fetches. Tradeoff: every studio-ui page now
    // duplicates its full CSS inline — no cross-navigation stylesheet cache.
    // Fine because studio-ui is a local-only dev tool; if it ever
    // serves over a network, move this into a per-route rewriter in +server.ts.
    inlineStyleThreshold: Infinity,
  },
};

export default config;
