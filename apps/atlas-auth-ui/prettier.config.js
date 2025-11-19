/** @type {import('prettier').Config} */
export default {
  htmlWhitespaceSensitivity: "ignore",
  objectWrap: "collapse",
  printWidth: 100,
  plugins: ["prettier-plugin-svelte", "@ianvs/prettier-plugin-sort-imports"],
  overrides: [{ files: "*.svelte", options: { parser: "svelte" } }],
};
