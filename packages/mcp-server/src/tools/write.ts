import { z } from "zod/v4";
import * as path from "path";
import type { ToolHandler } from "./types.ts";
import { createSuccessResponse } from "./types.ts";
import { LSP } from "../lsp";
import { Permission } from "../permission";
import DESCRIPTION from "./write.txt" with { type: "txt" };
import { Bus } from "../bus";
import { File } from "../file";
import { FileTime } from "../file/time";

const schema = z.object({
  filePath: z.string().describe(
    "The absolute path to the file to write (must be absolute, not relative)",
  ),
  content: z.string().describe("The content to write to the file"),
});

export const writeTool: ToolHandler<typeof schema> = {
  name: "write",
  description: DESCRIPTION,
  inputSchema: schema,
  handler: async (params, { logger }) => {
    const filepath = path.isAbsolute(params.filePath)
      ? params.filePath
      : path.join(Deno.cwd(), params.filePath);

    // Check file existence
    let exists: boolean;
    try {
      await Deno.stat(filepath);
      exists = true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        exists = false;
      } else {
        throw error;
      }
    }

    // TODO: sessionID needs to be passed in context or retrieved differently
    const sessionID = "default"; // Temporary placeholder

    if (exists) await FileTime.assert(sessionID, filepath);

    await Permission.ask({
      id: "write",
      sessionID,
      title: exists ? "Overwrite this file: " + filepath : "Create new file: " + filepath,
      metadata: {
        filePath: filepath,
        content: params.content,
        exists,
      },
    });

    await Deno.writeTextFile(filepath, params.content);
    await Bus.publish(File.Event.Edited, {
      file: filepath,
    });
    FileTime.read(sessionID, filepath);

    let output = "";
    await LSP.touchFile(filepath, true);
    const diagnostics = await LSP.diagnostics();
    for (const [file, issues] of Object.entries(diagnostics)) {
      if (issues.length === 0) continue;
      if (file === filepath) {
        output += `\nThis file has errors, please fix\n<file_diagnostics>\n${
          issues.map(LSP.Diagnostic.pretty).join("\n")
        }\n</file_diagnostics>\n`;
        continue;
      }
      output += `\n<project_diagnostics>\n${file}\n${
        issues.map(LSP.Diagnostic.pretty).join("\n")
      }\n</project_diagnostics>\n`;
    }

    return createSuccessResponse({
      title: path.relative(Deno.cwd(), filepath),
      metadata: {
        diagnostics,
        filepath,
        exists: exists,
      },
      output,
    });
  },
};
