import { sveltekit } from "@sveltejs/kit/vite";
import { compression } from "vite-plugin-compression2";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [sveltekit(), compression({ algorithms: ["brotliCompress", "gzip"] })],
  server: { port: 2345 },
  test: {
    expect: { requireAssertions: true },
    projects: [
      {
        extends: "./vite.config.ts",
        test: {
          name: "server",
          environment: "node",
          include: ["src/**/*.{test,spec}.{js,ts}"],
          exclude: ["src/**/*.svelte.{test,spec}.{js,ts}"],
        },
      },
    ],
  },
});
