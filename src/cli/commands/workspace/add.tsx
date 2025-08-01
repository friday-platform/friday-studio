import { AtlasClient, WorkspaceAddRequest, WorkspaceBatchAddRequest } from "@atlas/client";
import { Spinner } from "@inkjs/ui";
import { exists, walk } from "@std/fs";
import { basename, dirname, join, resolve } from "@std/path";
import { Box, render, Text } from "ink";
import { useEffect, useState } from "react";
import { YargsInstance } from "../../utils/yargs.ts";

interface AddArgs {
  paths?: string[];
  scan?: string;
  depth?: number;
  name?: string;
  description?: string;
  json?: boolean;
}

export const command = "add [paths..]";
export const desc = "Add existing workspace(s) to Atlas registry";
export const aliases = ["register"];

export function builder(y: YargsInstance) {
  return y
    .positional("paths", {
      type: "string",
      array: true,
      describe: "Path(s) to workspace directories or workspace.yml files",
    })
    .option("scan", {
      type: "string",
      describe: "Scan directory recursively for workspaces",
    })
    .option("depth", {
      type: "number",
      describe: "Maximum depth for --scan",
      default: 3,
    })
    .option("name", {
      type: "string",
      describe: "Override workspace name (single workspace only)",
    })
    .option("description", {
      type: "string",
      describe: "Add workspace description (single workspace only)",
    })
    .option("json", {
      type: "boolean",
      describe: "Output results as JSON",
      default: false,
    })
    .check((argv) => {
      // Validate depth
      if (argv.depth && (argv.depth < 1 || argv.depth > 10)) {
        throw new Error("Depth must be between 1 and 10");
      }

      // Ensure either paths or scan is provided
      if (!argv.paths?.length && !argv.scan) {
        throw new Error("Either provide path(s) or use --scan option");
      }

      // Ensure name/description only used for single workspace
      if ((argv.name || argv.description) && (argv.scan || (argv.paths && argv.paths.length > 1))) {
        throw new Error("--name and --description can only be used when adding a single workspace");
      }

      return true;
    })
    .example("$0 workspace add ~/my-workspace", "Add a single workspace")
    .example("$0 workspace add ~/proj1 ~/proj2", "Add multiple workspaces")
    .example("$0 workspace add ~/my-workspace/workspace.yml", "Add using workspace.yml path")
    .example("$0 workspace add --scan ~/projects", "Scan directory for workspaces")
    .example("$0 workspace add ~/work --name my-work", "Add with custom name")
    .help()
    .alias("help", "h");
}

interface WorkspaceAddResult {
  path: string;
  success: boolean;
  id?: string;
  name?: string;
  error?: string;
}

