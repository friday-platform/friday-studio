import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
  define: { "process.env": "{}" },
  resolve: {
    alias: {
      // @db/sqlite uses Deno FFI — stub it out for Vite SSR (runs under Node).
      // The playground never actually calls Database methods at SSR time.
      "@db/sqlite": new URL("src/lib/server/stubs/db-sqlite.ts", import.meta.url).pathname,
    },
    // Deno's npm cache keeps multiple svelte installs in `.deno/svelte@<ver>/`
    // and sub-packages may symlink to a stale one (e.g. @tanstack/svelte-query@6.1.13
    // → svelte@5.55.3). The compiler plugin picks up 5.55.4 from root node_modules
    // but Vite's dep optimizer pre-bundled the runtime from 5.55.3 via a sub-package,
    // producing a "Cannot read properties of undefined (reading 'call')" in
    // `get_next_sibling` at mount. Dedupe forces a single svelte runtime.
    dedupe: ["svelte", "@tanstack/svelte-query"],
  },
  ssr: {
    // @opentelemetry/api is a transitive dep of the ai SDK — not available
    // in the SSR module graph. Externalizing prevents Vite from trying to
    // resolve it during dev HMR (the app runs client-only via adapter-static).
    external: ["@opentelemetry/api", "@db/sqlite"],
  },
  optimizeDeps: {
    // Deno's npm resolver produces orphaned sub-trees (e.g. two @tanstack/svelte-query
    // installs pinning different svelte versions). When Vite's optimizer runs it
    // can discover deps at two different hashes and fall into a stuck state where
    // `@ai-sdk/svelte` returns 504 "Outdated Optimize Dep" for the old hash the
    // transformed page modules still reference. Pre-declaring the heavy client deps
    // anchors the optimizer's first-pass scan so all hashes are consistent.
    include: ["@ai-sdk/svelte", "ai", "@tanstack/svelte-query", "svelte"],
  },
  server: {
    port: 5200,
    hmr: { overlay: false },
    fs: { allow: ["../.."] },
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "credentialless",
      "Permissions-Policy": "local-fonts=()",
    },
    proxy: {
      "/pty-proxy": {
        target: "http://localhost:7681",
        ws: true,
        rewrite: (path) => path.replace(/^\/pty-proxy/, ""),
      },
    },
  },
});
