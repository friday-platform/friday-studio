import process from "node:process";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

// Detect if this is a Tauri desktop build at compile time
// We set TAURI_BUILD=true in tauri.conf.json's beforeBuildCommand
const isTauriBuild = process.env.TAURI_BUILD === "true";

export default defineConfig({
  plugins: [sveltekit()],
  clearScreen: false,
  define: {
    "process.env": "{}",
    // Only use build-time detection for production builds
    // In dev mode, this will be false, but we'll detect at runtime using window.__TAURI__
    __TAURI_BUILD__: isTauriBuild,
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    // Note: API proxying is handled by SvelteKit server routes (src/routes/api/[...path]/+server.ts)
    // This eliminates Vite proxy errors and gives us full control over error handling
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
});
