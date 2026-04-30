import { fileURLToPath } from "node:url";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({ plugins: [sveltekit()], server: { fs: { allow: [rootDir] } } });
