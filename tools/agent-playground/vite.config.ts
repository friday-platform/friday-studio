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
  },
  ssr: {
    // @opentelemetry/api is a transitive dep of the ai SDK — not available
    // in the SSR module graph. Externalizing prevents Vite from trying to
    // resolve it during dev HMR (the app runs client-only via adapter-static).
    external: ["@opentelemetry/api", "@db/sqlite"],
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
