import { sveltekit } from "@sveltejs/kit/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  plugins: [sveltekit()],
  server: {
    fs: { allow: [rootDir] },
  },
});
