import { readFileSync } from "node:fs";
import deno from "@deno/vite-plugin";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

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
  server: {
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
