import { readFile, writeFile } from "node:fs/promises";

const BINARY_EXTENSIONS = new Set([
  ".lock",
  ".svg",
  ".ico",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".snap",
  ".pdf",
]);

/**
 * Trim trailing whitespace from staged files.
 * @param {string[]} files
 */
async function trimWhitespace(files) {
  for (const file of files) {
    const ext = file.slice(file.lastIndexOf(".")).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) continue;

    try {
      const content = await readFile(file, "utf-8");
      const trimmed = content
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n");
      if (content !== trimmed) {
        await writeFile(file, trimmed);
      }
    } catch {
      // Skip files that can't be read as text
    }
  }
}

/**
 * @filename: lint-staged.config.js
 * @type {import('lint-staged').Configuration}
 */
export default {
  "**/*": async (files) => {
    await trimWhitespace(files);
    return ["deno task fmt", "deno task lint"];
  },
};
