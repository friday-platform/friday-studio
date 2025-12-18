/**
 * @filename: lint-staged.config.js
 * @type {import('lint-staged').Configuration}
 */
export default { "**/*": () => ["deno task fmt", "deno task lint"] };
