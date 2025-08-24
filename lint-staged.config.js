/**
 * @filename: lint-staged.config.js
 * @type {import('lint-staged').Configuration}
 */
export default {
  "**/*": () => "deno task fmt",
  "**/*.{ts,tsx,js,jsx,mjs}": () =>
    "deno run --allow-read --allow-write --allow-run scripts/validate-imports-staged.ts",
};
