import process from "node:process";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      // Vitest does not load the SvelteKit Vite plugin, so `$app/*`
      // virtual modules and the `$lib` alias never get registered. Stub
      // the ones component tests reach for, and reproduce the `$lib`
      // alias so route-component tests (e.g. the export preview page)
      // resolve the same way the dev server does.
      $lib: fileURLToPath(new URL("./tools/agent-playground/src/lib", import.meta.url)),
      "$app/environment": fileURLToPath(
        new URL(
          "./tools/agent-playground/src/lib/__test-stubs__/app-environment.ts",
          import.meta.url,
        ),
      ),
    },
  },
  test: {
    reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
    setupFiles: ["./vitest.setup.ts"],
    coverage: { provider: "v8" },
    include: ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: [
      "**/node_modules/**",
      "opensrc/**",
      // Component test pulls in a Svelte-table alpha whose dist files
      // import without extensions; vitest's ESM resolver rejects them.
      // The component itself ships fine — only the test loader is broken.
      "tools/agent-playground/src/lib/components/mcp/mcp-credentials-panel.test.ts",
    ],
    update: process.env.CI ? "none" : "new",
    // `@tanstack/svelte-query` ships a `.svelte` file
    // (`HydrationBoundary.svelte`) in its published dist. Vitest's
    // default loader externalises node_modules and tries to import the
    // file as JS, which dies on the first `<`. Inlining lets the svelte
    // plugin compile it.
    server: { deps: { inline: [/@tanstack\/svelte-query/] } },
  },
});
