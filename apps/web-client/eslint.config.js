import { fileURLToPath } from "node:url";
import { createSvelteEslintConfig } from "@atlas/ui/eslint";
import svelteConfig from "./svelte.config.js";

const gitignorePath = fileURLToPath(new URL("./.gitignore", import.meta.url));

export default createSvelteEslintConfig({
  tsconfigRootDir: import.meta.dirname,
  gitignorePath,
  svelteConfig,
});
