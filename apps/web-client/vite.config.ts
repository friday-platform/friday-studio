import { execSync } from "node:child_process";
import process from "node:process";
import { sentrySvelteKit } from "@sentry/sveltekit";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";

// Sentry environment: local (dev), sandbox, production
// Set via SENTRY_ENVIRONMENT env var at build time, defaults to "production" for Docker builds
const sentryEnvironment = process.env.SENTRY_ENVIRONMENT || "production";

// Parse FEATURE_FLAGS env var: comma-separated list of flag names to enable
const featureFlags = (process.env.FEATURE_FLAGS || "").split(",").filter(Boolean);

// Get git commit hash for Sentry release tracking
const gitCommit = (() => {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
})();

export default defineConfig(({ mode }) => ({
  plugins: [sentrySvelteKit(), sveltekit()],
  clearScreen: false,
  define: {
    "process.env": "{}",
    // In dev mode, client connects directly to daemon at localhost:8080
    // In production, client uses relative URLs (routed by Traefik)
    __DEV_MODE__: JSON.stringify(mode === "development"),
    // Sentry environment injected at build time
    __SENTRY_ENVIRONMENT__: JSON.stringify(mode === "development" ? "local" : sentryEnvironment),
    // Sentry release for tracking deployments
    __SENTRY_RELEASE__: JSON.stringify(`atlas-web-client@${gitCommit}`),
    __FEATURE_FLAGS__: JSON.stringify(featureFlags),
  },
  server: {
    port: 1420,
    strictPort: true,
    hmr: undefined,
    watch: {},
    fs: {
      allow: [
        // Allow serving files from the workspace root and parent directories
        "../..",
        // Allow serving from node_modules
        "../../node_modules",
      ],
    },
  },
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
}));
