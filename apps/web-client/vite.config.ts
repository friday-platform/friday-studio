import { readFileSync } from "node:fs";
import deno from "@deno/vite-plugin";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

const host = Deno.env.get("TAURI_DEV_HOST");

// Custom plugin to handle YAML imports with { type: "text" }
const yamlTextPlugin = () => ({
  name: "yaml-text-loader",
  transform(_code: any, id: string) {
    if (id.endsWith(".yml") || id.endsWith(".yaml")) {
      try {
        const yamlContent = readFileSync(id, "utf-8");
        return { code: `export default ${JSON.stringify(yamlContent)};`, map: null };
      } catch (e) {
        console.error(`Failed to load YAML file: ${id}`, e);
      }
    }
  },
});

export default defineConfig({
  plugins: [yamlTextPlugin(), deno(), sveltekit()],
  resolve: { extensions: [".ts", ".js", ".json", ".jsonc"] },
  assetsInclude: ["**/*.yml"],
  // server: {

  // },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
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
