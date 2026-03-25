import process from "node:process";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [svelte()],
  test: {
    reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
    coverage: { provider: "v8" },
    include: ["**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: ["**/node_modules/**", "apps/friday-website/**", "opensrc/**"],
    update: process.env.CI ? "none" : "new",
  },
});
