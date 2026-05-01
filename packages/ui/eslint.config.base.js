import { includeIgnoreFile } from "@eslint/compat";
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import svelte from "eslint-plugin-svelte";
import globals from "globals";
import svelteParser from "svelte-eslint-parser";
import ts from "typescript-eslint";

/**
 * Shared ESLint flat config for Svelte + TypeScript projects.
 *
 * @param {Object} options
 * @param {string} options.tsconfigRootDir - `import.meta.dirname` of the consuming app
 * @param {string} options.gitignorePath - absolute path to the app's .gitignore
 * @param {Object} options.svelteConfig - the app's imported svelte.config.js
 * @param {string[]} [options.ignores] - additional directories to ignore
 * @param {Object} [options.extraRules] - additional rules to merge into the base rule set
 * @returns {import('typescript-eslint').ConfigArray}
 */
export function createSvelteEslintConfig({
  tsconfigRootDir,
  gitignorePath,
  svelteConfig,
  ignores = [],
  extraRules = {},
}) {
  return ts.config(
    { languageOptions: { parserOptions: { tsconfigRootDir } } },
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
        "svelte/no-navigation-without-resolve": "off",
        "svelte/no-at-html-tags": "off",
        "svelte/require-each-key": "error",
        "svelte/no-unused-props": "off",
        "svelte/no-dupe-style-properties": "off",
        "svelte/prefer-svelte-reactivity": "off",
        "svelte/prefer-writable-derived": "warn",
        "svelte/no-dom-manipulating": "off",
        "svelte/require-store-reactive-access": "off",
        ...extraRules,
      },
    },
    {
      files: ["**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
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
    { ignores: ["node_modules", "build", ".svelte-kit", "dist", ...ignores] },
  );
}
