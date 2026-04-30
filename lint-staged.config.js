import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";

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
  "*.{ts,tsx,js,jsx,json,jsonc,css,md}": (files) => {
    const active = files.filter((f) => !f.includes("/deprecated/"));
    if (active.length === 0) return [];
    const args = active.map((f) => `"${f}"`).join(" ");
    return [
      `deno run -A npm:@biomejs/biome format --write --files-ignore-unknown=true --no-errors-on-unmatched ${args}`,
      `deno run -A npm:@biomejs/biome check --write --files-ignore-unknown=true --no-errors-on-unmatched ${args}`,
    ];
  },
  "*.{ts,tsx,js,jsx}": (files) => {
    // Exclude files in directories that deno.json excludes from linting —
    // passing only excluded files causes `deno lint` to fail with "No target files found".
    const DENO_LINT_EXCLUDED = [
      "/apps/friday-website/src/",
      "/apps/atlas-auth-ui/src/",
      "/packages/ui/src/",
      "/tools/agent-playground/src/",
      "/tools/chat-replay/",
      "/deprecated/",
    ];
    const filtered = files.filter(
      (f) =>
        !f.endsWith(".svelte.ts") &&
        !f.endsWith(".svelte.js") &&
        !DENO_LINT_EXCLUDED.some((dir) => f.includes(dir)),
    );
    if (filtered.length === 0) return [];
    // deno lint treats parentheses and brackets in paths as glob chars — lint the directory instead
    const hasGlobChars = (f) => f.includes("(") || f.includes("[");
    const normal = filtered.filter((f) => !hasGlobChars(f));
    const parenDirs = [...new Set(filtered.filter((f) => hasGlobChars(f)).map((f) => dirname(f)))];
    const args = [...normal.map((f) => `"${f}"`), ...parenDirs.map((d) => `"${d}"`)];
    return [`deno lint --fix ${args.join(" ")}`];
  },
  "apps/web-client/**/*.{ts,js,svelte,css,html,json}": "npx prettier --write --ignore-unknown",
  "apps/atlas-auth-ui/**/*.{ts,js,svelte,css,html,json}": "npx prettier --write --ignore-unknown",
};
