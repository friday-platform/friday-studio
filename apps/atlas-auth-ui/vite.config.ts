import { execSync } from "node:child_process";
import process from "node:process";
import { sentrySvelteKit } from "@sentry/sveltekit";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

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
  server: { port: 5173, strictPort: false },
  define: {
    __SENTRY_ENVIRONMENT__: JSON.stringify(mode === "development" ? "local" : sentryEnvironment),
    __SENTRY_RELEASE__: JSON.stringify(`atlas-auth-ui@${gitCommit}`),
    __DEV_MODE__: JSON.stringify(mode === "development"),
  },
}));
