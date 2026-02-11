import { fileURLToPath } from "node:url";
import { includeIgnoreFile } from "@eslint/compat";
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import svelteParser from "svelte-eslint-parser";
import ts from "typescript-eslint";
import svelteConfig from "./svelte.config.js";

const gitignorePath = fileURLToPath(new URL("./.gitignore", import.meta.url));

export default ts.config(
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
  includeIgnoreFile(gitignorePath),
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  prettier,
  ...svelte.configs.prettier,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      // typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
      // see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Disallow $inspect - it's for debugging only
      "svelte/no-inspect": "error",
      // Disable overly strict rules
      "svelte/no-navigation-without-resolve": "off", // Would require significant refactoring
      "svelte/no-at-html-tags": "off", // Legitimate uses with sanitized markdown
      "svelte/require-each-key": "error", // Keys required for DOM reconciliation
      "svelte/no-unused-props": "off", // Can be intentional for API design
      "svelte/no-dupe-style-properties": "off", // Valid for CSS color fallbacks (P3)
      "svelte/prefer-svelte-reactivity": "off", // Map reassignment pattern is valid
      "svelte/no-dom-manipulating": "off", // Some intentional DOM manipulation for measurements
      "svelte/require-store-reactive-access": "off", // Melt UI actions use raw store in use: directive
    },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts"],
    rules: {
      // Core ESLint rule doesn't understand Svelte's reactive assignment model —
      // assignments to $bindable/$state vars are side-effectful, not useless.
      "no-useless-assignment": "off",
    },
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        projectService: true,
        extraFileExtensions: [".svelte"],
        parser: ts.parser,
        svelteConfig,
      },
    },
  },
  { ignores: ["node_modules", "build", ".svelte-kit"] },
);
