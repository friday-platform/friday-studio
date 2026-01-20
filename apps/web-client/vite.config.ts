import { execSync } from "node:child_process";
import process from "node:process";
import { sentrySvelteKit } from "@sentry/sveltekit";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vitest/config";

const host = process.env.TAURI_DEV_HOST;

// Detect if this is a Tauri desktop build at compile time
// We set TAURI_BUILD=true in tauri.conf.json's beforeBuildCommand
const isTauriBuild = process.env.TAURI_BUILD === "true";

// Sentry environment: local (dev), sandbox, production
// Set via SENTRY_ENVIRONMENT env var at build time, defaults to "production" for Docker builds
const sentryEnvironment = process.env.SENTRY_ENVIRONMENT || "production";

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
    // Only use build-time detection for production builds
    // In dev mode, this will be false, but we'll detect at runtime using window.__TAURI__
    __TAURI_BUILD__: JSON.stringify(isTauriBuild),
    // In dev mode, client connects directly to daemon at localhost:8080
    // In production, client uses relative URLs (routed by Traefik)
    __DEV_MODE__: JSON.stringify(mode === "development"),
    // Sentry environment injected at build time
    __SENTRY_ENVIRONMENT__: JSON.stringify(mode === "development" ? "local" : sentryEnvironment),
    // Sentry release for tracking deployments
    __SENTRY_RELEASE__: JSON.stringify(`atlas-web-client@${gitCommit}`),
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    // Note: In dev mode, client connects directly to daemon at localhost:8080 via getAtlasDaemonUrl().
    // In production, Traefik routes /api/* to daemon. No SvelteKit proxy needed.
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
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
