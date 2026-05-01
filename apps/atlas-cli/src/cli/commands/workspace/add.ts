import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { parseResult, client as v2Client } from "@atlas/client/v2";
import { exists } from "@atlas/utils/fs.server";
import { define } from "gunshi";

interface WorkspaceAddResult {
  path: string;
  success: boolean;
  id?: string;
  name?: string;
  error?: string;
}

export const addCommand = define({
  name: "add",
  description: "Add workspace(s) to Atlas registry",
  args: {
    path: {
      type: "string",
      short: "p",
      description: "Path to workspace directory or workspace.yml",
      required: true,
    },
    scan: { type: "string", short: "s", description: "Scan directory recursively for workspaces" },
    depth: { type: "number", description: "Maximum depth for --scan (default: 3)" },
    name: {
      type: "string",
      short: "n",
      description: "Override workspace name (single workspace only)",
    },
    description: { type: "string", short: "d", description: "Add workspace description" },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  rendering: { header: null },
  run: async (ctx) => {
    try {
      // Collect workspace paths
      const workspacePaths: string[] = [];
      const scanDir = ctx.values.scan;
      const pathArg = ctx.values.path;

      if (scanDir) {
        const scanPath = resolve(scanDir);
        if (!(await exists(scanPath))) {
          console.error(`Error: Directory not found: ${scanPath}`);
          process.exit(1);
        }

        const maxDepth = ctx.values.depth ?? 3;
        const scanDepth = scanPath.split("/").length;

        const entries = await readdir(scanPath, { recursive: true, withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const entryPath = join(entry.parentPath, entry.name);
          const depth = entryPath.split("/").length - scanDepth;
          if (depth > maxDepth) continue;

          const workspaceYml = join(entryPath, "workspace.yml");
          if (await exists(workspaceYml)) {
            workspacePaths.push(entryPath);
          }
        }

        if (workspacePaths.length === 0) {
          console.error(
            `Error: No workspaces found in ${scanPath} (searched up to depth ${maxDepth})`,
          );
          process.exit(1);
        }
      } else {
        if (!pathArg) {
          console.error("Error: --path is required. Usage: atlas workspace add -p <path>");
          process.exit(1);
        }

        for (const p of [pathArg]) {
          const resolvedPath = resolve(p);
          if (!(await exists(resolvedPath))) {
            console.error(`Error: Path not found: ${resolvedPath}`);
            process.exit(1);
          }

          const stats = await stat(resolvedPath);

          if (stats.isFile() && basename(resolvedPath) === "workspace.yml") {
            workspacePaths.push(dirname(resolvedPath));
          } else if (stats.isDirectory()) {
            const workspaceYml = join(resolvedPath, "workspace.yml");
            if (!(await exists(workspaceYml))) {
              console.error(`Error: workspace.yml not found in: ${resolvedPath}`);
              process.exit(1);
            }
            workspacePaths.push(resolvedPath);
          } else {
            console.error(
              `Error: Invalid path: ${resolvedPath} (must be a directory or workspace.yml)`,
            );
            process.exit(1);
          }
        }
      }

      // Register workspaces
      const results: WorkspaceAddResult[] = [];

      if (workspacePaths.length === 1 && (ctx.values.name ?? ctx.values.description)) {
        // Single workspace with custom metadata
        const request = {
          path: workspacePaths[0] ?? "",
          name: ctx.values.name,
          description: ctx.values.description,
        };

        const response = await parseResult(v2Client.workspace.add.$post({ json: request }));

        if (response.ok) {
          results.push({
            path: workspacePaths[0] ?? "",
            success: true,
            id: response.data.id,
            name: response.data.name,
          });
        } else {
          results.push({
            path: workspacePaths[0] ?? "",
            success: false,
            error: String(response.error),
          });
        }
      } else {
        // Batch add
        const response = await parseResult(
          v2Client.workspace["add-batch"].$post({ json: { paths: workspacePaths } }),
        );

        if (response.ok) {
          for (const w of response.data.added) {
            results.push({ path: w.path, success: true, id: w.id, name: w.name });
          }
          for (const f of response.data.failed) {
            results.push({ path: f.path, success: false, error: f.error });
          }
        } else {
          console.error(`Error: ${response.error}`);
          process.exit(1);
        }
      }

      // Output
      if (ctx.values.json) {
        console.log(
          JSON.stringify(
            {
              success: results.filter((r) => r.success).length,
              failed: results.filter((r) => !r.success).length,
              results,
            },
            null,
            2,
          ),
        );
        return;
      }

      const successCount = results.filter((r) => r.success).length;
      const failedCount = results.filter((r) => !r.success).length;

      if (successCount > 0 && failedCount === 0) {
        console.log(`Successfully added ${successCount} workspace${successCount !== 1 ? "s" : ""}`);
      } else if (successCount > 0 && failedCount > 0) {
        console.log(`Partially completed: ${successCount} succeeded, ${failedCount} failed`);
      } else {
        console.log(`Failed to add ${failedCount} workspace${failedCount !== 1 ? "s" : ""}`);
      }

      console.log("");
      for (const result of results) {
        if (result.success) {
          console.log(`  + ${result.name ?? basename(result.path)} (${result.id})`);
          console.log(`    Path: ${result.path}`);
        } else {
          console.log(`  x ${basename(result.path)}`);
          console.log(`    Error: ${result.error}`);
        }
      }

      if (failedCount > 0 && successCount === 0) {
        process.exit(1);
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  },
});
