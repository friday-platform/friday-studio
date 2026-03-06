import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";

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
    const ext = extname(file).toLowerCase();
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
 * lint-staged config — runs fmt and lint on only the staged files.
 * @type {import('lint-staged').Configuration}
 */
export default {
  "**/*": async (files) => {
    await trimWhitespace(files);
    // Return empty — formatting/linting handled by the specific globs below
    return [];
  },
  "*.{ts,tsx,js,jsx,json,jsonc,css,md}": [
    "deno run -A npm:@biomejs/biome format --write --files-ignore-unknown=true --no-errors-on-unmatched",
    "deno run -A npm:@biomejs/biome check --write --files-ignore-unknown=true --no-errors-on-unmatched",
  ],
  "*.{ts,tsx,js,jsx}": (files) => {
    const filtered = files.filter((f) => !f.endsWith(".svelte.ts") && !f.endsWith(".svelte.js"));
    if (filtered.length === 0) return [];
    return [`deno lint --fix ${filtered.map((f) => `"${f}"`).join(" ")}`];
  },
  "apps/web-client/**/*.{ts,js,svelte,css,html,json}": "npx prettier --write --ignore-unknown",
  "apps/atlas-auth-ui/**/*.{ts,js,svelte,css,html,json}": "npx prettier --write --ignore-unknown",
};
