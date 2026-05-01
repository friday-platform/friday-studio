import process from "node:process";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// https://vitejs.dev/config/
export default defineConfig(() => ({
  plugins: [svelte()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1421,
    strictPort: true,
    watch: {
      // 3. tell vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
    // Permit reading repo-root LICENSE via `?raw` import in License.svelte.
    fs: { allow: ["..", "../.."] },
  },
  // 3. to access the Tauri environment variables set by the CLI with information about the current target
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    // Tauri uses Chromium on Windows and WebKit on macOS and Linux.
    // Safari 16+ is needed because Svelte 5 emits patterns esbuild 0.27 can't
    // downlevel for older Safari (nested destructuring, dynamic-import binding
    // patterns). Safari 16 shipped with macOS 13 (2022), which matches the
    // realistic macOS 13+ floor for the Tauri runtime.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari16",
    // don't minify for debug builds
    minify: !process.env.TAURI_ENV_DEBUG,
    // produce sourcemaps for debug builds
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
}));
