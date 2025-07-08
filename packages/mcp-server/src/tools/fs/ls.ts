import { z } from "zod/v4";
import type { ToolHandler } from "../types.ts";
import { createSuccessResponse } from "../types.ts";
import * as path from "@std/path";
import { expandGlob } from "@std/fs";
import DESCRIPTION from "./ls.txt" with { type: "text" };

export const IGNORE_PATTERNS = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
];

const LIMIT = 100;

const schema = z.object({
  path: z.string().optional().meta({
    description: "The path to the directory to list (can be absolute or relative)",
  }),
  ignore: z.array(z.string()).optional().meta({
    description: "List of glob patterns to ignore",
  }),
});

export const lsTool: ToolHandler<typeof schema> = {
  name: "list",
  description: DESCRIPTION,
  inputSchema: schema,
  handler: async (params) => {
    const searchPath = path.resolve(Deno.cwd(), params.path || ".");

    const files = [];

    // Directory scanning with glob pattern
    for await (
      const entry of expandGlob("**/*", {
        root: searchPath,
        includeDirs: true,
        globstar: true,
      })
    ) {
      // Get relative path from search path
      const file = path.relative(searchPath, entry.path);

      if (IGNORE_PATTERNS.some((p) => file.includes(p))) continue;

      // Check against ignore patterns using globToRegExp
      if (
        params.ignore?.some((pattern) => {
          const regexp = path.globToRegExp(pattern);
          return regexp.test(file);
        })
      ) continue;

      files.push(file);
      if (files.length >= LIMIT) break;
    }

    // Build directory structure
    const dirs = new Set<string>();
    const filesByDir = new Map<string, string[]>();

    for (const file of files) {
      const dir = path.dirname(file);
      const parts = dir === "." ? [] : dir.split("/");

      // Add all parent directories
      for (let i = 0; i <= parts.length; i++) {
        const dirPath = i === 0 ? "." : parts.slice(0, i).join("/");
        dirs.add(dirPath);
      }

      // Add file to its directory
      if (!filesByDir.has(dir)) filesByDir.set(dir, []);
      filesByDir.get(dir)!.push(path.basename(file));
    }

    function renderDir(dirPath: string, depth: number): string {
      const indent = "  ".repeat(depth);
      let output = "";

      if (depth > 0) {
        output += `${indent}${path.basename(dirPath)}/\n`;
      }

      const childIndent = "  ".repeat(depth + 1);
      const children = Array.from(dirs)
        .filter((d) => path.dirname(d) === dirPath && d !== dirPath)
        .sort();

      // Render subdirectories first
      for (const child of children) {
        output += renderDir(child, depth + 1);
      }

      // Render files
      const files = filesByDir.get(dirPath) || [];
      for (const file of files.sort()) {
        output += `${childIndent}${file}\n`;
      }

      return output;
    }

    const output = `${searchPath}/\n` + renderDir(".", 0);

    return createSuccessResponse({
      title: path.relative(Deno.cwd(), searchPath),
      metadata: {
        count: files.length,
        truncated: files.length >= LIMIT,
      },
      output,
    });
  },
};
