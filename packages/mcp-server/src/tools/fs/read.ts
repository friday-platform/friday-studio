import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as path from "@std/path";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createSuccessResponse } from "../types.ts";

const MAX_READ_SIZE = 250 * 1024;
const DEFAULT_READ_LIMIT = 2000;
const MAX_LINE_LENGTH = 2000;

export function registerReadTool(server: McpServer, _ctx: ToolContext) {
  server.registerTool(
    "atlas_read",
    {
      description: `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to 2000 lines starting from the beginning of the file
- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters
- Any lines longer than 2000 characters will be truncated
- Results are returned using cat -n format, with line numbers starting at 1
- This tool allows the system to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually as the system is a multimodal LLM.
- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.
- You will regularly be asked to read screenshots. If the user provides a path to a screenshot ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths like /var/folders/123/abc/T/TemporaryItems/NSIRD_screencaptureui_ZfB1tD/Screenshot.png
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.`,
      inputSchema: {
        filePath: z.string().describe("The path to the file to read"),
        offset: z.number().optional().describe("The line number to start reading from (0-based)"),
        limit: z.number().optional().describe("The number of lines to read (defaults to 2000)"),
      },
    },
    async (params) => {
      let filePath = params.filePath;
      if (!path.isAbsolute(filePath)) {
        filePath = path.join(Deno.cwd(), filePath);
      }

      // Check file existence and get stats
      let stats: Deno.FileInfo;
      try {
        stats = await Deno.stat(filePath);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          const dir = path.dirname(filePath);
          const base = path.basename(filePath);

          try {
            const dirEntries: string[] = [];
            for await (const entry of Deno.readDir(dir)) {
              dirEntries.push(entry.name);
            }

            const suggestions = dirEntries
              .filter(
                (entry) =>
                  entry.toLowerCase().includes(base.toLowerCase()) ||
                  base.toLowerCase().includes(entry.toLowerCase()),
              )
              .map((entry) => path.join(dir, entry))
              .slice(0, 3);

            if (suggestions.length > 0) {
              throw new Error(
                `File not found: ${filePath}\n\nDid you mean one of these?\n${suggestions.join(
                  "\n",
                )}`,
              );
            }
          } catch {
            // Directory doesn't exist or can't be read, ignore suggestions
          }

          throw new Error(`File not found: ${filePath}`);
        }
        throw error;
      }

      if (stats.size > MAX_READ_SIZE) {
        throw new Error(
          `File is too large (${stats.size} bytes). Maximum size is ${MAX_READ_SIZE} bytes`,
        );
      }
      const limit = params.limit ?? DEFAULT_READ_LIMIT;
      const offset = params.offset || 0;
      const isImage = isImageFile(filePath);
      if (isImage) {
        throw new Error(
          `This is an image file of type: ${isImage}\nUse a different tool to process images`,
        );
      }
      const lines = await Deno.readTextFile(filePath).then((text) => text.split("\n"));
      const raw = lines.slice(offset, offset + limit).map((line) => {
        return line.length > MAX_LINE_LENGTH ? `${line.substring(0, MAX_LINE_LENGTH)}...` : line;
      });
      const content = raw.map((line, index) => {
        return `${(index + offset + 1).toString().padStart(5, "0")}| ${line}`;
      });
      const preview = raw.slice(0, 20).join("\n");

      let output = "<file>\n";
      output += content.join("\n");

      if (lines.length > offset + content.length) {
        output += `\n\n(File has more lines. Use 'offset' parameter to read beyond line ${
          offset + content.length
        })`;
      }
      output += "\n</file>";

      return createSuccessResponse({
        title: path.relative(Deno.cwd(), filePath),
        output,
        metadata: { preview },
      });
    },
  );
}

function isImageFile(filePath: string): string | false {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "JPEG";
    case ".png":
      return "PNG";
    case ".gif":
      return "GIF";
    case ".bmp":
      return "BMP";
    case ".svg":
      return "SVG";
    case ".webp":
      return "WebP";
    default:
      return false;
  }
}
