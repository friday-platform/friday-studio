/** @type {import('prettier').Config} */
export default {
  // Aligned with biome.json settings
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  objectWrap: "collapse",
  htmlWhitespaceSensitivity: "ignore",
  plugins: ["prettier-plugin-svelte", "@ianvs/prettier-plugin-sort-imports"],
  overrides: [{ files: "*.svelte", options: { parser: "svelte" } }],
};