const WorkspaceAddUI = ({
  args,
  onComplete,
}: {
  args: AddArgs;
  onComplete: () => void;
}) => {
  const [status, setStatus] = useState("initializing");
  const [results, setResults] = useState<WorkspaceAddResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [workspacePaths, setWorkspacePaths] = useState<string[]>([]);
  const [processing, setProcessing] = useState(false);

  // Collect workspace paths
  useEffect(() => {
    const collectPaths = async () => {
      try {
        const paths: string[] = [];

        if (args.scan) {
          // Scan directory for workspaces
          const scanPath = resolve(args.scan);
          if (!await exists(scanPath)) {
            throw new Error(`Directory not found: ${scanPath}`);
          }

          const maxDepth = args.depth || 3;

          for await (
            const entry of walk(scanPath, { maxDepth, includeDirs: true, includeFiles: false })
          ) {
            const depth = entry.path.split("/").length - scanPath.split("/").length;
            if (depth > maxDepth) continue;

            const workspaceYml = join(entry.path, "workspace.yml");
            if (await exists(workspaceYml)) {
              paths.push(entry.path);
            }
          }

          if (paths.length === 0) {
            throw new Error(
              `No workspaces found in ${scanPath} (searched up to depth ${maxDepth})`,
            );
          }
        } else if (args.paths) {
          // Use provided paths
          for (const path of args.paths) {
            const resolvedPath = resolve(path);
            if (!await exists(resolvedPath)) {
              throw new Error(`Path not found: ${resolvedPath}`);
            }

            const stats = await Deno.stat(resolvedPath);

            if (stats.isFile && basename(resolvedPath) === "workspace.yml") {
              // If the path is a workspace.yml file, use its parent directory
              const workspaceDir = dirname(resolvedPath);
              paths.push(workspaceDir);
            } else if (stats.isDirectory) {
              // If it's a directory, check for workspace.yml inside
              const workspaceYml = join(resolvedPath, "workspace.yml");
              if (!await exists(workspaceYml)) {
                throw new Error(`workspace.yml not found in: ${resolvedPath}`);
              }
              paths.push(resolvedPath);
            } else {
              throw new Error(
                `Invalid path: ${resolvedPath} (must be a directory or workspace.yml file)`,
              );
            }
          }
        }

        setWorkspacePaths(paths);
        setStatus("ready");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    };

    collectPaths();
  }, []);

  // Process workspaces
  useEffect(() => {
    if (status !== "ready" || processing) return;

    const processWorkspaces = async () => {
      setProcessing(true);
      setStatus("processing");

      try {
        const client = new AtlasClient();

        if (workspacePaths.length === 1 && (args.name || args.description)) {
          // Single workspace with custom metadata
          const request: WorkspaceAddRequest = {
            path: workspacePaths[0],
            name: args.name,
            description: args.description,
          };

          try {
            const workspace = await client.addWorkspace(request);
            setResults([{
              path: workspacePaths[0],
              success: true,
              id: workspace.id,
              name: workspace.name,
            }]);
          } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            setResults([{
              path: workspacePaths[0],
              success: false,
              error: errorMessage,
            }]);
          }
        } else {
          // Batch add
          const request: WorkspaceBatchAddRequest = {
            paths: workspacePaths,
          };

          const response = await client.addWorkspaces(request);

          const allResults: WorkspaceAddResult[] = [
            ...response.added.map((w) => ({
              path: w.path,
              success: true,
              id: w.id,
              name: w.name,
            })),
            ...response.failed.map((f) => ({
              path: f.path,
              success: false,
              error: f.error,
            })),
          ];

          setResults(allResults);
        }

        setStatus("complete");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    };

    processWorkspaces();
  }, [status, processing]);

  // Handle completion
  useEffect(() => {
    if (status === "complete" || status === "error") {
      onComplete();
    }
  }, [status]);

  if (args.json) {
    // Output JSON for scripting
    if (status === "complete") {
      console.log(JSON.stringify(
        {
          success: results.filter((r) => r.success).length,
          failed: results.filter((r) => !r.success).length,
          results: results,
        },
        null,
        2,
      ));
    } else if (status === "error") {
      console.log(JSON.stringify(
        {
          error: error,
        },
        null,
        2,
      ));
    }
    return null;
  }

  // Interactive UI
  if (status === "initializing") {
    return (
      <Box flexDirection="column" gap={1}>
        <Spinner label="Discovering workspaces..." />
      </Box>
    );
  }

  if (status === "processing") {
    return (
      <Box flexDirection="column" gap={1}>
        <Box>
          <Text color="cyan">
            Adding {workspacePaths.length} workspace{workspacePaths.length !== 1 ? "s" : ""}...
          </Text>
        </Box>
        <Box marginTop={1}>
          <Spinner label="Registering with Atlas daemon" />
        </Box>
        {workspacePaths.map((path, i) => (
          <Box key={i} marginLeft={2}>
            <Text dimColor>• {path}</Text>
          </Box>
        ))}
      </Box>
    );
  }

  if (status === "error") {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  if (status === "complete") {
    const successCount = results.filter((r) => r.success).length;
    const failedCount = results.filter((r) => !r.success).length;

    return (
      <Box flexDirection="column" gap={1}>
        {/* Summary header */}
        <Box marginBottom={1}>
          <Text bold>
            {successCount > 0 && failedCount === 0 && (
              <Text color="green">
                ✓ Successfully added {successCount} workspace{successCount !== 1 ? "s" : ""}{" "}
                to Atlas
              </Text>
            )}
            {successCount > 0 && failedCount > 0 && (
              <>
                <Text color="yellow">
                  ⚠ Partially completed: {successCount} succeeded, {failedCount} failed
                </Text>
              </>
            )}
            {successCount === 0 && failedCount > 0 && (
              <Text color="red">
                ✗ Failed to add {failedCount} workspace{failedCount !== 1 ? "s" : ""}
              </Text>
            )}
          </Text>
        </Box>

        {/* Detailed results */}
        <Box flexDirection="column">
          <Text bold dimColor>Registration Details:</Text>
        </Box>

        {results.map((result, i) => (
          <Box key={i} flexDirection="column" marginLeft={2}>
            {result.success
              ? (
                <Box>
                  <Text color="green">{`✓ `}</Text>
                  <Text bold>{result.name || basename(result.path)}</Text>
                  <Text dimColor>{` (${result.id})`}</Text>
                </Box>
              )
              : (
                <Box flexDirection="column">
                  <Box>
                    <Text color="red">✗</Text>
                    <Text>{basename(result.path)}</Text>
                  </Box>
                  <Box marginLeft={2}>
                    <Text dimColor>→ {result.error}</Text>
                  </Box>
                </Box>
              )}
            <Box marginLeft={2}>
              <Text dimColor>Path: {result.path}</Text>
            </Box>
          </Box>
        ))}

        {successCount > 0 && (
          <Box marginTop={1} flexDirection="column">
            <Text bold color="cyan">Next steps:</Text>
            <Box marginLeft={2}>
              <Text>
                • Run <Text color="cyan">atlas workspace list</Text> to see all workspaces
              </Text>
            </Box>
            <Box marginLeft={2}>
              <Text>
                • Run <Text color="cyan">atlas</Text> to open the interactive interface
              </Text>
            </Box>
          </Box>
        )}
      </Box>
    );
  }

  return null;
};

export async function handler(argv: AddArgs): Promise<void> {
  const { waitUntilExit } = render(
    <WorkspaceAddUI
      args={argv}
      onComplete={() => {
        // For non-JSON output, exit after a short delay to ensure render completes
        if (!argv.json) {
          setTimeout(() => Deno.exit(0), 100);
        }
      }}
    />,
  );

  if (argv.json) {
    await waitUntilExit();
  }
}
